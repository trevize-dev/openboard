/** Labels are flat string key/value pairs, e.g. { kind: "bug", pr: "123" }. */
export type Labels = Record<string, string>;

export type EventType =
  | "message"
  | "task.created"
  | "task.claimed"
  | "task.renewed"
  | "task.released"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "schema.registered";

/** An event as written by the core, before the store assigns `seq`. */
export interface NewEvent {
  /** Globally unique, sortable id (ULID). */
  id: string;
  type: EventType;
  channel: string;
  /** Thread the event belongs to. A thread's id is the id of its first event (or its task). */
  thread: string;
  /** Principal that caused the event. */
  actor: string;
  /** Unix epoch milliseconds. */
  at: number;
  body?: string;
  /** Structured payload. Validated against `schema` when set. */
  data?: unknown;
  /** Versioned schema id, e.g. "security-finding@1". */
  schema?: string;
  labels?: Labels;
  /** Task this event concerns, for task.* events. */
  task?: string;
}

/** A stored event. `seq` increases by exactly 1 per event within a board, starting at 1. */
export interface BoardEvent extends NewEvent {
  board: string;
  seq: number;
}

export type TaskStatus = "open" | "claimed" | "done" | "failed" | "cancelled";

export interface Task {
  id: string;
  board: string;
  channel: string;
  /** Thread holding the task's conversation. Defaults to the task id. */
  thread: string;
  title: string;
  body?: string;
  status: TaskStatus;
  labels: Labels;
  /** Ids of tasks that must be `done` before this one can be claimed. */
  blockedBy: string[];
  /** Higher runs first. */
  priority: number;
  owner?: string;
  /** Epoch ms when the current lease ends. A claimed task past its lease is claimable again. */
  leaseUntil?: number;
  /** Number of times the task has been claimed. */
  attempt: number;
  result?: unknown;
  error?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Optimistic-concurrency version. Starts at 1 and increases by 1 on every write. */
  version: number;
}

export interface EventQuery {
  /** Return events with seq > after. Default 0. */
  after?: number;
  /** Max events to return. Default 100, max 1000. */
  limit?: number;
  channel?: string;
  thread?: string;
}

export interface TaskQuery {
  status?: TaskStatus[];
  channel?: string;
  /** Every label must match exactly. */
  labels?: Labels;
  /**
   * When set, return only tasks that could be claimed at this time:
   * status "open", or status "claimed" with leaseUntil < claimableAt.
   * Takes precedence over `status`.
   */
  claimableAt?: number;
  /** Max tasks to return. Default 100, max 1000. */
  limit?: number;
}

export interface StoreCapabilities {
  /** Store can wake waiters itself (store.subscribe). Without it, the core polls. */
  notify: boolean;
  /** Store applies all writes atomically across records. Informational for now. */
  transactions: boolean;
}

/**
 * The only port an adapter must implement.
 *
 * Contract: every operation is atomic on a single record. Nothing requires
 * transactions across records, so document stores, KV stores and SQL all fit.
 * Task ordering for findTasks: priority descending, then createdAt ascending,
 * then id ascending.
 */
export interface Store {
  readonly name: string;
  readonly capabilities: StoreCapabilities;

  /** Append an event, assigning the next seq for the board (gap-free, starting at 1). */
  append(board: string, event: NewEvent): Promise<BoardEvent>;
  readEvents(board: string, query?: EventQuery): Promise<BoardEvent[]>;
  /** Highest seq on the board, 0 when empty. */
  head(board: string): Promise<number>;

  /** Insert only if no task with this id exists. Returns false when it already exists. */
  insertTask(task: Task): Promise<boolean>;
  getTask(board: string, id: string): Promise<Task | null>;
  getTasks(board: string, ids: string[]): Promise<Task[]>;
  findTasks(board: string, query?: TaskQuery): Promise<Task[]>;
  /**
   * Replace the task only if its stored version equals `expectVersion`.
   * `next.version` must be expectVersion + 1. Returns false on mismatch or when missing.
   */
  casTask(next: Task, expectVersion: number): Promise<boolean>;

  /** Insert-if-absent key/value document (used for schemas). Returns false when the key exists. */
  putDocIfAbsent(board: string, key: string, value: unknown): Promise<boolean>;
  getDoc(board: string, key: string): Promise<unknown | null>;

  /** Optional: call `onAppend` with the new head seq whenever an event is appended to the board. */
  subscribe?(board: string, onAppend: (seq: number) => void): () => void;
  close?(): Promise<void>;
}
