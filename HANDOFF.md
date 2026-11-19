# openboard: handoff

This file is for whoever (person or agent) picks up openboard after v0.1. It lists what is
left, in the order to build it, with the design decided so far and what "done" means for each.

Read `README.md` first for what exists, and `AGENTS.md` for the rules every change follows.

## Where things stand (v0.1, commit `acf8ae4`)

Built and tested (60 tests, `pnpm test`):

- `packages/core`: model (`types.ts`), `Openboard`/`Board` service (`board.ts`), `MemoryStore`,
  reference query semantics (`query.ts`), schemas (`schemas.ts`), conformance suite (`conformance.ts`).
- `packages/store-sqlite`: `node:sqlite` adapter, safe across processes.
- `packages/server`: Hono app (`createApp(ob).fetch`) + `serve()` for Node. Bearer tokens → actor.
- `packages/sdk`: `OpenboardClient` incl. `follow()` (long-poll) and `work()` (auto-renew).
- `packages/cli`: `ob` / `openboard`.
- `skills/openboard/SKILL.md`: agent instructions for the CLI.

Not built: everything below.

## Order of work

| # | Feature | Why this order | Size |
|---|---|---|---|
| 1 | CI + release | Everything after this lands through PRs with tests | S |
| 2 | Store port v2: mutable docs, atomic task+event | Grants, watchers and schedules all need it | M |
| 3 | Grants | Required before anyone exposes a server beyond localhost | M |
| 4 | Unblocked index (fix claim scan limit) | Correctness at scale | S |
| 5 | Scheduled follow-ups (`ob schedule`) | Small, reuses task claiming | S |
| 6 | Watchers / webhooks | Basis for sync and integrations | M |
| 7 | Postgres adapter | First production backend | M |
| 8 | Inspect viewer (`ob inspect`) | Visibility for humans | M |
| 9 | Durable Objects adapter + Worker deploy | Serverless option | L |
| 10 | Slack / GitHub sync | Built on watchers | L |
| 11 | turbopuffer search sidecar | Built on the event log | M |

Items 7, 8 and 11 are independent of each other once 2 is in and can run in parallel.

---

## 1. CI and release

- `.github/workflows/ci.yml`: on PR and push to `main`, Node 22 and 24, `pnpm install --frozen-lockfile`,
  `pnpm build`, `pnpm test`.
- Releases with Changesets (`@changesets/cli`): `pnpm changeset` per PR, a release workflow that
  versions and runs `pnpm -r publish --access public --provenance` with `NPM_TOKEN`.
- Before the first publish, `pnpm publish` must rewrite `workspace:*` to real versions (pnpm does
  this automatically) and each package needs `"publishConfig": { "access": "public" }`.

**Done when:** a PR shows green checks, and merging a changeset publishes all five packages to npm.

## 2. Store port v2

Two additions to `Store` in `packages/core/src/types.ts`. Both must get conformance tests, and
both existing adapters must pass them before anything builds on them.

**a. Mutable docs with versions** (grants, watcher cursors and configs need updates, not just insert-once):

```ts
getDocV(board: string, key: string): Promise<{ value: unknown; version: number } | null>;
/** expectVersion 0 = must not exist. Returns the new version, or null on mismatch. */
casDoc(board: string, key: string, value: unknown, expectVersion: number): Promise<number | null>;
listDocs(board: string, prefix: string, limit?: number): Promise<{ key: string; value: unknown; version: number }[]>;
deleteDoc(board: string, key: string, expectVersion: number): Promise<boolean>;
```

Keep `putDocIfAbsent` and `getDoc` (schemas use them); implement them on top of the new methods.

**b. Atomic task change + event**, closing the known gap where a crash between `casTask` and
`append` loses the event:

```ts
/** Optional. CAS the task and append the event in one transaction. */
casTaskAndAppend?(next: Task, expectVersion: number, event: NewEvent): Promise<BoardEvent | null>;
```

In `Board.transition()`, `claim()` and `createTask()`, use it when present; otherwise keep the
current two-step path. Memory and SQLite implement it (SQLite: `BEGIN IMMEDIATE … COMMIT`).
Set `capabilities.transactions` accordingly.

**Done when:** new conformance cases pass for memory and both SQLite targets, including a
30-way concurrent `casDoc` race with exactly one winner.

## 3. Grants

Access control by path and principal, enforced in the server, never in adapters.

- **Principals:** `user:<actor>`, `everyone`, and later `project:<id>/<env>` for deploy-scoped tokens.
- **Paths:** `<board>/<channel>` with `*` wildcards: `security/*`, `*/prs`, `*`.
- **Levels:** `none < read < post < all`. `read` = events, tasks list/get. `post` = post, create,
  claim, renew, complete/fail own tasks. `all` = cancel others' tasks, schemas, grants.
- **Resolution:** most specific path wins; at equal specificity `user:` beats `everyone`; an explicit
  `none` beats everything at its specificity. No grant at all = `none`, except a bootstrap admin
  set by `OPENBOARD_ADMINS="lead,ops"`.
- **Storage:** docs under key `grant:<principal>:<path>` on a reserved board `_system`.
  (Relax `isName` to allow a leading underscore only for `_system`.)
- **Server:** a middleware computes the level for (actor, board, channel) per route. Channel comes
  from the body (post, create), the task (task actions) or the query (events, list). `GET /events`
  without a channel filters the result to readable channels.
- **CLI:** `ob grants set <principal> <path> <level>`, `ob grants list`, `ob grants explain <actor> <path>`
  (prints the winning grant and why), `ob grants revoke <principal> <path>`. Each change is an event
  on channel `system` so it lands in the audit log.

**Done when:** a server test covers every level against every route, `grants explain` output is
asserted, and a non-admin can't grant themselves anything.

## 4. Unblocked index

Today a claim scans the top 200 claimable tasks and filters out blocked ones in the core. With
many blocked tasks ahead, ready ones further down are never seen.

- Add `blockedCount: number` to `Task` (number of `blockedBy` tasks not yet `done`), set at create.
- When a task becomes `done`, the core decrements `blockedCount` on its dependents (CAS loop each).
  Dependents are found with a new `TaskQuery.blockedBy?: string` filter (adapters: JSON array
  contains; SQLite `EXISTS (SELECT 1 FROM json_each(doc, '$.blockedBy') WHERE value = ?)`).
- `TaskQuery.claimableAt` additionally requires `blockedCount = 0`. Store it as its own column/index
  in SQL adapters.
- Keep the existing dependency check in `claim()` as a safety net (a crash between completing a
  task and updating dependents must never let a blocked task through).
- Add a repair path: `ob tasks reindex` recomputes `blockedCount` for open tasks.

**Done when:** a conformance case with 500 blocked tasks ahead of 1 ready task claims the ready one.

## 5. Scheduled follow-ups

`ob schedule --in 5m --channel prs --thread <t> "check CI on PR 42"` and `--at 2026-12-01T09:00Z`.
Matches Vercel Board's `schedule`, including `--no-sync`.

- Model a schedule as a task on channel `system` with label `kind=schedule` and a new field
  `notBefore` (epoch ms). Add `notBefore` to the claimability rule: `notBefore` unset or `<= now`.
- A scheduler loop in the server process claims due schedules (`labels: {kind: "schedule"}`),
  posts the message into the target channel/thread as the original actor (stored in the task body
  as JSON), then completes the schedule task. Several server processes are safe: claiming is CAS.
- `--no-sync` sets label `sync=false` on the resulting message; sync (item 10) skips those.
- `ob schedule list`, `ob schedule cancel <id>`.

**Done when:** a test with an injected clock fires a schedule exactly once with two schedulers running.

## 6. Watchers and webhooks

Run code when a matching event is appended. Delivery is at-least-once, in seq order per watcher.

- **Config:** doc `watcher:<id>` = `{ url, secret, filter: { channels?, types?, labels? }, cursor, status }`.
- **Dispatcher:** one loop per server process per board; it takes a lease on each watcher (reuse
  `casDoc` on a `leaseUntil` field so only one process delivers for a watcher), reads events after
  `cursor`, POSTs matching ones, and advances `cursor` with `casDoc` after a 2xx.
- **Request:** `POST url` with JSON `{ board, event }`, headers `openboard-signature:
  t=<ts>,v1=<hex hmac-sha256(secret, ts + "." + body)>`, `openboard-delivery: <event id>`.
  Retry with exponential backoff (1s → 5 min), mark `status: "failing"` after 24h, keep the cursor.
- **SDK receiver,** mirroring Vercel's `board()` factory: `createWatcher({ secret, onEvent })`
  returns a `(Request) => Promise<Response>` that verifies the signature and timestamp (5-min window)
  and dedupes by delivery id if the caller provides a store.
- **CLI:** `ob watch add <url> [--channel] [--type] [--label]` (prints the secret once),
  `ob watch list`, `ob watch rm <id>`, `ob watch replay <id> --from <seq>`.

**Done when:** a test kills the dispatcher mid-batch and the receiver still sees every event, in order,
with duplicates only around the crash point.

## 7. Postgres adapter (`packages/store-postgres`)

- Driver: `postgres` (porsager). Tests: run the conformance suite against **PGlite**
  (`@electric-sql/pglite`, in-process, no Docker) and, in CI only, a real Postgres service container.
- Tables mirror SQLite. Seq: `boards(board PRIMARY KEY, head BIGINT)`; append is one transaction:
  `INSERT … ON CONFLICT DO UPDATE SET head = boards.head + 1 RETURNING head`, then insert the event.
- `casTask`: `UPDATE … WHERE board=$1 AND id=$2 AND version=$3`. Labels: `jsonb` with a GIN index,
  filter with `labels @> $1::jsonb`.
- `subscribe`: `LISTEN openboard_<hash(board)>`, `pg_notify` inside the append transaction.
  Cap one LISTEN connection per process, fan out in memory.
- `casTaskAndAppend`: one transaction.

**Done when:** conformance passes on PGlite and on Postgres 16 in CI, and `ob serve --store postgres://…` works.

## 8. Inspect viewer (`ob inspect`)

A read-only web UI like `npx @vercel/board inspect`.

- Server: `GET /v1/boards/:board/channels` (keep a `channel:<name>` doc with counts and last seq,
  upserted on append via `casDoc`) and serve a static bundle at `/inspect`.
- UI: channel list → thread list → thread timeline, tasks panel with status/owner/lease countdown,
  live via the existing long-poll endpoint. Plain TS + one CSS file; no framework needed. Lives in
  `packages/inspect`, built to static files the server package embeds.
- `ob inspect` opens the browser at `<url>/inspect?board=<board>&token=…` (token kept in
  sessionStorage, stripped from the URL on load).

**Done when:** events posted from the CLI appear in the open UI within a second.

## 9. Durable Objects adapter + Worker (`packages/store-durable-objects`)

- One Durable Object per board (`idFromName(board)`), SQLite-backed storage, same schema as the
  SQLite adapter, executed with `ctx.storage.sql`. Each Store method is an RPC method on the DO, so
  every operation is serialized per board for free and `casTaskAndAppend` is trivially atomic.
- `subscribe` is not available across Workers; leave `capabilities.notify = false` and rely on
  polling, or later add hibernating WebSockets for the long-poll endpoint.
- Schedules (item 5) can use DO alarms instead of the polling loop: set an alarm for the earliest
  `notBefore`.
- A `worker` template: `export default { fetch: createApp(new Openboard(doStore)).fetch }`.
  The server package must stay free of Node-only imports (only `server/src/node.ts` may use them).
- Tests: conformance under `@cloudflare/vitest-pool-workers`.

**Done when:** conformance passes in the Workers pool and the template deploys with `wrangler deploy`.

## 10. Slack and GitHub sync (`packages/sync`)

Two-way, like Vercel Board's connectors. Build each as a watcher (outbound) plus an inbound webhook route.

- **Mapping config** (doc `sync:<id>`): Slack channel ↔ board channel; GitHub repo + kind
  (`pulls`, `issues`) ↔ board channel. Thread mapping: Slack `thread_ts` ↔ board thread; GitHub
  issue/PR number ↔ board thread.
- **Loop prevention:** every event created from an inbound webhook gets label `origin=slack|github`
  and the external id; outbound skips events with `origin` equal to its own target, and skips
  `sync=false`.
- **Mirrors:** new messages, replies, edits and deletes (requires adding `message.edited` and
  `message.deleted` event types to core), and reactions (as `reaction` events, mapped to Slack
  reactions / GitHub reactions).
- GitHub: GitHub App with webhook secret; verify `x-hub-signature-256`. Slack: Events API with
  signing secret; post via `chat.postMessage` with `thread_ts`.

**Done when:** a message posted in Slack appears on the board and a reply on the board appears in
the same Slack thread, with no echo.

## 11. turbopuffer search sidecar (`packages/search-turbopuffer`)

- A watcher-style consumer (item 6) that upserts each message and task event into namespace
  `openboard-<board>`: id = event id, attributes `channel`, `thread`, `type`, `actor`, `labels`
  (as `label.<k>` attributes), `at`, `body` with `full_text_search: true`, plus an embedding of
  `body` (turbopuffer native embedding or your own model).
- Keep its cursor in a doc, advanced after each successful upsert batch.
- Query: `GET /v1/boards/:board/search?q=…&channel=…` → hybrid query (BM25 + ANN) as a multi-query
  with RRF, filtered by channel/labels, then re-checked against grants (item 3).
- CLI: `ob search "login redirect" --channel bugs`.

**Done when:** a thread is findable by meaning ("auth bug after deploy") within 5s of posting.

---

## Smaller follow-ups

- `ob skill install`: copy `skills/openboard/SKILL.md` into the agent's skill folder, or support
  `npx skills add trevize-dev/openboard` (check that tool's expected layout).
- Event retention: `ob events compact --before <seq>` for boards with huge histories.
- `ob tasks watch <id>`: follow one task's thread until it ends.
- Rate limiting per token in the server.
- Upgrade the ExperimentalWarning filter in `cli/src/bin.ts` away once `node:sqlite` is stable.
