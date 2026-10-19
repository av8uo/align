import { randomUUID } from "node:crypto";

/** Runtime IDs: short, stable, prefixed — chainable across tool calls (ins_* -> plan_*). */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

/** Deterministic IDs for seed data so tests and the demo script can reference them. */
export function seedIdFactory(): (prefix: string) => string {
  const counters = new Map<string, number>();
  return (prefix: string) => {
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return `${prefix}_${String(n).padStart(3, "0")}`;
  };
}
