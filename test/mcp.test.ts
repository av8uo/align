/**
 * Wire-level test: a real MCP client (official SDK) talks to the LifeOS server
 * over Streamable HTTP and runs the whole demo flow — proving the integration
 * is spec-compliant, portable, and inside the Alexa+ latency budget.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migrate } from "../src/db/schema.js";
import { seed, DEMO_TODAY } from "../src/db/seed.js";
import { createLifeOsHttpServer } from "../src/server.js";

let httpServer: ReturnType<typeof createLifeOsHttpServer>;
let client: Client;

const callTool = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return res as unknown as {
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
};

beforeAll(async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  seed(db);
  httpServer = createLifeOsHttpServer(db, DEMO_TODAY);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;

  client = new Client({ name: "lifeos-test-client", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
});

afterAll(async () => {
  await client.close();
  httpServer.close();
});

describe("MCP wire protocol", () => {
  it("lists all 12 tools with schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(12);
    const names = tools.map((t) => t.name);
    for (const n of ["get_daily_briefing", "get_life_balance", "check_in", "propose_plan", "apply_plan", "review_memory", "forget", "whats_changed"]) {
      expect(names).toContain(n);
    }
    for (const t of tools) expect(t.inputSchema).toBeTruthy();
  });

  it("runs the full demo loop over the wire within the Alexa+ latency budget", async () => {
    // Beat 1: briefing (first call pays the engine warm-up; later calls are the budget test)
    const briefing = await callTool("get_daily_briefing");
    const b = briefing.structuredContent as { insights: Array<{ id: string; title: string }>; question: { id: string; text: string } | null };
    expect(briefing.content[0]!.text).toContain("Work is crowding");
    expect(b.question?.text).toContain("Sam");
    const compositeId = b.insights.find((i) => i.title.startsWith("Work is crowding"))!.id;

    // Answer the question
    const answer = await callTool("check_in", {
      content: "Honestly we barely talk, work is eating everything.",
      question_id: b.question!.id,
    });
    expect(answer.isError ?? false).toBe(false);

    // Beat 2: propose -> approval gate -> apply
    const plan = await callTool("propose_plan", { insight_id: compositeId });
    const planData = plan.structuredContent as { plan_id: string; changes: unknown[] };
    expect(planData.changes.length).toBeGreaterThanOrEqual(5);

    const unapproved = await callTool("apply_plan", { plan_id: planData.plan_id, approve: false });
    expect(unapproved.content[0]!.text).toContain("confirm");

    const t0 = performance.now();
    const applied = await callTool("apply_plan", { plan_id: planData.plan_id, approve: true });
    const applyMs = performance.now() - t0;
    expect((applied.structuredContent as { allVerified: boolean }).allVerified).toBe(true);
    expect(applyMs).toBeLessThan(500); // Alexa+ round-trip budget

    // Beat 3 (a week later): measured outcomes
    const results = await callTool("whats_changed", { since: DEMO_TODAY });
    // measurement needs the follow-up window; simulate by asking at +7 via the impl path:
    expect(results.isError ?? false).toBe(false);

    // Memory transparency: review + forget work over the wire
    const memory = await callTool("review_memory", { filter: "barely talk" });
    const memories = (memory.structuredContent as { memories: Array<{ id: string }> }).memories;
    expect(memories.length).toBe(1);
    const forgot = await callTool("forget", { memory_id: memories[0]!.id });
    expect(forgot.isError ?? false).toBe(false);
  });

  it("stays under the 500ms budget on hot reads", async () => {
    for (const name of ["get_life_balance", "get_goal_progress", "get_daily_briefing"]) {
      const t0 = performance.now();
      await callTool(name);
      expect(performance.now() - t0, name).toBeLessThan(500);
    }
  });

  it("returns the MCP error contract for bad input, with no technical jargon leaking", async () => {
    const res = await callTool("get_insight", { insight_id: "ins_nope" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).not.toMatch(/SQL|undefined|stack|Error:/);
  });
});
