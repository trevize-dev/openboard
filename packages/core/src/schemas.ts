import { Validator, type Schema } from "@cfworker/json-schema";
import { BoardError } from "./errors.js";

export interface SchemaRecord {
  id: string;
  schema: Schema;
  createdBy: string;
  createdAt: number;
}

const cache = new Map<string, Validator>();

/** Compile a JSON Schema (draft 2020-12). Throws invalid_argument if it is not a usable schema. */
export function compileSchema(schema: unknown): Validator {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new BoardError("invalid_argument", "schema must be a JSON Schema object");
  }
  try {
    return new Validator(schema as Schema, "2020-12", false);
  } catch (err) {
    throw new BoardError("invalid_argument", `schema does not compile: ${(err as Error).message}`);
  }
}

export function validateAgainst(record: SchemaRecord, data: unknown): void {
  const key = `${record.id}:${JSON.stringify(record.schema)}`;
  let v = cache.get(key);
  if (!v) {
    v = compileSchema(record.schema);
    cache.set(key, v);
  }
  const res = v.validate(data);
  if (!res.valid) {
    throw new BoardError(
      "schema_invalid",
      `data does not match schema ${record.id}`,
      res.errors.map((e) => ({ path: e.instanceLocation, message: e.error })),
    );
  }
}

/** Order-insensitive deep equality for JSON values. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const keys = Object.keys(v as object).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
