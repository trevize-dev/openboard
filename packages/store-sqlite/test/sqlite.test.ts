import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConformance } from "@trevize-dev/openboard-core/conformance";
import { SqliteStore } from "../src/index.js";

runConformance("sqlite (in-memory)", () => ({ store: new SqliteStore(":memory:") }));

runConformance("sqlite (file, WAL)", () => {
  const dir = mkdtempSync(join(tmpdir(), "openboard-"));
  return {
    store: new SqliteStore(join(dir, "board.db")),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
});
