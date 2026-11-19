import type {
  BoardEvent,
  ClaimInput,
  CreateTaskInput,
  EventQuery,
  FailInput,
  Labels,
  PostInput,
  SchemaRecord,
  Task,
  TaskStatus,
} from "@trevize-dev/openboard-core";

export type { BoardEvent, Task, Labels, TaskStatus, SchemaRecord } from "@trevize-dev/openboard-core";

export interface ClientOptions {
  /** API base URL. Default: $OPENBOARD_URL or http://127.0.0.1:7420 */
  url?: string;
  /** Board name. Default: $OPENBOARD_BOARD or "default" */
  board?: string;
  /** Bearer token. Default: $OPENBOARD_TOKEN */
  token?: string;
  /** Actor name for servers in dev mode (no tokens). Default: $OPENBOARD_ACTOR */
  actor?: string;
  fetch?: typeof fetch;
}

export class OpenboardApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "OpenboardApiError";
  }
}

export interface TaskListQuery {
  status?: TaskStatus[];
  channel?: string;
  labels?: Labels;
  ready?: boolean;
  limit?: number;
}

/** Client for one board. Create more with `client.board(name)`. */
export class OpenboardClient {
  readonly url: string;
  readonly boardName: string;
  private readonly token?: string;
  private readonly actor?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions = {}) {
    const env = typeof process !== "undefined" ? process.env : {};
    this.url = (options.url ?? env.OPENBOARD_URL ?? "http://127.0.0.1:7420").replace(/\/+$/, "");
    this.boardName = options.board ?? env.OPENBOARD_BOARD ?? "default";
    this.token = options.token ?? env.OPENBOARD_TOKEN;
    this.actor = options.actor ?? env.OPENBOARD_ACTOR;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  board(name: string): OpenboardClient {
    return new OpenboardClient({ url: this.url, board: name, token: this.token, actor: this.actor, fetch: this.fetchImpl });
  }

  // messages & events
  async post(input: PostInput): Promise<BoardEvent> {
    return (await this.call<{ event: BoardEvent }>("POST", "/messages", input)).event;
  }

  async events(query: EventQuery & { waitMs?: number } = {}, signal?: AbortSignal) {
    const { waitMs, ...q } = query;
    return this.call<{ events: BoardEvent[]; cursor: number }>(
      "GET",
      `/events${qs({ ...q, wait: waitMs })}`,
      undefined,
      signal,
    );
  }

  /** Stream events as they arrive, using long-polling. Starts at `after` (default: now). */
  async *follow(query: EventQuery = {}, signal?: AbortSignal): AsyncGenerator<BoardEvent> {
    let after = query.after;
    if (after === undefined) after = await this.head();
    while (!signal?.aborted) {
      let res;
      try {
        res = await this.events({ ...query, after, waitMs: 30_000 }, signal);
      } catch (err) {
        if (signal?.aborted) return;
        throw err;
      }
      for (const ev of res.events) {
        after = ev.seq;
        yield ev;
      }
    }
  }

  /** Current highest event seq on the board. */
  async head(): Promise<number> {
    return (await this.call<{ head: number }>("GET", "/head")).head;
  }

  // tasks
  async createTask(input: CreateTaskInput): Promise<Task> {
    return (await this.call<{ task: Task }>("POST", "/tasks", input)).task;
  }

  async tasks(query: TaskListQuery = {}): Promise<Task[]> {
    const labels = Object.entries(query.labels ?? {}).map(([k, v]) => `${k}=${v}`);
    const path = `/tasks${qs({
      status: query.status?.join(","),
      channel: query.channel,
      ready: query.ready ? 1 : undefined,
      limit: query.limit,
      label: labels,
    })}`;
    return (await this.call<{ tasks: Task[] }>("GET", path)).tasks;
  }

  async getTask(id: string): Promise<Task> {
    return (await this.call<{ task: Task }>("GET", `/tasks/${enc(id)}`)).task;
  }

  /** Claim the next ready task. Returns null when nothing is claimable within waitMs. */
  async claim(input: Omit<ClaimInput, "signal"> = {}, signal?: AbortSignal): Promise<Task | null> {
    return (await this.call<{ task: Task | null }>("POST", "/tasks/claim", input, signal)).task;
  }

  async renew(id: string, leaseMs?: number): Promise<Task> {
    return this.action(id, "renew", { leaseMs });
  }
  async complete(id: string, result?: unknown): Promise<Task> {
    return this.action(id, "complete", { result });
  }
  async fail(id: string, input: FailInput = {}): Promise<Task> {
    return this.action(id, "fail", input);
  }
  async release(id: string): Promise<Task> {
    return this.action(id, "release", {});
  }
  async cancel(id: string, reason?: string): Promise<Task> {
    return this.action(id, "cancel", { reason });
  }

  /**
   * Run `work` on a claimed task while renewing its lease in the background,
   * then complete it with the returned value, or fail it if `work` throws.
   */
  async work<T>(task: Task, work: (task: Task, signal: AbortSignal) => Promise<T>, opts: { leaseMs?: number; retryOnError?: boolean } = {}) {
    const leaseMs = opts.leaseMs ?? Math.max(1_000, (task.leaseUntil ?? Date.now() + 300_000) - Date.now());
    const ctrl = new AbortController();
    const timer = setInterval(() => {
      this.renew(task.id, leaseMs).catch(() => ctrl.abort(new Error("lease lost")));
    }, Math.max(500, Math.floor(leaseMs / 3)));
    try {
      const result = await work(task, ctrl.signal);
      return await this.complete(task.id, result);
    } catch (err) {
      if (!ctrl.signal.aborted) {
        await this.fail(task.id, { reason: (err as Error).message ?? String(err), retry: opts.retryOnError ?? true }).catch(() => {});
      }
      throw err;
    } finally {
      clearInterval(timer);
    }
  }

  // schemas
  async registerSchema(id: string, schema: unknown): Promise<SchemaRecord> {
    return (await this.call<{ schema: SchemaRecord }>("PUT", `/schemas/${enc(id)}`, { schema })).schema;
  }
  async getSchema(id: string): Promise<SchemaRecord> {
    return (await this.call<{ schema: SchemaRecord }>("GET", `/schemas/${enc(id)}`)).schema;
  }

  async whoami(): Promise<{ actor: string; board: string }> {
    return this.call("GET", "/whoami");
  }

  // internals
  private action(id: string, action: string, body: object): Promise<Task> {
    return this.call<{ task: Task }>("POST", `/tasks/${enc(id)}/${action}`, body).then((r) => r.task);
  }

  private async call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.actor) headers["x-openboard-actor"] = this.actor;
    const res = await this.fetchImpl(`${this.url}/v1/boards/${enc(this.boardName)}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const e = json?.error ?? {};
      throw new OpenboardApiError(res.status, e.code ?? "http_error", e.message ?? `HTTP ${res.status}`, e.details);
    }
    return json as T;
  }
}

function enc(s: string) {
  return encodeURIComponent(s);
}

function qs(params: Record<string, string | number | string[] | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, x));
    else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
