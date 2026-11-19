import type { BoardEvent, EventQuery, Task, TaskQuery } from "./types.js";

/** Reference semantics for TaskQuery. Adapters that filter in their database must agree with this. */
export function matchesTaskQuery(t: Task, q: TaskQuery): boolean {
  if (q.channel !== undefined && t.channel !== q.channel) return false;
  if (q.labels) {
    for (const [k, v] of Object.entries(q.labels)) if (t.labels[k] !== v) return false;
  }
  if (q.claimableAt !== undefined) {
    return t.status === "open" || (t.status === "claimed" && (t.leaseUntil ?? 0) < q.claimableAt);
  }
  if (q.status?.length && !q.status.includes(t.status)) return false;
  return true;
}

/** Priority descending, then createdAt ascending, then id ascending. */
export function compareTasks(a: Task, b: Task): number {
  return b.priority - a.priority || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function matchesEventQuery(ev: BoardEvent, q: EventQuery): boolean {
  if (q.after !== undefined && ev.seq <= q.after) return false;
  if (q.channel !== undefined && ev.channel !== q.channel) return false;
  if (q.thread !== undefined && ev.thread !== q.thread) return false;
  return true;
}
