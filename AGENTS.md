# Working on openboard

See `HANDOFF.md` for what to build next and `README.md` for what exists.

## Rules

- **The Store port only ever requires single-record atomicity.** Never add a required Store method
  that needs a transaction across records. Optional capabilities (like `casTaskAndAppend`) are fine
  if the core has a fallback.
- **Every Store change ships with conformance tests** in `packages/core/src/conformance.ts`, and
  every adapter must pass them. Adapter-specific tests are extra, not a substitute.
- **Business logic lives in the core** (`packages/core/src/board.ts`), written once. Adapters
  store and fetch; the server authenticates, authorizes and translates HTTP; the CLI formats.
- **`packages/server/src/index.ts` stays runtime-neutral**: no `node:` imports, so it runs on
  Workers, Vercel and Bun. Node-only code goes in `server/src/node.ts`.
- **CLI JSON output is an API.** Agents parse it. Add fields freely; don't rename or remove them.
  Exit codes: 0 ok, 1 error, 2 usage, 3 nothing to claim.
- **Errors** are `BoardError` with a code from `core/src/errors.ts`; the server maps codes to HTTP statuses.

## Commands

```bash
pnpm install
pnpm build          # tsc -b, all packages
pnpm test           # vitest; tests import package sources via the "source" export condition
node packages/cli/dist/bin.js serve --store memory
```

Node ≥ 22.13 (for `node:sqlite`).
