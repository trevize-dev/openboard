const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

let lastTime = 0;
let lastRandom: number[] = [];

/** Monotonic ULID: sortable by creation time, unique within a process even in the same ms. */
export function ulid(now: number = Date.now()): string {
  let random: number[];
  if (now <= lastTime && lastRandom.length) {
    now = lastTime;
    random = increment(lastRandom);
  } else {
    random = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b % 32);
  }
  lastTime = now;
  lastRandom = random;

  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + random.map((n) => ALPHABET[n]).join("");
}

function increment(digits: number[]): number[] {
  const out = digits.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]! < 31) {
      out[i]!++;
      return out;
    }
    out[i] = 0;
  }
  return out;
}

export function newId(prefix: "evt" | "tsk"): string {
  return `${prefix}_${ulid()}`;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const LABEL_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SCHEMA_ID = /^[a-z0-9][a-z0-9._-]{0,63}@[1-9][0-9]{0,5}$/;

export const isName = (s: unknown): s is string => typeof s === "string" && NAME.test(s);
export const isLabelKey = (s: unknown): s is string => typeof s === "string" && LABEL_KEY.test(s);
export const isSchemaId = (s: unknown): s is string => typeof s === "string" && SCHEMA_ID.test(s);
