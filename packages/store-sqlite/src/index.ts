import { EventEmitter } from "node:events";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { BoardEvent, EventQuery, NewEvent, Store, Task, TaskQuery } from "@trevize-dev/openboard-core";

export interface SqliteStoreOptions {
  /** Milliseconds to wait for a lock held by another process. Default 5000. */
  busyTimeoutMs?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  board   TEXT    NOT NULL,
  seq     INTEGER NOT NULL,
  channel TEXT    NOT NULL,
  thread  TEXT    NOT NULL,
  doc     TEXT    NOT NULL,
  PRIMARY KEY (board, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS events_by_thread  ON events (board, thread, seq);
CREATE INDEX IF NOT EXISTS events_by_channel ON events (board, channel, seq);

CREATE TABLE IF NOT EXISTS tasks (
  board       TEXT    NOT NULL,
  id          TEXT    NOT NULL,
  status      TEXT    NOT NULL,
  channel     TEXT    NOT NULL,
  priority    INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  lease_until INTEGER,
  version     INTEGER NOT NULL,
  labels      TEXT    NOT NULL,
  doc         TEXT    NOT NULL,
  PRIMARY KEY (board, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS tasks_by_order ON tasks (board, status, priority DESC, created_at, id);

CREATE TABLE IF NOT EXISTS docs (
  board TEXT NOT NULL,
  key   TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (board, key)
) WITHOUT ROWID;
`;

/**
 * SQLite Store. Safe to share one database file between processes: seq assignment and
 * compare-and-set are single statements, which SQLite serializes under its write lock.
 * `subscribe` only sees appends made in this process; other processes are picked up by
 * the core's polling.
 */
export class SqliteStore implements Store {
  readonly name = "sqlite";
  readonly capabilities = { notify: true, transactions: true };
  readonly db: DatabaseSync;
  private emitter = new EventEmitter().setMaxListeners(0);

  constructor(path: string = ":memory:", options: SqliteStoreOptions = {}) {
    const busyMs = Math.trunc(options.busyTimeoutMs ?? 5000);
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = ${busyMs};`);
    // Switching journal mode and creating tables can hit SQLITE_BUSY without consulting the
    // busy handler when several processes open the same file at once, so retry explicitly.
    retryBusy(busyMs, () => {
      if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      this.db.exec(`BEGIN IMMEDIATE; ${SCHEMA} COMMIT;`);
    }, () => {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
    });
  }

  async append(board: string, event: NewEvent): Promise<BoardEvent> {
    const row = this.db
      .prepare(
        `INSERT INTO events (board, seq, channel, thread, doc)
         SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ? FROM events WHERE board = ?
         RETURNING seq`,
      )
      .get(board, event.channel, event.thread, JSON.stringify(event), board) as { seq: number };
    const seq = Number(row.seq);
    this.emitter.emit(board, seq);
    return { ...event, board, seq };
  }

  async readEvents(board: string, query: EventQuery = {}): Promise<BoardEvent[]> {
    const where = ["board = ?", "seq > ?"];
    const params: SQLInputValue[] = [board, query.after ?? 0];
    if (query.channel !== undefined) {
      where.push("channel = ?");
      params.push(query.channel);
    }
    if (query.thread !== undefined) {
      where.push("thread = ?");
      params.push(query.thread);
    }
    params.push(query.limit ?? 100);
    const rows = this.db
      .prepare(`SELECT seq, doc FROM events WHERE ${where.join(" AND ")} ORDER BY seq LIMIT ?`)
      .all(...params) as { seq: number; doc: string }[];
    return rows.map((r) => ({ ...(JSON.parse(r.doc) as NewEvent), board, seq: Number(r.seq) }));
  }

  async head(board: string): Promise<number> {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS head FROM events WHERE board = ?").get(board) as {
      head: number;
    };
    return Number(row.head);
  }

  async insertTask(task: Task): Promise<boolean> {
    const res = this.db
      .prepare(
        `INSERT INTO tasks (board, id, status, channel, priority, created_at, lease_until, version, labels, doc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(...taskColumns(task));
    return res.changes === 1;
  }

  async getTask(board: string, id: string): Promise<Task | null> {
    const row = this.db.prepare("SELECT doc FROM tasks WHERE board = ? AND id = ?").get(board, id) as
      | { doc: string }
      | undefined;
    return row ? (JSON.parse(row.doc) as Task) : null;
  }

  async getTasks(board: string, ids: string[]): Promise<Task[]> {
    if (!ids.length) return [];
    const rows = this.db
      .prepare("SELECT doc FROM tasks WHERE board = ? AND id IN (SELECT value FROM json_each(?))")
      .all(board, JSON.stringify(ids)) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as Task);
  }

  async findTasks(board: string, query: TaskQuery = {}): Promise<Task[]> {
    const where = ["board = ?"];
    const params: SQLInputValue[] = [board];
    if (query.claimableAt !== undefined) {
      where.push("(status = 'open' OR (status = 'claimed' AND COALESCE(lease_until, 0) < ?))");
      params.push(query.claimableAt);
    } else if (query.status?.length) {
      where.push(`status IN (${query.status.map(() => "?").join(", ")})`);
      params.push(...query.status);
    }
    if (query.channel !== undefined) {
      where.push("channel = ?");
      params.push(query.channel);
    }
    for (const [k, v] of Object.entries(query.labels ?? {})) {
      where.push("json_extract(labels, ?) = ?");
      params.push(`$."${k.replace(/"/g, "")}"`, v);
    }
    params.push(query.limit ?? 100);
    const rows = this.db
      .prepare(
        `SELECT doc FROM tasks WHERE ${where.join(" AND ")}
         ORDER BY priority DESC, created_at ASC, id ASC LIMIT ?`,
      )
      .all(...params) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as Task);
  }

  async casTask(next: Task, expectVersion: number): Promise<boolean> {
    if (next.version !== expectVersion + 1) return false;
    const rest = taskColumns(next).slice(2);
    const res = this.db
      .prepare(
        `UPDATE tasks SET status = ?, channel = ?, priority = ?, created_at = ?, lease_until = ?,
                          version = ?, labels = ?, doc = ?
         WHERE board = ? AND id = ? AND version = ?`,
      )
      .run(...rest, next.board, next.id, expectVersion);
    return res.changes === 1;
  }

  async putDocIfAbsent(board: string, key: string, value: unknown): Promise<boolean> {
    const res = this.db
      .prepare("INSERT INTO docs (board, key, value) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
      .run(board, key, JSON.stringify(value));
    return res.changes === 1;
  }

  async getDoc(board: string, key: string): Promise<unknown | null> {
    const row = this.db.prepare("SELECT value FROM docs WHERE board = ? AND key = ?").get(board, key) as
      | { value: string }
      | undefined;
    return row ? JSON.parse(row.value) : null;
  }

  subscribe(board: string, onAppend: (seq: number) => void): () => void {
    this.emitter.on(board, onAppend);
    return () => this.emitter.off(board, onAppend);
  }

  async close(): Promise<void> {
    if (this.db.isOpen) this.db.close();
  }
}

function retryBusy(budgetMs: number, fn: () => void, onError: () => void) {
  const deadline = Date.now() + budgetMs;
  for (let delay = 5; ; delay = Math.min(delay * 2, 200)) {
    try {
      return fn();
    } catch (err) {
      onError();
      const busy = /database is locked|SQLITE_BUSY/i.test((err as Error).message);
      if (!busy || Date.now() + delay > deadline) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
}

function taskColumns(t: Task): SQLInputValue[] {
  return [
    t.board,
    t.id,
    t.status,
    t.channel,
    t.priority,
    t.createdAt,
    t.leaseUntil ?? null,
    t.version,
    JSON.stringify(t.labels),
    JSON.stringify(t),
  ];
}
