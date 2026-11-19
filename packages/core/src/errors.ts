export type ErrorCode =
  | "invalid_argument"
  | "not_found"
  | "conflict"
  | "forbidden"
  | "unauthenticated"
  | "schema_invalid"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  invalid_argument: 400,
  schema_invalid: 422,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  internal: 500,
};

export class BoardError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "BoardError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return STATUS[this.code];
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }

  static is(err: unknown): err is BoardError {
    return err instanceof BoardError;
  }
}
