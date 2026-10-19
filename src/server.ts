/**
 * LifeOS MCP server — Streamable HTTP (stateless mode), official SDK.
 * Alexa+ (or any MCP host: Claude, the LifeOS simulator, MCP Inspector)
 * is the client; every tool answers from precomputed state in milliseconds.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { openDb, migrate } from "./db/schema.js";
import { seed, DEMO_TODAY } from "./db/seed.js";
import * as impl from "./tools/impl.js";

// ---------------------------------------------------------------- latency stats
const stats = new Map<string, number[]>();
function recordLatency(tool: string, ms: number): void {
  const arr = stats.get(tool) ?? [];
  arr.push(ms);
  stats.set(tool, arr);
}
export function latencyReport(): Record<string, { count: number; avg_ms: number; max_ms: number }> {
  const out: Record<string, { count: number; avg_ms: number; max_ms: number }> = {};
  for (const [tool, arr] of stats) {
    out[tool] = {
      count: arr.length,
      avg_ms: Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10,
      max_ms: Math.round(Math.max(...arr) * 10) / 10,
    };
  }
  return out;
}

// ---------------------------------------------------------------- output shapes
const zBalance = z.array(
  z.object({ domain: z.string(), score: z.number().nullable(), trend: z.string(), freshnessDays: z.number(), note: z.string() }),
);
const zInsightSummary = z.object({ id: z.string(), title: z.string(), severity: z.number(), domains: z.array(z.string()) });
const zChange = z
  .object({ op: z.string(), domain: z.string(), title: z.string() })
  .passthrough();

// ---------------------------------------------------------------- MCP server
export function buildMcpServer(db: DatabaseSync, today: string): McpServer {
  const server = new McpServer({ name: "lifeos", version: "0.1.0" });

  const wrap =
    <A,>(tool: string, fn: (args: A) => impl.ToolResult) =>
    (args: A) => {
      const t0 = performance.now();
      try {
        const r = fn(args);
        recordLatency(tool, performance.now() - t0);
        return {
          content: [{ type: "text" as const, text: r.text }],
          structuredContent: r.data,
          isError: r.isError ?? false,
        };
      } catch (e) {
        recordLatency(tool, performance.now() - t0);
        return {
          content: [{ type: "text" as const, text: `Something went wrong on my side — try again, or ask for your briefing to start fresh. (${(e as Error).message})` }],
          isError: true,
        };
      }
    };

  server.registerTool(
    "get_daily_briefing",
    {
      title: "Daily briefing",
      description:
        "The user's morning briefing: life-balance headline, the most important cross-domain insights, goal snapshot, and at most one check-in question. Use when the user says 'good morning', 'what's my briefing', 'how's my week looking', or 'catch me up'.",
      inputSchema: { date: z.string().optional().describe("ISO date; defaults to today") },
      outputSchema: {
        date: z.string(),
        headline: z.string(),
        balance: zBalance,
        insights: z.array(zInsightSummary),
        question: z.object({ id: z.string(), text: z.string() }).nullable(),
      },
    },
    wrap("get_daily_briefing", (a: { date?: string }) => impl.getDailyBriefing(db, a.date ?? today)),
  );

  server.registerTool(
    "get_life_balance",
    {
      title: "Life balance",
      description:
        "Six-domain life-balance scorecard (family, health, personal growth, work/career, household, finance goals) with trends and data freshness. Use for 'how's my life going', 'am I balanced', 'life check', 'how am I doing overall'.",
      inputSchema: {},
      outputSchema: { date: z.string(), balance: zBalance },
    },
    wrap("get_life_balance", () => impl.getLifeBalance(db, today)),
  );

  server.registerTool(
    "get_insight",
    {
      title: "Insight details",
      description:
        "Full evidence chain and reasoning for one insight from the briefing. Use for 'tell me more', 'why do you say that', 'show the evidence'.",
      inputSchema: { insight_id: z.string().describe("Insight id from the briefing, e.g. ins_1a2b3c4d") },
      outputSchema: {
        id: z.string().optional(), title: z.string().optional(), severity: z.number().optional(),
        domains: z.array(z.string()).optional(), evidence: z.record(z.string(), z.unknown()).optional(),
        reasoning: z.string().optional(), confidence: z.number().optional(),
      },
    },
    wrap("get_insight", (a: { insight_id: string }) => impl.getInsight(db, a.insight_id)),
  );

  server.registerTool(
    "check_in",
    {
      title: "Check in",
      description:
        "Record how something in the user's life is going — an answer to LifeOS's question, a status update ('we barely talk lately', 'date night happened'), or self-reported goal progress ('I put 450 in savings', with goal_id + amount). Updates memory and re-analyzes.",
      inputSchema: {
        content: z.string().describe("What the user said, verbatim or near-verbatim"),
        question_id: z.string().optional().describe("If this answers the briefing's question, its id"),
        domain: z.string().optional().describe("family | health | personal | work | household | finance"),
        goal_id: z.string().optional().describe("For progress on a specific goal, e.g. goal_house"),
        amount: z.number().optional().describe("Numeric progress, e.g. dollars saved"),
      },
      outputSchema: { memory_id: z.string(), pacing: z.string().nullable(), engine_refreshed: z.boolean() },
    },
    wrap("check_in", (a: { content: string; question_id?: string; domain?: string; goal_id?: string; amount?: number }) =>
      impl.checkIn(db, today, a),
    ),
  );

  server.registerTool(
    "remember",
    {
      title: "Remember",
      description:
        "Store a durable fact, preference, or commitment the user explicitly wants kept ('remember that Sam is vegetarian', 'I prefer mornings for focus work').",
      inputSchema: {
        content: z.string(),
        kind: z.enum(["fact", "preference", "commitment"]).default("fact"),
      },
      outputSchema: { memory_id: z.string(), kind: z.string(), content: z.string() },
    },
    wrap("remember", (a: { content: string; kind?: "fact" | "preference" | "commitment" }) =>
      impl.remember(db, today, a.content, a.kind ?? "fact"),
    ),
  );

  server.registerTool(
    "set_goal",
    {
      title: "Set a goal",
      description:
        "Create a recurring life goal to track ('gym three times a week', 'weekly date night', 'Spanish practice 3x'). Cadence is sessions per week.",
      inputSchema: {
        title: z.string(),
        domain: z.enum(["family", "health", "personal", "work", "household", "finance"]),
        cadence_per_week: z.number().int().min(1).max(14),
      },
      outputSchema: { goal_id: z.string(), title: z.string(), domain: z.string(), cadence_per_week: z.number() },
    },
    wrap("set_goal", (a: { title: string; domain: "family" | "health" | "personal" | "work" | "household" | "finance"; cadence_per_week: number }) =>
      impl.setGoal(db, today, a),
    ),
  );

  server.registerTool(
    "get_goal_progress",
    {
      title: "Goal progress",
      description:
        "Progress on goals: last week's actual vs target and the streak. Use for 'how am I doing on my gym goal', 'goal progress', 'did I keep my goals'.",
      inputSchema: { goal_id: z.string().optional(), domain: z.string().optional() },
      outputSchema: {
        goals: z.array(
          z.object({ goal_id: z.string(), title: z.string(), domain: z.string(), actual: z.number(), target: z.number(), unit: z.string(), streak_weeks: z.number() }),
        ),
      },
    },
    wrap("get_goal_progress", (a: { goal_id?: string; domain?: string }) => impl.getGoalProgress(db, today, a)),
  );

  server.registerTool(
    "propose_plan",
    {
      title: "Propose a plan",
      description:
        "Turn an insight into a concrete plan of calendar changes with trade-offs. Locked meetings are never moved. Use for 'fix it', 'what do you suggest', 'help me change this'. Returns a plan that still needs the user's approval.",
      inputSchema: { insight_id: z.string() },
      outputSchema: {
        plan_id: z.string(), title: z.string().optional(), changes: z.array(zChange),
        tradeoffs: z.string().optional(), expected_benefit: z.string().optional(), requires_approval: z.boolean().optional(),
      },
    },
    wrap("propose_plan", (a: { insight_id: string }) => impl.proposePlanTool(db, today, a.insight_id)),
  );

  server.registerTool(
    "apply_plan",
    {
      title: "Apply a plan",
      description:
        "Execute an approved plan. Call ONLY after the user explicitly confirms (approve=true). Every change is verified against the calendar after writing; the result reports exactly what was done.",
      inputSchema: { plan_id: z.string(), approve: z.boolean().describe("Must be true; set only after the user said yes") },
      outputSchema: {
        planId: z.string().optional(), plan_id: z.string().optional(),
        executed: z.array(z.object({ op: z.string(), title: z.string(), ok: z.boolean(), detail: z.string() })).optional(),
        allVerified: z.boolean().optional(), requires_approval: z.boolean().optional(),
      },
    },
    wrap("apply_plan", (a: { plan_id: string; approve: boolean }) => impl.applyPlanTool(db, today, a.plan_id, a.approve)),
  );

  server.registerTool(
    "review_memory",
    {
      title: "Review memory",
      description:
        "List what LifeOS remembers about the user (facts, preferences, experiences, commitments) so they can review or correct it. Use for 'what do you know about me', 'show your memory'.",
      inputSchema: { filter: z.string().optional().describe("Substring or kind to filter by") },
      outputSchema: { memories: z.array(z.object({ id: z.string(), kind: z.string(), content: z.string(), created_at: z.string() })) },
    },
    wrap("review_memory", (a: { filter?: string }) => impl.reviewMemory(db, a.filter)),
  );

  server.registerTool(
    "forget",
    {
      title: "Forget",
      description: "Delete one memory item at the user's request ('forget that'). It stops informing all analysis immediately.",
      inputSchema: { memory_id: z.string() },
      outputSchema: { memory_id: z.string().optional(), status: z.string().optional() },
    },
    wrap("forget", (a: { memory_id: string }) => impl.forget(db, a.memory_id)),
  );

  server.registerTool(
    "whats_changed",
    {
      title: "What changed",
      description:
        "Measured results of past plans — did they actually improve things? Use for 'did it work', 'how did my week go', 'what's new since last time'.",
      inputSchema: { since: z.string().optional().describe("ISO date; defaults to one week ago") },
      outputSchema: {
        since: z.string(),
        outcomes: z.array(z.object({ metric: z.string(), baseline: z.number(), observed: z.number(), verdict: z.string(), title: z.string() })),
      },
    },
    wrap("whats_changed", (a: { since?: string }) => impl.whatsChanged(db, today, a.since)),
  );

  return server;
}

// ---------------------------------------------------------------- HTTP wiring
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Accept",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

export function createLifeOsHttpServer(db: DatabaseSync, today: string) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (req.method === "OPTIONS") return res.writeHead(204).end();
    if (path === "/healthz") {
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "ok", today }));
    }
    if (path === "/stats") {
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(latencyReport(), null, 2));
    }
    if (path !== "/mcp") return res.writeHead(404).end();
    if (req.method !== "POST") {
      return res
        .writeHead(405, { "Content-Type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: POST only)" }, id: null }));
    }

    // Stateless: fresh server + transport per request; all state lives in SQLite.
    const server = buildMcpServer(db, today);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
}

// ---------------------------------------------------------------- main
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb();
  migrate(db);
  const empty = (db.prepare("SELECT COUNT(*) AS n FROM people").get() as { n: number }).n === 0;
  if (empty) seed(db);
  impl.ensureEngineRun(db, DEMO_TODAY);

  const port = Number(process.env.PORT ?? 3344);
  createLifeOsHttpServer(db, DEMO_TODAY).listen(port, () => {
    console.log(`LifeOS MCP server: http://localhost:${port}/mcp  (health: /healthz, latency: /stats)`);
    console.log(`Demo anchor date: ${DEMO_TODAY}${empty ? " — database seeded" : ""}`);
  });
}
