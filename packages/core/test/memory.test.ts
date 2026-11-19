import { describe, expect, it } from "vitest";
import { runConformance } from "../src/conformance.js";
import { MemoryStore, parseDuration, ulid } from "../src/index.js";

runConformance("memory", () => ({ store: new MemoryStore() }));

describe("helpers", () => {
  it("parses durations", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("1.5h")).toBe(5_400_000);
    expect(parseDuration("250")).toBe(250);
    expect(() => parseDuration("soon")).toThrow();
  });

  it("generates sortable, unique ULIDs within the same millisecond", () => {
    const ids = Array.from({ length: 1000 }, () => ulid(1_700_000_000_000));
    expect(new Set(ids).size).toBe(1000);
    expect([...ids].sort()).toEqual(ids);
  });
});
