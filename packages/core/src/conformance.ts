/**
 * Adapter conformance suite. Every Store implementation must pass it:
 *
 *   import { runConformance } from "@trevize-dev/openboard-core/conformance";
 *   runConformance("sqlite", async () => ({ store: new SqliteStore(":memory:") }));
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Openboard } from "./board.js";
import { BoardError } from "./errors.js";
import { newId } from "./ids.js";
import type { NewEvent, Store, Task } from "./types.js";

export interface ConformanceTarget {
  store: Store;
  cleanup?: () => Promise<void> | void;
}

export function runConformance(name: string, factory: () => Promise<ConformanceTarget> | ConformanceTarget) {
  describe(`Store conformance: ${name}`, () => {
    let target: ConformanceTarget;
    let store: Store;
    let now: number;
    const clock = () => now;
    const board = () => `b-${Math.random().toString(36).slice(2, 10)}`;
    const ob = () => new Openboard(store, { clock, pollIntervalMs: 10 });

    beforeEach(async () => {
      target = await factory();
      store = target.store;
      now = 1_700_000_000_000;
    });
    afterEach(async () => {
      await store.close?.();
      await target.cleanup?.();
    });

    // ------------------------------------------------------------ raw store

    describe("events", () => {
      it("assigns gap-free seqs starting at 1 under concurrent appends", async () => {
        const b = board();
        const results = await Promise.all(Array.from({ length: 200 }, (_, i) => store.append(b, ev(`m${i}`))));
        const seqs = results.map((r) => r.seq).sort((x, y) => x - y);
        expect(seqs).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
        expect(await store.head(b)).toBe(200);
      });

      it("keeps boards independent", async () => {
        const [a, c] = [board(), board()];
        await store.append(a, ev("x"));
        await store.append(a, ev("y"));
        const first = await store.append(c, ev("z"));
        expect(first.seq).toBe(1);
        expect(await store.head(a)).toBe(2);
        expect(await store.head(board())).toBe(0);
      });

      it("reads in seq order with after, limit, channel and thread filters", async () => {
        const b = board();
        for (let i = 0; i < 10; i++) {
          await store.append(b, ev(`m${i}`, { channel: i % 2 ? "odd" : "even", thread: i < 5 ? "t1" : "t2" }));
        }
        const all = await store.readEvents(b, {});
        expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        expect((await store.readEvents(b, { after: 7 })).map((e) => e.seq)).toEqual([8, 9, 10]);
        expect((await store.readEvents(b, { limit: 3 })).map((e) => e.seq)).toEqual([1, 2, 3]);
        expect((await store.readEvents(b, { channel: "odd" })).map((e) => e.seq)).toEqual([2, 4, 6, 8, 10]);
        expect((await store.readEvents(b, { thread: "t2", channel: "even", after: 5 })).map((e) => e.seq)).toEqual([7, 9]);
      });

      it("round-trips every field", async () => {
        const b = board();
        const input = ev("hello", { data: { n: 1, nested: { ok: true } }, schema: "x@1", labels: { kind: "bug" }, task: "tsk_1" });
        const out = await store.append(b, input);
        const [read] = await store.readEvents(b, {});
        expect(read).toEqual({ ...input, board: b, seq: 1 });
        expect(out).toEqual(read);
      });
    });

    describe("tasks", () => {
      it("insertTask is insert-if-absent", async () => {
        const b = board();
        const t = task(b);
        expect(await store.insertTask(t)).toBe(true);
        expect(await store.insertTask({ ...t, title: "other" })).toBe(false);
        expect((await store.getTask(b, t.id))?.title).toBe(t.title);
        expect(await store.getTask(b, "tsk_missing")).toBeNull();
      });

      it("casTask only succeeds against the current version", async () => {
        const b = board();
        const t = task(b);
        await store.insertTask(t);
        expect(await store.casTask({ ...t, title: "v2", version: 2 }, 1)).toBe(true);
        expect(await store.casTask({ ...t, title: "stale", version: 2 }, 1)).toBe(false);
        expect(await store.casTask({ ...t, title: "skip", version: 4 }, 2)).toBe(false);
        expect(await store.casTask({ ...t, id: "tsk_nope", version: 2 }, 1)).toBe(false);
        expect((await store.getTask(b, t.id))?.title).toBe("v2");
      });

      it("concurrent casTask on one version has exactly one winner", async () => {
        const b = board();
        const t = task(b);
        await store.insertTask(t);
        const wins = await Promise.all(
          Array.from({ length: 30 }, (_, i) => store.casTask({ ...t, owner: `a${i}`, version: 2 }, 1)),
        );
        expect(wins.filter(Boolean)).toHaveLength(1);
      });

      it("findTasks filters by status, channel, labels and claimability, in priority order", async () => {
        const b = board();
        const mk = (o: Partial<Task>) => store.insertTask(task(b, o));
        await mk({ id: "t1", priority: 0, createdAt: 1 });
        await mk({ id: "t2", priority: 5, createdAt: 2, labels: { kind: "bug" } });
        await mk({ id: "t3", priority: 5, createdAt: 1, channel: "other" });
        await mk({ id: "t4", status: "claimed", leaseUntil: 100, createdAt: 3 });
        await mk({ id: "t5", status: "claimed", leaseUntil: 1000, createdAt: 4 });
        await mk({ id: "t6", status: "done", createdAt: 5 });

        const ids = async (q: Parameters<Store["findTasks"]>[1]) => (await store.findTasks(b, q)).map((t) => t.id);
        expect(await ids({})).toEqual(["t3", "t2", "t1", "t4", "t5", "t6"]);
        expect(await ids({ status: ["open"] })).toEqual(["t3", "t2", "t1"]);
        expect(await ids({ status: ["claimed", "done"] })).toEqual(["t4", "t5", "t6"]);
        expect(await ids({ channel: "other" })).toEqual(["t3"]);
        expect(await ids({ labels: { kind: "bug" } })).toEqual(["t2"]);
        expect(await ids({ labels: { kind: "feature" } })).toEqual([]);
        expect(await ids({ claimableAt: 500 })).toEqual(["t3", "t2", "t1", "t4"]);
        expect(await ids({ claimableAt: 500, channel: "work" })).toEqual(["t2", "t1", "t4"]);
        expect(await ids({ limit: 2 })).toEqual(["t3", "t2"]);
        expect((await store.getTasks(b, ["t6", "nope", "t1"])).map((t) => t.id).sort()).toEqual(["t1", "t6"]);
      });

      it("round-trips every field and drops none", async () => {
        const b = board();
        const t = task(b, { body: "details", owner: "x", leaseUntil: 9, result: { pr: 12 }, error: "e", blockedBy: ["a", "b"] });
        await store.insertTask(t);
        expect(await store.getTask(b, t.id)).toEqual(t);
      });
    });

    describe("docs", () => {
      it("putDocIfAbsent never overwrites", async () => {
        const b = board();
        expect(await store.putDocIfAbsent(b, "schema:x@1", { a: 1 })).toBe(true);
        expect(await store.putDocIfAbsent(b, "schema:x@1", { a: 2 })).toBe(false);
        expect(await store.getDoc(b, "schema:x@1")).toEqual({ a: 1 });
        expect(await store.getDoc(b, "nope")).toBeNull();
      });
    });

    // ------------------------------------------------------------ through the Board core

    describe("board semantics", () => {
      it("50 agents racing for 10 tasks: every task claimed exactly once", async () => {
        const bd = ob().board(board());
        for (let i = 0; i < 10; i++) await bd.createTask("lead", { channel: "work", title: `task ${i}` });
        const claims = await Promise.all(Array.from({ length: 50 }, (_, i) => bd.claim(`agent-${i}`)));
        const won = claims.filter((t): t is Task => t !== null);
        expect(won).toHaveLength(10);
        expect(new Set(won.map((t) => t.id)).size).toBe(10);
        const claimedEvents = (await bd.events({ limit: 1000 })).filter((e) => e.type === "task.claimed");
        expect(claimedEvents).toHaveLength(10);
      });

      it("expired leases are reclaimed, and the old owner loses the task", async () => {
        const bd = ob().board(board());
        const t = await bd.createTask("lead", { channel: "work", title: "slow" });
        const first = await bd.claim("a", { leaseMs: 1_000 });
        expect(first?.id).toBe(t.id);
        expect(await bd.claim("b")).toBeNull();

        now += 1_001;
        const second = await bd.claim("b", { leaseMs: 1_000 });
        expect(second).toMatchObject({ id: t.id, owner: "b", attempt: 2 });

        await expect(bd.renew("a", t.id)).rejects.toMatchObject({ code: "conflict" });
        await expect(bd.complete("a", t.id)).rejects.toMatchObject({ code: "conflict" });
        const renewed = await bd.renew("b", t.id, 5_000);
        expect(renewed.leaseUntil).toBe(now + 5_000);
        const done = await bd.complete("b", t.id, { pr: 7 });
        expect(done).toMatchObject({ status: "done", result: { pr: 7 } });
      });

      it("dependencies hold a task back until its blockers are done", async () => {
        const bd = ob().board(board());
        const fix = await bd.createTask("lead", { channel: "work", title: "fix" });
        const review = await bd.createTask("lead", { channel: "work", title: "review", blockedBy: [fix.id], priority: 10 });

        expect((await bd.tasks({ ready: true })).map((t) => t.id)).toEqual([fix.id]);
        expect((await bd.claim("a"))?.id).toBe(fix.id);
        expect(await bd.claim("b")).toBeNull();
        await bd.complete("a", fix.id);
        expect((await bd.claim("b"))?.id).toBe(review.id);
      });

      it("a waiting claim wakes up when a task appears", async () => {
        const bd = new Openboard(store, { pollIntervalMs: 25 }).board(board());
        const waiting = bd.claim("worker", { waitMs: 3_000, labels: { kind: "bug" } });
        await sleep(50);
        await bd.createTask("lead", { channel: "work", title: "not a bug", labels: { kind: "chore" } });
        await bd.createTask("lead", { channel: "work", title: "bug", labels: { kind: "bug" } });
        expect((await waiting)?.title).toBe("bug");
      });

      it("fail with retry reopens; fail without retry is terminal", async () => {
        const bd = ob().board(board());
        const t = await bd.createTask("lead", { channel: "work", title: "flaky" });
        await bd.claim("a");
        expect(await bd.fail("a", t.id, { reason: "CI timeout", retry: true })).toMatchObject({ status: "open", error: "CI timeout" });
        expect((await bd.claim("b"))?.attempt).toBe(2);
        expect(await bd.fail("b", t.id, { reason: "broken" })).toMatchObject({ status: "failed" });
        expect(await bd.claim("c")).toBeNull();
      });

      it("structured data is validated against registered schemas, which are immutable", async () => {
        const bd = ob().board(board());
        const schema = {
          type: "object",
          required: ["severity", "file"],
          properties: { severity: { enum: ["low", "high"] }, file: { type: "string" } },
        };
        await bd.registerSchema("lead", "finding@1", schema);
        await bd.registerSchema("lead", "finding@1", schema); // idempotent
        await expect(bd.registerSchema("lead", "finding@1", { type: "string" })).rejects.toMatchObject({ code: "conflict" });

        const ok = await bd.post("a", { channel: "security", data: { severity: "high", file: "a.ts" }, schema: "finding@1" });
        expect(ok.schema).toBe("finding@1");
        const bad = bd.post("a", { channel: "security", data: { severity: "meh" }, schema: "finding@1" });
        await expect(bad).rejects.toBeInstanceOf(BoardError);
        await expect(bad).rejects.toMatchObject({ code: "schema_invalid" });
        await expect(bd.post("a", { channel: "security", data: {}, schema: "nope@1" })).rejects.toMatchObject({ code: "not_found" });
      });

      it("threads collect a task's whole history in order", async () => {
        const bd = ob().board(board());
        const t = await bd.createTask("lead", { channel: "work", title: "fix login" });
        await bd.claim("a");
        await bd.post("a", { channel: "work", thread: t.thread, body: "root cause found" });
        await bd.complete("a", t.id, "PR #42");
        await bd.post("lead", { channel: "work", body: "unrelated" });
        const thread = await bd.events({ thread: t.thread });
        expect(thread.map((e) => e.type)).toEqual(["task.created", "task.claimed", "message", "task.completed"]);
      });

      it("waitForEvents long-polls until something arrives", async () => {
        const bd = new Openboard(store, { pollIntervalMs: 25 }).board(board());
        const head = await bd.head();
        const pending = bd.waitForEvents({ after: head }, 3_000);
        await sleep(40);
        await bd.post("a", { channel: "general", body: "hi" });
        const got = await pending;
        expect(got.map((e) => e.body)).toEqual(["hi"]);
      });
    });
  });
}

function ev(body: string, extra: Partial<NewEvent> = {}): NewEvent {
  return { id: newId("evt"), type: "message", channel: "general", thread: "t", actor: "tester", at: 1, body, ...extra };
}

function task(board: string, extra: Partial<Task> = {}): Task {
  return {
    id: newId("tsk"),
    board,
    channel: "work",
    thread: "th",
    title: "a task",
    status: "open",
    labels: {},
    blockedBy: [],
    priority: 0,
    attempt: 0,
    createdBy: "tester",
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    ...extra,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
