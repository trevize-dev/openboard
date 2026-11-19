import { BoardError } from "./errors.js";
import { isLabelKey, isName, isSchemaId, newId } from "./ids.js";
import { compileSchema, jsonEqual, validateAgainst, type SchemaRecord } from "./schemas.js";
import type {
  BoardEvent,
  EventQuery,
  EventType,
  Labels,
  NewEvent,
  Store,
  Task,
  TaskQuery,
  TaskStatus,
} from "./types.js";

export interface OpenboardOptions {
  /** Clock in epoch ms. Injectable for tests. */
  clock?: () => number;
  /** How often waiters re-check when the store can't notify, and to catch lease expiry. Default 1000ms. */
  pollIntervalMs?: number;
  /** Lease used when a claim doesn't give one. Default 5 minutes. */
  defaultLeaseMs?: number;
  /** Upper bound for any lease. Default 24 hours. */
  maxLeaseMs?: number;
  /** How many claimable tasks one claim attempt scans. Default 200. */
  claimScanLimit?: number;
}

export interface PostInput {
  channel: string;
  body?: string;
  data?: unknown;
  schema?: string;
  /** Reply in an existing thread. Omit to start a new thread. */
  thread?: string;
  labels?: Labels;
}

export interface CreateTaskInput {
  channel: string;
  title: string;
  body?: string;
  labels?: Labels;
  blockedBy?: string[];
  priority?: number;
  /** Attach the task to an existing thread. Defaults to a new thread named after the task id. */
  thread?: string;
  /** Use a caller-chosen id (idempotent create). */
  id?: string;
}

export interface ClaimInput {
  channel?: string;
  labels?: Labels;
  leaseMs?: number;
  /** Keep trying for up to this long when nothing is claimable. Default 0. */
  waitMs?: number;
  signal?: AbortSignal;
}

export interface FailInput {
  reason?: string;
  /** Put the task back to open for another attempt instead of marking it failed. */
  retry?: boolean;
}

const TERMINAL: TaskStatus[] = ["done", "failed", "cancelled"];
const SYSTEM_CHANNEL = "system";

/** Entry point: one Openboard per store, any number of boards. */
export class Openboard {
  readonly store: Store;
  readonly clock: () => number;
  readonly pollIntervalMs: number;
  readonly defaultLeaseMs: number;
  readonly maxLeaseMs: number;
  readonly claimScanLimit: number;

  constructor(store: Store, options: OpenboardOptions = {}) {
    this.store = store;
    this.clock = options.clock ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.defaultLeaseMs = options.defaultLeaseMs ?? 5 * 60_000;
    this.maxLeaseMs = options.maxLeaseMs ?? 24 * 3_600_000;
    this.claimScanLimit = options.claimScanLimit ?? 200;
  }

  board(id: string): Board {
    if (!isName(id)) throw new BoardError("invalid_argument", `invalid board name "${id}"`);
    return new Board(this, id);
  }
}

export class Board {
  readonly id: string;
  private readonly ob: Openboard;

  constructor(ob: Openboard, id: string) {
    this.ob = ob;
    this.id = id;
  }

  private get store() {
    return this.ob.store;
  }
  private now() {
    return this.ob.clock();
  }

  // ---------------------------------------------------------------- messages

  async post(actor: string, input: PostInput): Promise<BoardEvent> {
    checkActor(actor);
    checkChannel(input.channel);
    if (input.body === undefined && input.data === undefined) {
      throw new BoardError("invalid_argument", "a message needs a body or data");
    }
    if (input.body !== undefined && typeof input.body !== "string") {
      throw new BoardError("invalid_argument", "body must be a string");
    }
    if (input.thread !== undefined && !isThreadId(input.thread)) {
      throw new BoardError("invalid_argument", `invalid thread id "${input.thread}"`);
    }
    checkLabels(input.labels);
    if (input.schema !== undefined) {
      const record = await this.requireSchema(input.schema);
      validateAgainst(record, input.data);
    }
    const id = newId("evt");
    return this.emit({
      id,
      type: "message",
      channel: input.channel,
      thread: input.thread ?? id,
      actor,
      at: this.now(),
      body: input.body,
      data: input.data,
      schema: input.schema,
      labels: input.labels,
    });
  }

  events(query: EventQuery = {}): Promise<BoardEvent[]> {
    return this.store.readEvents(this.id, normalizeEventQuery(query));
  }

  /**
   * Like `events`, but when nothing matches yet, wait up to `waitMs` for new events (long-poll).
   */
  async waitForEvents(query: EventQuery, waitMs: number, signal?: AbortSignal): Promise<BoardEvent[]> {
    const q = normalizeEventQuery(query);
    const deadline = this.now() + Math.max(0, waitMs);
    for (;;) {
      const events = await this.store.readEvents(this.id, q);
      if (events.length || signal?.aborted) return events;
      const remaining = deadline - this.now();
      if (remaining <= 0) return events;
      await this.wake(remaining, signal);
    }
  }

  /** Async iterator over new events, forever (or until the signal aborts). */
  async *follow(query: EventQuery = {}, signal?: AbortSignal): AsyncGenerator<BoardEvent> {
    let after = query.after ?? (await this.store.head(this.id));
    while (!signal?.aborted) {
      const batch = await this.waitForEvents({ ...query, after }, 30_000, signal);
      for (const ev of batch) {
        after = ev.seq;
        yield ev;
      }
    }
  }

  head(): Promise<number> {
    return this.store.head(this.id);
  }

  // ---------------------------------------------------------------- tasks

  async createTask(actor: string, input: CreateTaskInput): Promise<Task> {
    checkActor(actor);
    checkChannel(input.channel);
    if (typeof input.title !== "string" || !input.title.trim()) {
      throw new BoardError("invalid_argument", "a task needs a title");
    }
    checkLabels(input.labels);
    const priority = input.priority ?? 0;
    if (!Number.isInteger(priority)) throw new BoardError("invalid_argument", "priority must be an integer");
    const blockedBy = [...new Set(input.blockedBy ?? [])];
    if (blockedBy.length) {
      const deps = await this.store.getTasks(this.id, blockedBy);
      const found = new Set(deps.map((d) => d.id));
      const missing = blockedBy.filter((d) => !found.has(d));
      if (missing.length) throw new BoardError("invalid_argument", `unknown blockedBy tasks: ${missing.join(", ")}`);
    }
    if (input.id !== undefined && !isThreadId(input.id)) {
      throw new BoardError("invalid_argument", `invalid task id "${input.id}"`);
    }

    const now = this.now();
    const id = input.id ?? newId("tsk");
    const task: Task = {
      id,
      board: this.id,
      channel: input.channel,
      thread: input.thread ?? id,
      title: input.title,
      body: input.body,
      status: "open",
      labels: input.labels ?? {},
      blockedBy,
      priority,
      attempt: 0,
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    if (!(await this.store.insertTask(task))) {
      const existing = await this.store.getTask(this.id, id);
      if (existing && existing.title === task.title && existing.channel === task.channel) return existing;
      throw new BoardError("conflict", `task ${id} already exists`);
    }
    await this.emitTask("task.created", actor, task, { body: task.title, labels: task.labels });
    return task;
  }

  async getTask(id: string): Promise<Task> {
    const t = await this.store.getTask(this.id, id);
    if (!t) throw new BoardError("not_found", `task ${id} not found`);
    return t;
  }

  async tasks(query: TaskQuery & { ready?: boolean } = {}): Promise<Task[]> {
    checkLabels(query.labels);
    const { ready, ...rest } = query;
    const q: TaskQuery = { ...rest, limit: clampLimit(rest.limit) };
    if (ready) q.claimableAt = this.now();
    const tasks = await this.store.findTasks(this.id, q);
    return ready ? this.filterUnblocked(tasks) : tasks;
  }

  /**
   * Atomically claim the best claimable task: open (or claimed with an expired lease),
   * matching the filters, with every blockedBy task done. Returns null if none within waitMs.
   */
  async claim(actor: string, input: ClaimInput = {}): Promise<Task | null> {
    checkActor(actor);
    if (input.channel !== undefined) checkChannel(input.channel);
    checkLabels(input.labels);
    const leaseMs = this.leaseMs(input.leaseMs);
    const deadline = this.now() + Math.max(0, input.waitMs ?? 0);

    for (;;) {
      const now = this.now();
      const candidates = await this.store.findTasks(this.id, {
        claimableAt: now,
        channel: input.channel,
        labels: input.labels,
        limit: this.ob.claimScanLimit,
      });
      for (const c of await this.filterUnblocked(candidates)) {
        const reclaim = c.status === "claimed";
        const next: Task = {
          ...c,
          status: "claimed",
          owner: actor,
          leaseUntil: now + leaseMs,
          attempt: c.attempt + 1,
          error: undefined,
          updatedAt: now,
          version: c.version + 1,
        };
        if (await this.store.casTask(next, c.version)) {
          await this.emitTask("task.claimed", actor, next, {
            data: { attempt: next.attempt, leaseUntil: next.leaseUntil, ...(reclaim ? { reclaimedFrom: c.owner } : {}) },
          });
          return next;
        }
        // Lost the race for this one; try the next candidate.
      }
      if (input.signal?.aborted) return null;
      const remaining = deadline - this.now();
      if (remaining <= 0) return null;
      await this.wake(remaining, input.signal);
    }
  }

  renew(actor: string, taskId: string, leaseMs?: number): Promise<Task> {
    const ms = this.leaseMs(leaseMs);
    return this.transition(actor, taskId, "task.renewed", requireOwner, (t, now) => ({
      ...t,
      leaseUntil: now + ms,
    }));
  }

  complete(actor: string, taskId: string, result?: unknown): Promise<Task> {
    return this.transition(
      actor,
      taskId,
      "task.completed",
      requireOwner,
      (t) => ({ ...t, status: "done", leaseUntil: undefined, result }),
      result === undefined ? {} : { data: { result } },
    );
  }

  fail(actor: string, taskId: string, input: FailInput = {}): Promise<Task> {
    const reason = input.reason;
    if (input.retry) {
      return this.transition(
        actor,
        taskId,
        "task.released",
        requireOwner,
        (t) => ({ ...t, status: "open", owner: undefined, leaseUntil: undefined, error: reason }),
        { body: reason },
      );
    }
    return this.transition(
      actor,
      taskId,
      "task.failed",
      requireOwner,
      (t) => ({ ...t, status: "failed", leaseUntil: undefined, error: reason }),
      { body: reason },
    );
  }

  release(actor: string, taskId: string): Promise<Task> {
    return this.transition(actor, taskId, "task.released", requireOwner, (t) => ({
      ...t,
      status: "open",
      owner: undefined,
      leaseUntil: undefined,
    }));
  }

  cancel(actor: string, taskId: string, reason?: string): Promise<Task> {
    return this.transition(
      actor,
      taskId,
      "task.cancelled",
      (t) => {
        if (TERMINAL.includes(t.status)) throw new BoardError("conflict", `task ${t.id} is already ${t.status}`);
      },
      (t) => ({ ...t, status: "cancelled", leaseUntil: undefined, error: reason }),
      { body: reason },
    );
  }

  // ---------------------------------------------------------------- schemas

  async registerSchema(actor: string, id: string, schema: unknown): Promise<SchemaRecord> {
    checkActor(actor);
    if (!isSchemaId(id)) {
      throw new BoardError("invalid_argument", `invalid schema id "${id}" (use name@version, e.g. finding@1)`);
    }
    compileSchema(schema);
    const record: SchemaRecord = { id, schema: schema as SchemaRecord["schema"], createdBy: actor, createdAt: this.now() };
    if (!(await this.store.putDocIfAbsent(this.id, schemaKey(id), record))) {
      const existing = (await this.store.getDoc(this.id, schemaKey(id))) as SchemaRecord;
      if (jsonEqual(existing.schema, schema)) return existing;
      throw new BoardError("conflict", `schema ${id} already exists with different content; publish a new version`);
    }
    await this.emit({
      id: newId("evt"),
      type: "schema.registered",
      channel: SYSTEM_CHANNEL,
      thread: schemaKey(id),
      actor,
      at: record.createdAt,
      body: id,
    });
    return record;
  }

  async getSchema(id: string): Promise<SchemaRecord> {
    return this.requireSchema(id);
  }

  // ---------------------------------------------------------------- internals

  private async requireSchema(id: string): Promise<SchemaRecord> {
    if (!isSchemaId(id)) throw new BoardError("invalid_argument", `invalid schema id "${id}"`);
    const rec = (await this.store.getDoc(this.id, schemaKey(id))) as SchemaRecord | null;
    if (!rec) throw new BoardError("not_found", `schema ${id} is not registered on board ${this.id}`);
    return rec;
  }

  private leaseMs(ms?: number): number {
    const v = ms ?? this.ob.defaultLeaseMs;
    if (!Number.isFinite(v) || v <= 0) throw new BoardError("invalid_argument", "lease must be positive");
    return Math.min(v, this.ob.maxLeaseMs);
  }

  private async filterUnblocked(tasks: Task[]): Promise<Task[]> {
    const depIds = [...new Set(tasks.flatMap((t) => t.blockedBy))];
    if (!depIds.length) return tasks;
    const done = new Set((await this.store.getTasks(this.id, depIds)).filter((d) => d.status === "done").map((d) => d.id));
    return tasks.filter((t) => t.blockedBy.every((d) => done.has(d)));
  }

  /** Read-check-CAS loop for single-task state changes. */
  private async transition(
    actor: string,
    taskId: string,
    type: EventType,
    check: (t: Task, actor: string, now: number) => void,
    mutate: (t: Task, now: number) => Task,
    extra: Partial<NewEvent> = {},
  ): Promise<Task> {
    checkActor(actor);
    for (let attempt = 0; attempt < 5; attempt++) {
      const cur = await this.getTask(taskId);
      const now = this.now();
      check(cur, actor, now);
      const next = { ...mutate(cur, now), updatedAt: now, version: cur.version + 1 };
      if (await this.store.casTask(next, cur.version)) {
        await this.emitTask(type, actor, next, extra);
        return next;
      }
    }
    throw new BoardError("conflict", `task ${taskId} is changing too fast; retry`);
  }

  private emitTask(type: EventType, actor: string, task: Task, extra: Partial<NewEvent> = {}) {
    return this.emit({
      id: newId("evt"),
      type,
      channel: task.channel,
      thread: task.thread,
      actor,
      at: task.updatedAt,
      task: task.id,
      ...extra,
    });
  }

  private emit(ev: NewEvent): Promise<BoardEvent> {
    return this.store.append(this.id, stripUndefined(ev));
  }

  /** Resolve on the next append (if the store can notify), after the poll interval, or on abort. */
  private wake(maxMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let unsub: (() => void) | undefined;
      const done = () => {
        clearTimeout(timer);
        unsub?.();
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(maxMs, this.ob.pollIntervalMs));
      if (this.store.subscribe) unsub = this.store.subscribe(this.id, done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}

// -------------------------------------------------------------------- helpers

function requireOwner(t: Task, actor: string): void {
  if (t.status !== "claimed") throw new BoardError("conflict", `task ${t.id} is ${t.status}, not claimed`);
  if (t.owner !== actor) {
    throw new BoardError("conflict", `task ${t.id} is claimed by ${t.owner}; your lease is gone`);
  }
}

function schemaKey(id: string) {
  return `schema:${id}`;
}

function checkActor(actor: string) {
  if (typeof actor !== "string" || !actor || actor.length > 128) {
    throw new BoardError("unauthenticated", "missing or invalid actor");
  }
}

function checkChannel(channel: string) {
  if (!isName(channel)) {
    throw new BoardError("invalid_argument", `invalid channel "${channel}" (lowercase letters, digits, . _ -)`);
  }
}

function isThreadId(s: string) {
  return typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9:@._-]{0,127}$/.test(s);
}

function checkLabels(labels?: Labels) {
  if (labels === undefined) return;
  if (typeof labels !== "object" || labels === null || Array.isArray(labels)) {
    throw new BoardError("invalid_argument", "labels must be an object of strings");
  }
  for (const [k, v] of Object.entries(labels)) {
    if (!isLabelKey(k)) throw new BoardError("invalid_argument", `invalid label key "${k}"`);
    if (typeof v !== "string" || v.length > 256) {
      throw new BoardError("invalid_argument", `label ${k} must be a string up to 256 chars`);
    }
  }
}

function clampLimit(limit?: number) {
  if (limit === undefined) return 100;
  if (!Number.isInteger(limit) || limit < 1) throw new BoardError("invalid_argument", "limit must be a positive integer");
  return Math.min(limit, 1000);
}

function normalizeEventQuery(q: EventQuery): EventQuery {
  const after = q.after ?? 0;
  if (!Number.isInteger(after) || after < 0) throw new BoardError("invalid_argument", "after must be a non-negative integer");
  if (q.channel !== undefined) checkChannel(q.channel);
  return { ...q, after, limit: clampLimit(q.limit) };
}

function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}
