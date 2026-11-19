import { Hono, type Context } from "hono";
import { BoardError, type Labels, type Openboard, type TaskStatus } from "@trevize-dev/openboard-core";

export interface ServerOptions {
  /**
   * Resolve the calling principal from a request. Return null to reject with 401.
   * Default: bearer tokens from `tokens`; with no tokens configured, an open dev mode
   * that trusts the X-Openboard-Actor header.
   */
  authenticate?: (req: Request) => string | null | Promise<string | null>;
  /** Map of bearer token to actor name, e.g. { "s3cr3t": "triage-agent" }. */
  tokens?: Record<string, string>;
  /** Longest a long-poll may wait, in ms. Default 60s. */
  maxWaitMs?: number;
}

type Env = { Variables: { actor: string } };

const STATUSES: TaskStatus[] = ["open", "claimed", "done", "failed", "cancelled"];

/** Build the openboard HTTP API. `app.fetch` is a standard (Request) => Response handler. */
export function createApp(ob: Openboard, options: ServerOptions = {}) {
  const maxWait = options.maxWaitMs ?? 60_000;
  const authenticate = options.authenticate ?? defaultAuth(options.tokens);
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (BoardError.is(err)) return c.json(err.toJSON(), err.status as 400);
    if (err instanceof SyntaxError) return c.json(new BoardError("invalid_argument", "invalid JSON body").toJSON(), 400);
    console.error(err);
    return c.json(new BoardError("internal", "internal error").toJSON(), 500);
  });
  app.notFound((c) => c.json(new BoardError("not_found", `no route ${c.req.method} ${c.req.path}`).toJSON(), 404));

  app.get("/v1/health", (c) => c.json({ ok: true, store: ob.store.name }));

  app.use("/v1/boards/*", async (c, next) => {
    const actor = await authenticate(c.req.raw);
    if (!actor) throw new BoardError("unauthenticated", "missing or invalid bearer token");
    c.set("actor", actor);
    await next();
  });

  const board = (c: Context<Env>) => ob.board(c.req.param("board") ?? "");

  app.get("/v1/boards/:board/whoami", (c) => c.json({ actor: c.get("actor"), board: board(c).id }));

  // events
  app.get("/v1/boards/:board/events", async (c) => {
    const q = {
      after: intParam(c, "after"),
      limit: intParam(c, "limit"),
      channel: c.req.query("channel"),
      thread: c.req.query("thread"),
    };
    const wait = Math.min(intParam(c, "wait") ?? 0, maxWait);
    const b = board(c);
    const events = wait > 0 ? await b.waitForEvents(q, wait, c.req.raw.signal) : await b.events(q);
    return c.json({ events, cursor: events.at(-1)?.seq ?? (q.after ?? 0) });
  });

  app.get("/v1/boards/:board/head", async (c) => c.json({ head: await board(c).head() }));

  app.post("/v1/boards/:board/messages", async (c) => {
    const ev = await board(c).post(c.get("actor"), await c.req.json());
    return c.json({ event: ev }, 201);
  });

  // tasks
  app.post("/v1/boards/:board/tasks", async (c) => {
    const task = await board(c).createTask(c.get("actor"), await c.req.json());
    return c.json({ task }, 201);
  });

  app.get("/v1/boards/:board/tasks", async (c) => {
    const status = c.req.query("status");
    const statuses = status ? status.split(",") : undefined;
    if (statuses?.some((s) => !STATUSES.includes(s as TaskStatus))) {
      throw new BoardError("invalid_argument", `status must be one of ${STATUSES.join(", ")}`);
    }
    const tasks = await board(c).tasks({
      status: statuses as TaskStatus[] | undefined,
      channel: c.req.query("channel"),
      labels: labelParams(c.req.queries("label")),
      ready: c.req.query("ready") === "1" || c.req.query("ready") === "true",
      limit: intParam(c, "limit"),
    });
    return c.json({ tasks });
  });

  app.post("/v1/boards/:board/tasks/claim", async (c) => {
    const body = await jsonOrEmpty(c);
    const task = await board(c).claim(c.get("actor"), {
      channel: body.channel,
      labels: body.labels,
      leaseMs: body.leaseMs,
      waitMs: Math.min(Number(body.waitMs ?? 0), maxWait),
      signal: c.req.raw.signal,
    });
    return c.json({ task });
  });

  app.get("/v1/boards/:board/tasks/:id", async (c) => c.json({ task: await board(c).getTask(c.req.param("id")) }));

  app.post("/v1/boards/:board/tasks/:id/:action{renew|complete|fail|release|cancel}", async (c) => {
    const b = board(c);
    const actor = c.get("actor");
    const id = c.req.param("id");
    const body = await jsonOrEmpty(c);
    switch (c.req.param("action")) {
      case "renew":
        return c.json({ task: await b.renew(actor, id, body.leaseMs) });
      case "complete":
        return c.json({ task: await b.complete(actor, id, body.result) });
      case "fail":
        return c.json({ task: await b.fail(actor, id, { reason: body.reason, retry: body.retry === true }) });
      case "release":
        return c.json({ task: await b.release(actor, id) });
      default:
        return c.json({ task: await b.cancel(actor, id, body.reason) });
    }
  });

  // schemas
  app.put("/v1/boards/:board/schemas/:id", async (c) => {
    const body = await c.req.json();
    const schema = await board(c).registerSchema(c.get("actor"), c.req.param("id"), body.schema ?? body);
    return c.json({ schema });
  });
  app.get("/v1/boards/:board/schemas/:id", async (c) => c.json({ schema: await board(c).getSchema(c.req.param("id")) }));

  return app;
}

function defaultAuth(tokens?: Record<string, string>) {
  const configured = tokens && Object.keys(tokens).length > 0;
  return (req: Request): string | null => {
    const auth = req.headers.get("authorization");
    if (configured) {
      const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : undefined;
      return (token && tokens![token]) || null;
    }
    // Dev mode: anyone can act as anyone. Never expose this beyond localhost.
    return req.headers.get("x-openboard-actor")?.trim() || "anonymous";
  };
}

/** Parse "a=1,b=2" style lists from OPENBOARD_TOKENS. */
export function parseTokens(spec: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (spec ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

function intParam(c: Context<Env>, name: string): number | undefined {
  const v = c.req.query(name);
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new BoardError("invalid_argument", `${name} must be a non-negative integer`);
  return n;
}

function labelParams(values: string[] | undefined): Labels | undefined {
  if (!values?.length) return undefined;
  const out: Labels = {};
  for (const v of values) {
    const i = v.indexOf("=");
    if (i <= 0) throw new BoardError("invalid_argument", `label filter must be key=value, got "${v}"`);
    out[v.slice(0, i)] = v.slice(i + 1);
  }
  return out;
}

async function jsonOrEmpty(c: Context<Env>): Promise<Record<string, any>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  const v = JSON.parse(text);
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new BoardError("invalid_argument", "body must be a JSON object");
  }
  return v;
}
