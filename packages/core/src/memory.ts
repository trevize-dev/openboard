import { EventEmitter } from "node:events";
import { compareTasks, matchesEventQuery, matchesTaskQuery } from "./query.js";
import type { BoardEvent, EventQuery, NewEvent, Store, Task, TaskQuery } from "./types.js";

interface BoardState {
  events: BoardEvent[];
  tasks: Map<string, Task>;
  docs: Map<string, unknown>;
}

/**
 * In-memory Store for local dev and tests. Every method yields to the event loop
 * first, so concurrent callers interleave the way they would against a real database.
 */
export class MemoryStore implements Store {
  readonly name = "memory";
  readonly capabilities = { notify: true, transactions: true };
  private boards = new Map<string, BoardState>();
  private emitter = new EventEmitter().setMaxListeners(0);

  private state(board: string): BoardState {
    let s = this.boards.get(board);
    if (!s) {
      s = { events: [], tasks: new Map(), docs: new Map() };
      this.boards.set(board, s);
    }
    return s;
  }

  async append(board: string, event: NewEvent): Promise<BoardEvent> {
    await tick();
    const s = this.state(board);
    const stored: BoardEvent = clone({ ...event, board, seq: s.events.length + 1 });
    s.events.push(stored);
    this.emitter.emit(board, stored.seq);
    return clone(stored);
  }

  async readEvents(board: string, query: EventQuery = {}): Promise<BoardEvent[]> {
    await tick();
    const { events } = this.state(board);
    const after = query.after ?? 0;
    const limit = query.limit ?? 100;
    const out: BoardEvent[] = [];
    // seq n lives at index n-1, so start right after the cursor.
    for (let i = after; i < events.length && out.length < limit; i++) {
      const ev = events[i]!;
      if (matchesEventQuery(ev, query)) out.push(clone(ev));
    }
    return out;
  }

  async head(board: string): Promise<number> {
    await tick();
    return this.state(board).events.length;
  }

  async insertTask(task: Task): Promise<boolean> {
    await tick();
    const { tasks } = this.state(task.board);
    if (tasks.has(task.id)) return false;
    tasks.set(task.id, clone(task));
    return true;
  }

  async getTask(board: string, id: string): Promise<Task | null> {
    await tick();
    const t = this.state(board).tasks.get(id);
    return t ? clone(t) : null;
  }

  async getTasks(board: string, ids: string[]): Promise<Task[]> {
    await tick();
    const { tasks } = this.state(board);
    return ids.flatMap((id) => {
      const t = tasks.get(id);
      return t ? [clone(t)] : [];
    });
  }

  async findTasks(board: string, query: TaskQuery = {}): Promise<Task[]> {
    await tick();
    const all = [...this.state(board).tasks.values()].filter((t) => matchesTaskQuery(t, query));
    return all.sort(compareTasks).slice(0, query.limit ?? 100).map(clone);
  }

  async casTask(next: Task, expectVersion: number): Promise<boolean> {
    await tick();
    const { tasks } = this.state(next.board);
    const cur = tasks.get(next.id);
    if (!cur || cur.version !== expectVersion || next.version !== expectVersion + 1) return false;
    tasks.set(next.id, clone(next));
    return true;
  }

  async putDocIfAbsent(board: string, key: string, value: unknown): Promise<boolean> {
    await tick();
    const { docs } = this.state(board);
    if (docs.has(key)) return false;
    docs.set(key, clone(value));
    return true;
  }

  async getDoc(board: string, key: string): Promise<unknown | null> {
    await tick();
    const v = this.state(board).docs.get(key);
    return v === undefined ? null : clone(v);
  }

  subscribe(board: string, onAppend: (seq: number) => void): () => void {
    this.emitter.on(board, onAppend);
    return () => this.emitter.off(board, onAppend);
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
