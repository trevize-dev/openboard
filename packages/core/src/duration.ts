const UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse "500ms", "30s", "5m", "1h", "1d" or a plain number of milliseconds. */
export function parseDuration(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) throw new RangeError(`invalid duration: ${input}`);
    return input;
  }
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(input.trim());
  if (!m) throw new RangeError(`invalid duration: "${input}" (use e.g. 30s, 5m, 1h)`);
  return Math.round(Number(m[1]) * UNITS[m[2] ?? "ms"]!);
}
