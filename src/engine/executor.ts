/**
 * Verified execution: apply an approved plan to the calendar store, then
 * RE-READ state and verify every change. LifeOS never claims success it
 * didn't check (certification: no unverified claims; approval gates action).
 */
import type { DatabaseSync } from "node:sqlite";
import type { Change } from "./learn.js";
import { newId } from "../core/ids.js";

export interface ExecResult {
  planId: string;
  executed: Array<{ op: string; title: string; ok: boolean; detail: string }>;
  allVerified: boolean;
}

export function applyPlan(db: DatabaseSync, planId: string, now: string, personId = "alex"): ExecResult {
  const plan = db.prepare("SELECT * FROM plans WHERE id = ?").get(planId) as
    | { id: string; changes: string; status: string }
    | undefined;
  if (!plan) throw new Error(`Unknown plan: ${planId}`);
  if (!["proposed", "approved"].includes(plan.status)) {
    throw new Error(`Plan ${planId} is ${plan.status}; only proposed/approved plans can be applied`);
  }
  db.prepare("UPDATE plans SET status='approved', approved_at=? WHERE id=?").run(now, planId);

  const executed: ExecResult["executed"] = [];
  const logAction = db.prepare(
    "INSERT INTO action_log (id, plan_id, op, payload, executed_at, verified, verification_detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );

  for (const c of JSON.parse(plan.changes) as Change[]) {
    let ok = false;
    let detail = "";
    if (c.op === "create") {
      const id = newId("evt");
      db.prepare(
        "INSERT INTO events (id, person_id, title, start, end, domain, flexible, source, reschedule_count) VALUES (?, ?, ?, ?, ?, ?, 1, 'lifeos_plan', 0)",
      ).run(id, personId, c.title, c.start!, c.end!, c.domain);
      const back = db.prepare("SELECT start, end FROM events WHERE id = ?").get(id) as
        | { start: string; end: string }
        | undefined;
      ok = back?.start === c.start && back?.end === c.end;
      detail = ok ? `created ${c.title} at ${c.start}` : "re-read mismatch after insert";
    } else {
      const ev = db.prepare("SELECT * FROM events WHERE id = ?").get(c.event_id!) as
        | { start: string; flexible: number }
        | undefined;
      if (!ev) detail = "event no longer exists";
      else if (ev.flexible !== 1) detail = "event is locked (flexible=0)";
      else if (ev.start !== c.from!.start) detail = "event changed since the plan was proposed";
      else {
        db.prepare("UPDATE events SET start=?, end=? WHERE id=?").run(c.to!.start, c.to!.end, c.event_id!);
        const back = db.prepare("SELECT start, end FROM events WHERE id = ?").get(c.event_id!) as {
          start: string;
          end: string;
        };
        ok = back.start === c.to!.start && back.end === c.to!.end;
        detail = ok ? `moved ${c.title} to ${c.to!.start}` : "re-read mismatch after move";
      }
    }
    logAction.run(newId("act"), planId, c.op, JSON.stringify(c), now, ok ? 1 : 0, detail);
    executed.push({ op: c.op, title: c.title, ok, detail });
  }

  const allVerified = executed.length > 0 && executed.every((e) => e.ok);
  if (allVerified) db.prepare("UPDATE plans SET status='executed', executed_at=? WHERE id=?").run(now, planId);
  return { planId, executed, allVerified };
}
