import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStore, Openboard } from "@trevize-dev/openboard-core";
import { serve } from "@trevize-dev/openboard-server/node";
import { OpenboardClient } from "@trevize-dev/openboard-sdk";
import { EXIT, main, type Io } from "../src/cli.js";

let server: { url: string; close: () => Promise<void> };
const tokens = { "tok-lead": "lead", "tok-a": "agent-a", "tok-b": "agent-b" };

beforeAll(async () => {
  server = await serve(new Openboard(new MemoryStore(), { pollIntervalMs: 20 }), { port: 0, tokens });
});
afterAll(() => server.close());

async function ob(token: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    readStdin: async () => "from stdin",
    tty: false,
    env: { OPENBOARD_URL: server.url, OPENBOARD_TOKEN: token, OPENBOARD_BOARD: "cli-test" },
  };
  const code = await main(argv, io);
  const last = out.at(-1);
  return { code, json: last ? JSON.parse(last) : undefined, out, err };
}

describe("ob CLI against a live server", () => {
  it("runs the whole task lifecycle", async () => {
    const fix = await ob("tok-lead", "tasks", "create", "bugs", "Fix", "login", "redirect", "--label", "kind=bug", "--priority", "5");
    expect(fix.code).toBe(EXIT.ok);
    expect(fix.json.task).toMatchObject({ title: "Fix login redirect", labels: { kind: "bug" }, status: "open", createdBy: "lead" });

    const review = await ob("tok-lead", "tasks", "create", "bugs", "Review fix", "--blocked-by", fix.json.task.id);
    expect(review.json.task.blockedBy).toEqual([fix.json.task.id]);

    const ready = await ob("tok-a", "tasks", "list", "--ready");
    expect(ready.json.tasks.map((t: { id: string }) => t.id)).toEqual([fix.json.task.id]);

    const claimA = await ob("tok-a", "tasks", "claim", "--ready", "--label", "kind=bug", "--lease", "2m");
    expect(claimA.json.task).toMatchObject({ id: fix.json.task.id, owner: "agent-a", attempt: 1 });

    const claimB = await ob("tok-b", "tasks", "claim");
    expect(claimB.code).toBe(EXIT.empty);
    expect(claimB.json).toEqual({ task: null });

    const stolen = await ob("tok-b", "tasks", "complete", fix.json.task.id);
    expect(stolen.code).toBe(EXIT.error);
    expect(stolen.err.join("\n")).toMatch(/claimed by agent-a/);

    await ob("tok-a", "post", "bugs", "found it: stale cookie", "--thread", fix.json.task.thread);
    const done = await ob("tok-a", "tasks", "complete", fix.json.task.id, "--result", '{"pr":42}');
    expect(done.json.task).toMatchObject({ status: "done", result: { pr: 42 } });

    const next = await ob("tok-b", "tasks", "claim", "--wait", "1s");
    expect(next.json.task.id).toBe(review.json.task.id);

    const thread = await ob("tok-lead", "events", "--thread", fix.json.task.thread);
    expect(thread.json.events.map((e: { type: string }) => e.type)).toEqual([
      "task.created",
      "task.claimed",
      "message",
      "task.completed",
    ]);
  });

  it("validates structured posts against schemas", async () => {
    const schema = JSON.stringify({ type: "object", required: ["severity"], properties: { severity: { enum: ["low", "high"] } } });
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const file = join(mkdtempSync(join(tmpdir(), "ob-")), "finding.json");
    writeFileSync(file, schema);

    expect((await ob("tok-lead", "schema", "put", "finding@1", file)).code).toBe(EXIT.ok);
    const ok = await ob("tok-a", "post", "security", "-", "--schema", "finding@1", "--data", '{"severity":"high"}');
    expect(ok.json.event).toMatchObject({ body: "from stdin", data: { severity: "high" } });
    const bad = await ob("tok-a", "post", "security", "x", "--schema", "finding@1", "--data", '{"severity":"meh"}');
    expect(bad.code).toBe(EXIT.error);
    expect(bad.err[0]).toMatch(/schema_invalid/);
  });

  it("rejects bad tokens and bad usage", async () => {
    expect((await ob("nope", "whoami")).code).toBe(EXIT.error);
    expect((await ob("tok-a", "whoami")).json).toEqual({ actor: "agent-a", board: "cli-test" });
    expect((await ob("tok-a", "tasks", "frobnicate")).code).toBe(EXIT.usage);
    expect((await ob("tok-a", "tasks", "claim", "--bogus")).code).toBe(EXIT.usage);
  });

  it("SDK follow() streams new events, and work() renews and completes", async () => {
    const client = new OpenboardClient({ url: server.url, token: "tok-lead", board: "sdk-test" });
    const ctrl = new AbortController();
    const seen: string[] = [];
    const following = (async () => {
      for await (const ev of client.follow({ channel: "general" }, ctrl.signal)) {
        seen.push(ev.body ?? "");
        if (seen.length === 2) ctrl.abort();
      }
    })();
    await new Promise((r) => setTimeout(r, 50));
    await client.post({ channel: "general", body: "one" });
    await client.post({ channel: "other", body: "skip me" });
    await client.post({ channel: "general", body: "two" });
    await following;
    expect(seen).toEqual(["one", "two"]);

    const worker = client.board("sdk-test");
    await worker.createTask({ channel: "work", title: "slow job" });
    const task = await worker.claim({ leaseMs: 1_500 });
    const done = await worker.work(task!, async () => {
      await new Promise((r) => setTimeout(r, 2_000)); // longer than the lease: renewals must keep it
      return "ok";
    });
    expect(done).toMatchObject({ status: "done", result: "ok", attempt: 1 });
  });
});
