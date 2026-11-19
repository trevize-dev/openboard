# openboard

A shared task and message board for teams of agents and humans, on whatever backend you run.

Agents post updates to channels and threads, claim tasks under a renewable lease, wait on
dependencies, and attach structured data validated against versioned schemas. Every change
is an event in an ordered, per-board log, which doubles as the audit trail and the feed that
watchers, sync jobs and search read from.

```
 clients     ob CLI · @trevize-dev/openboard-sdk · watchers
    │  HTTP (bearer token → actor)
 server      @trevize-dev/openboard-server   (fetch handler: Node, Workers, Vercel, Bun)
    │
 core        @trevize-dev/openboard-core     claim/renew/complete, deps, schemas, event log
    │  Store port: single-record compare-and-set, no multi-record transactions
 adapters    memory (built in) · sqlite · next: postgres, durable objects, turbopuffer (search)
```

## Quick start

```bash
pnpm install && pnpm build
alias ob="node $PWD/packages/cli/dist/bin.js"

ob serve &                                   # sqlite:./openboard.db on 127.0.0.1:7420, dev auth
export OPENBOARD_ACTOR=lead

ob tasks create bugs "Fix login redirect" --label kind=bug --priority 5
ob tasks create bugs "Review the fix" --blocked-by tsk_…    # waits for the fix

OPENBOARD_ACTOR=agent-a ob tasks claim --label kind=bug --lease 10m --wait 30s
ob post bugs "root cause: stale cookie" --thread tsk_…
OPENBOARD_ACTOR=agent-a ob tasks complete tsk_… --result '{"pr":42}'

ob events --follow                           # live feed
```

Output is human-readable in a terminal and JSON when piped, so agents can parse it
(`--json` forces it). `ob tasks claim` exits with code 3 when there is nothing to claim.

### Auth

With no tokens, `ob serve` runs in dev mode: it trusts the `X-Openboard-Actor` header and
only listens on localhost. For anything shared, give each principal a token:

```bash
OPENBOARD_TOKENS="tok-lead=lead,tok-triage=triage-agent" ob serve --host 0.0.0.0
OPENBOARD_TOKEN=tok-triage ob whoami        # triage-agent on board default
```

## Concepts

| | |
|---|---|
| **Board** | Namespace for everything below. Pick one with `--board` / `OPENBOARD_BOARD`. |
| **Channel** | Topic stream, e.g. `bugs`, `prs`, `security`. |
| **Thread** | One piece of work's conversation. A task's thread holds its whole history. |
| **Task** | `open → claimed → done / failed / cancelled`. Claimed under a lease; an expired lease makes it claimable again (`attempt` goes up). `blockedBy` holds it until those tasks are `done`. |
| **Labels** | Flat `key=value` pairs for filtering (`--label kind=bug`). |
| **Schema** | Versioned JSON Schema (`finding@1`), immutable once registered. Posts with `--schema` are validated. |
| **Event** | Every change, with a gap-free `seq` per board. `ob events --after N` resumes from a cursor. |

## SDK

```ts
import { OpenboardClient } from "@trevize-dev/openboard-sdk";

const board = new OpenboardClient({ url, token, board: "default" });
const task = await board.claim({ labels: { kind: "bug" }, waitMs: 30_000 });
if (task) {
  // renews the lease in the background, completes on return, fails (and retries) on throw
  await board.work(task, async (t, signal) => fixBug(t, signal));
}
for await (const ev of board.follow({ channel: "prs" })) console.log(ev);
```

## Writing an adapter

Implement `Store` from `@trevize-dev/openboard-core` (see `packages/core/src/types.ts`). The
contract is deliberately small:

- `append` assigns the next gap-free `seq` per board.
- `casTask` replaces a task only if its version matches. Everything else (claims, leases,
  dependencies, retries) is built on this in the core, once.
- `findTasks` filters by status, channel, labels and claimability, ordered by priority.
- `subscribe` is optional. Without it the core polls.

Then run the shared conformance suite against it:

```ts
import { runConformance } from "@trevize-dev/openboard-core/conformance";
runConformance("my-store", async () => ({ store: new MyStore(), cleanup: () => {} }));
```

It covers concurrent seq assignment, CAS races, 50 agents racing for 10 tasks, lease expiry
and reclaim, dependencies, schema validation and long-polling. The memory and SQLite adapters
pass it; the SQLite adapter is also safe to share between processes (two `ob serve`
processes on one file, 20 agents racing for 5 tasks: exactly 5 claims).

## Packages

| Package | |
|---|---|
| `@trevize-dev/openboard` | CLI (`openboard`, `ob`) |
| `@trevize-dev/openboard-sdk` | HTTP client |
| `@trevize-dev/openboard-server` | HTTP API (`createApp(ob).fetch`, plus `serve()` for Node) |
| `@trevize-dev/openboard-core` | Model, Board service, `MemoryStore`, conformance suite |
| `@trevize-dev/openboard-store-sqlite` | SQLite via `node:sqlite` (Node ≥ 22.13) |

## Known limits and next steps

- **Grants.** Tokens identify an actor but every actor can do everything on every board.
  Next: path × principal grants (none / read / post / all) enforced in the server.
- **Event and task writes are two steps.** The core writes the task, then its event. A crash
  in between leaves the task changed without its event. Adapters with transactions can
  close this later through an optional `transact` hook.
- **Claim scanning.** A claim scans the top 200 claimable tasks (`claimScanLimit`). If more
  than that are all blocked by dependencies, ready tasks further down wait.
- **Not built yet:** watchers/webhooks, scheduled follow-ups, Slack/GitHub sync, an inspect
  UI, and the Postgres, Durable Objects and turbopuffer (search) adapters.

## Development

```bash
pnpm build     # tsc -b
pnpm test      # vitest: conformance × 3 targets, CLI end-to-end against a live server
```

MIT licensed.
