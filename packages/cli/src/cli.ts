import { readFileSync } from "node:fs";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { Openboard, parseDuration, type BoardEvent, type Labels, type Store, type Task } from "@trevize-dev/openboard-core";
import { MemoryStore } from "@trevize-dev/openboard-core";
import { OpenboardApiError, OpenboardClient } from "@trevize-dev/openboard-sdk";

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  readStdin: () => Promise<string>;
  /** Pretty output for people; JSON when false (pipes, agents). */
  tty: boolean;
  env: Record<string, string | undefined>;
  /** Abort long-running commands (follow, serve). */
  signal?: AbortSignal;
}

const defaultIo = (): Io => ({
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  },
  tty: Boolean(process.stdout.isTTY),
  env: process.env,
});

export const EXIT = { ok: 0, error: 1, usage: 2, empty: 3 } as const;

const HELP = `openboard (ob): a shared task and message board for agents and humans

Usage: ob <command> [options]

Server
  serve [--port 7420] [--host 127.0.0.1] [--store sqlite:./openboard.db | memory]

Messages
  post <channel> [body|-] [--thread ID] [--data JSON|@file] [--schema NAME@V] [--label k=v]...
  events [--channel C] [--thread T] [--after SEQ] [--limit N] [--follow]

Tasks
  tasks create <channel> <title> [--body TEXT] [--label k=v]... [--blocked-by ID]... [--priority N] [--id ID]
  tasks list [--status open,claimed,...] [--channel C] [--label k=v]... [--ready] [--limit N]
  tasks get <id>
  tasks claim [--channel C] [--label k=v]... [--lease 5m] [--wait 30s]   (exit 3 if nothing to claim)
  tasks renew <id> [--lease 5m]
  tasks complete <id> [--result JSON|text]
  tasks fail <id> [--reason TEXT] [--retry]
  tasks release <id>
  tasks cancel <id> [--reason TEXT]

Schemas
  schema put <name@version> <file.json|->
  schema get <name@version>

Other
  whoami

Global options (or env)
  --url URL        OPENBOARD_URL     default http://127.0.0.1:7420
  --board NAME     OPENBOARD_BOARD   default "default"
  --token TOKEN    OPENBOARD_TOKEN   bearer token
  --actor NAME     OPENBOARD_ACTOR   who you are, when the server runs without tokens
  --json           force JSON output (the default when stdout is not a terminal)
`;

type Opts = NonNullable<ParseArgsConfig["options"]>;
const GLOBAL: Opts = {
  url: { type: "string" },
  board: { type: "string" },
  token: { type: "string" },
  actor: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};
const LABEL: Opts = { label: { type: "string", multiple: true, short: "l" } };

class UsageError extends Error {}

export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    io.out(HELP);
    return cmd ? EXIT.ok : EXIT.usage;
  }
  if (cmd === "--version" || cmd === "version") {
    io.out("0.1.0");
    return EXIT.ok;
  }
  try {
    switch (cmd) {
      case "serve":
        return await serveCmd(rest, io);
      case "post":
        return await postCmd(rest, io);
      case "events":
        return await eventsCmd(rest, io);
      case "tasks":
      case "task":
        return await tasksCmd(rest, io);
      case "schema":
      case "schemas":
        return await schemaCmd(rest, io);
      case "whoami": {
        const { client, json } = parse(rest, {}, io);
        print(io, json, await client.whoami(), (r) => `${r.actor} on board ${r.board}`);
        return EXIT.ok;
      }
      default:
        throw new UsageError(`unknown command "${cmd}"`);
    }
  } catch (err) {
    if (err instanceof UsageError || (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      io.err(`error: ${(err as Error).message}\nRun "ob help" for usage.`);
      return EXIT.usage;
    }
    if (err instanceof OpenboardApiError) {
      io.err(`error: ${err.message} (${err.code})`);
      if (err.details) io.err(JSON.stringify(err.details, null, 2));
      return EXIT.error;
    }
    if ((err as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED") {
      io.err(`error: can't reach the openboard server. Start one with "ob serve" or set OPENBOARD_URL.`);
      return EXIT.error;
    }
    io.err(`error: ${(err as Error).message}`);
    return EXIT.error;
  }
}

// ------------------------------------------------------------------ commands

async function serveCmd(argv: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { port: { type: "string" }, host: { type: "string" }, store: { type: "string" }, json: { type: "boolean" } },
    strict: true,
  });
  const { parseTokens } = await import("@trevize-dev/openboard-server");
  const { serve } = await import("@trevize-dev/openboard-server/node");
  const tokens = parseTokens(io.env.OPENBOARD_TOKENS);
  const host = (values.host as string | undefined) ?? "127.0.0.1";
  const isLocal = ["127.0.0.1", "localhost", "::1"].includes(host);
  if (!isLocal && !Object.keys(tokens).length) {
    throw new UsageError(`refusing to listen on ${host} without auth; set OPENBOARD_TOKENS="token=actor,..."`);
  }
  const storeSpec = (values.store as string | undefined) ?? io.env.OPENBOARD_STORE ?? "sqlite:./openboard.db";
  const store = await openStore(storeSpec);
  const ob = new Openboard(store);
  const port = values.port ? Number(values.port) : Number(io.env.PORT ?? 7420);
  const server = await serve(ob, { port, hostname: host, tokens });
  io.err(
    `openboard listening on ${server.url} (store: ${storeSpec}, auth: ${
      Object.keys(tokens).length ? `${Object.keys(tokens).length} token(s)` : "dev mode, X-Openboard-Actor header"
    })`,
  );
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    io.signal?.addEventListener("abort", stop, { once: true });
    if (!io.signal) {
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }
  });
  await server.close();
  await store.close?.();
  return EXIT.ok;
}

export async function openStore(spec: string): Promise<Store> {
  if (spec === "memory") return new MemoryStore();
  if (spec.startsWith("sqlite:")) {
    const { SqliteStore } = await import("@trevize-dev/openboard-store-sqlite");
    return new SqliteStore(spec.slice("sqlite:".length) || "./openboard.db");
  }
  throw new UsageError(`unknown store "${spec}" (use sqlite:PATH or memory)`);
}

async function postCmd(argv: string[], io: Io): Promise<number> {
  const { client, json, values, positionals } = parse(
    argv,
    { thread: { type: "string" }, data: { type: "string" }, schema: { type: "string" }, ...LABEL },
    io,
  );
  const [channel, bodyArg] = positionals;
  if (!channel) throw new UsageError("post needs a channel");
  const body = bodyArg === "-" ? (await io.readStdin()).trimEnd() : bodyArg;
  const data = values.data !== undefined ? readJsonArg(values.data as string, "--data") : undefined;
  const ev = await client.post({
    channel,
    body,
    data,
    schema: values.schema as string | undefined,
    thread: values.thread as string | undefined,
    labels: labels(values.label),
  });
  print(io, json, { event: ev }, () => `posted #${ev.seq} in ${ev.channel} (thread ${ev.thread})`);
  return EXIT.ok;
}

async function eventsCmd(argv: string[], io: Io): Promise<number> {
  const { client, json, values } = parse(
    argv,
    {
      channel: { type: "string" },
      thread: { type: "string" },
      after: { type: "string" },
      limit: { type: "string" },
      follow: { type: "boolean", short: "f" },
    },
    io,
  );
  const query = {
    channel: values.channel as string | undefined,
    thread: values.thread as string | undefined,
    after: values.after !== undefined ? int(values.after as string, "--after") : undefined,
    limit: values.limit !== undefined ? int(values.limit as string, "--limit") : undefined,
  };
  if (values.follow) {
    for await (const ev of client.follow(query, io.signal)) {
      io.out(json ? JSON.stringify(ev) : formatEvent(ev));
    }
    return EXIT.ok;
  }
  const { events } = await client.events(query);
  print(io, json, { events }, () => (events.length ? events.map(formatEvent).join("\n") : "(no events)"));
  return EXIT.ok;
}

async function tasksCmd(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "create": {
      const { client, json, values, positionals } = parse(
        rest,
        {
          body: { type: "string" },
          "blocked-by": { type: "string", multiple: true },
          priority: { type: "string" },
          thread: { type: "string" },
          id: { type: "string" },
          ...LABEL,
        },
        io,
      );
      const [channel, ...titleParts] = positionals;
      if (!channel || !titleParts.length) throw new UsageError("tasks create needs a channel and a title");
      const task = await client.createTask({
        channel,
        title: titleParts.join(" "),
        body: values.body as string | undefined,
        labels: labels(values.label),
        blockedBy: values["blocked-by"] as string[] | undefined,
        priority: values.priority !== undefined ? int(values.priority as string, "--priority", true) : undefined,
        thread: values.thread as string | undefined,
        id: values.id as string | undefined,
      });
      print(io, json, { task }, () => `created ${formatTask(task)}`);
      return EXIT.ok;
    }
    case "list":
    case "ls": {
      const { client, json, values } = parse(
        rest,
        { status: { type: "string" }, channel: { type: "string" }, ready: { type: "boolean" }, limit: { type: "string" }, ...LABEL },
        io,
      );
      const tasks = await client.tasks({
        status: values.status ? ((values.status as string).split(",") as Task["status"][]) : undefined,
        channel: values.channel as string | undefined,
        labels: labels(values.label),
        ready: Boolean(values.ready),
        limit: values.limit !== undefined ? int(values.limit as string, "--limit") : undefined,
      });
      print(io, json, { tasks }, () => (tasks.length ? tasks.map(formatTask).join("\n") : "(no tasks)"));
      return EXIT.ok;
    }
    case "get":
    case "show": {
      const { client, json, positionals } = parse(rest, {}, io);
      const task = await client.getTask(need(positionals[0], "task id"));
      print(io, json, { task }, () => formatTaskDetail(task));
      return EXIT.ok;
    }
    case "claim": {
      const { client, json, values } = parse(
        rest,
        { channel: { type: "string" }, lease: { type: "string" }, wait: { type: "string" }, ready: { type: "boolean" }, ...LABEL },
        io,
      );
      const task = await client.claim(
        {
          channel: values.channel as string | undefined,
          labels: labels(values.label),
          leaseMs: values.lease ? duration(values.lease as string) : undefined,
          waitMs: values.wait ? duration(values.wait as string) : undefined,
        },
        io.signal,
      );
      print(io, json, { task }, () => (task ? `claimed ${formatTask(task)}` : "nothing to claim"));
      return task ? EXIT.ok : EXIT.empty;
    }
    case "renew": {
      const { client, json, values, positionals } = parse(rest, { lease: { type: "string" } }, io);
      const task = await client.renew(need(positionals[0], "task id"), values.lease ? duration(values.lease as string) : undefined);
      print(io, json, { task }, () => `renewed ${task.id} until ${new Date(task.leaseUntil!).toISOString()}`);
      return EXIT.ok;
    }
    case "complete":
    case "done": {
      const { client, json, values, positionals } = parse(rest, { result: { type: "string" } }, io);
      const result = values.result !== undefined ? jsonOrText(values.result as string) : undefined;
      const task = await client.complete(need(positionals[0], "task id"), result);
      print(io, json, { task }, () => `completed ${formatTask(task)}`);
      return EXIT.ok;
    }
    case "fail": {
      const { client, json, values, positionals } = parse(rest, { reason: { type: "string" }, retry: { type: "boolean" } }, io);
      const task = await client.fail(need(positionals[0], "task id"), {
        reason: values.reason as string | undefined,
        retry: Boolean(values.retry),
      });
      print(io, json, { task }, () => `${values.retry ? "released for retry" : "failed"} ${formatTask(task)}`);
      return EXIT.ok;
    }
    case "release": {
      const { client, json, positionals } = parse(rest, {}, io);
      const task = await client.release(need(positionals[0], "task id"));
      print(io, json, { task }, () => `released ${formatTask(task)}`);
      return EXIT.ok;
    }
    case "cancel": {
      const { client, json, values, positionals } = parse(rest, { reason: { type: "string" } }, io);
      const task = await client.cancel(need(positionals[0], "task id"), values.reason as string | undefined);
      print(io, json, { task }, () => `cancelled ${formatTask(task)}`);
      return EXIT.ok;
    }
    default:
      throw new UsageError(sub ? `unknown tasks command "${sub}"` : "tasks needs a subcommand");
  }
}

async function schemaCmd(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  const { client, json, positionals } = parse(rest, {}, io);
  const id = need(positionals[0], "schema id (name@version)");
  if (sub === "put") {
    const src = need(positionals[1], "schema file (or - for stdin)");
    const text = src === "-" ? await io.readStdin() : readFileSync(src, "utf8");
    const schema = await client.registerSchema(id, JSON.parse(text));
    print(io, json, { schema }, () => `registered ${schema.id}`);
    return EXIT.ok;
  }
  if (sub === "get") {
    const schema = await client.getSchema(id);
    print(io, json, { schema }, () => JSON.stringify(schema.schema, null, 2));
    return EXIT.ok;
  }
  throw new UsageError(`unknown schema command "${sub ?? ""}"`);
}

// ------------------------------------------------------------------ helpers

function parse(argv: string[], options: Opts, io: Io) {
  const { values, positionals } = parseArgs({ args: argv, options: { ...GLOBAL, ...options }, allowPositionals: true, strict: true });
  const client = new OpenboardClient({
    url: (values.url as string | undefined) ?? io.env.OPENBOARD_URL,
    board: (values.board as string | undefined) ?? io.env.OPENBOARD_BOARD,
    token: (values.token as string | undefined) ?? io.env.OPENBOARD_TOKEN,
    actor: (values.actor as string | undefined) ?? io.env.OPENBOARD_ACTOR,
  });
  return { client, values, positionals, json: Boolean(values.json) || !io.tty };
}

function print<T>(io: Io, json: boolean, value: T, human: (v: T) => string) {
  io.out(json ? JSON.stringify(value) : human(value));
}

function labels(raw: unknown): Labels | undefined {
  const list = raw as string[] | undefined;
  if (!list?.length) return undefined;
  const out: Labels = {};
  for (const item of list) {
    const i = item.indexOf("=");
    if (i <= 0) throw new UsageError(`--label must be key=value, got "${item}"`);
    out[item.slice(0, i)] = item.slice(i + 1);
  }
  return out;
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new UsageError(`missing ${what}`);
  return v;
}

function int(v: string, flag: string, allowNegative = false): number {
  const n = Number(v);
  if (!Number.isInteger(n) || (!allowNegative && n < 0)) throw new UsageError(`${flag} must be an integer`);
  return n;
}

function duration(v: string): number {
  try {
    return parseDuration(v);
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

function readJsonArg(v: string, flag: string): unknown {
  const text = v.startsWith("@") ? readFileSync(v.slice(1), "utf8") : v;
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`${flag} must be JSON (or @file.json)`);
  }
}

function jsonOrText(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function formatTask(t: Task): string {
  const labels = Object.entries(t.labels).map(([k, v]) => `${k}=${v}`).join(" ");
  const owner = t.status === "claimed" ? ` by ${t.owner}` : "";
  const blocked = t.blockedBy.length ? ` blocked-by:${t.blockedBy.length}` : "";
  return `${t.id}  [${t.status}${owner}]  ${t.channel}  ${t.title}${labels ? `  (${labels})` : ""}${blocked}`;
}

function formatTaskDetail(t: Task): string {
  const lines = [
    `${t.title}`,
    `  id:        ${t.id}`,
    `  status:    ${t.status}${t.owner ? ` (owner ${t.owner}, attempt ${t.attempt})` : ""}`,
    `  channel:   ${t.channel}   thread: ${t.thread}   priority: ${t.priority}`,
  ];
  if (t.leaseUntil) lines.push(`  lease:     until ${new Date(t.leaseUntil).toISOString()}`);
  if (Object.keys(t.labels).length) lines.push(`  labels:    ${Object.entries(t.labels).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  if (t.blockedBy.length) lines.push(`  blockedBy: ${t.blockedBy.join(", ")}`);
  if (t.body) lines.push("", t.body);
  if (t.result !== undefined) lines.push("", `result: ${JSON.stringify(t.result)}`);
  if (t.error) lines.push("", `error: ${t.error}`);
  return lines.join("\n");
}

function formatEvent(e: BoardEvent): string {
  const time = new Date(e.at).toISOString().slice(11, 19);
  const what = e.type === "message" ? (e.body ?? "") : `${e.type}${e.task ? ` ${e.task}` : ""}${e.body ? `: ${e.body}` : ""}`;
  const data = e.data !== undefined ? `  ${JSON.stringify(e.data)}` : "";
  return `#${e.seq} ${time} ${e.channel} ${e.actor}: ${what}${data}`;
}
