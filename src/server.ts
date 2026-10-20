/**
 * Align MCP server — Streamable HTTP (stateless mode), official SDK.
 * Alexa+ (or any MCP host: Claude, the Align simulator, MCP Inspector)
 * is the client; every tool answers from precomputed state in milliseconds.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { openDb, migrate } from "./db/schema.js";
import { seed, DEMO_TODAY } from "./db/seed.js";
import * as impl from "./tools/impl.js";
import { orchestrate, newSession, type SessionState, type ToolCallRecord } from "./sim/orchestrator.js";
import { makeBedrockBrain } from "./sim/bedrock.js";
import { runEngine } from "./engine/engine.js";
import { addDays } from "./engine/time.js";

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
  const server = new McpServer({ name: "align", version: "0.1.0" });

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
        outcomes: z
          .array(z.object({ metric: z.string(), baseline: z.number(), observed: z.number(), verdict: z.string() }))
          .optional(),
        streaks: z.array(z.object({ goal: z.string(), weeks: z.number(), revived: z.boolean() })).optional(),
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
        "Record how something in the user's life is going — an answer to Align's question, a status update ('we barely talk lately', 'date night happened'), or self-reported goal progress ('I put 450 in savings', with goal_id + amount). Updates memory and re-analyzes.",
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
        tradeoffs: z.string().optional(), expected_benefit: z.string().optional(),
        hypothesis: z.string().nullable().optional(), requires_approval: z.boolean().optional(),
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
    "simulate_change",
    {
      title: "What-if simulation",
      description:
        "Preview the cost of a decision BEFORE making it: hypothetically add an event and report what would collide and which goals would lose their slot. Use for 'what if I take…', 'can I fit…', 'should I accept the Thursday dinner'.",
      inputSchema: {
        title: z.string().describe("What the hypothetical commitment is, e.g. 'client dinner'"),
        day: z.string().describe("Weekday name within this week (e.g. Thursday) or YYYY-MM-DD"),
        start_time: z.string().describe("Start time, 24h HH:MM (e.g. 19:00)"),
        duration_minutes: z.number().int().min(15).max(600).optional().describe("Default 120"),
        domain: z.enum(["work", "family", "health", "personal", "household", "admin"]).optional(),
      },
      outputSchema: {
        hypothetical: z.object({ title: z.string(), start: z.string(), end: z.string() }).optional(),
        conflicts: z.array(z.object({ title: z.string(), start: z.string(), domain: z.string() })).optional(),
        new_risks: z.array(z.string()).optional(),
        recommendation: z.string().optional(),
      },
    },
    wrap("simulate_change", (a: { title: string; day: string; start_time: string; duration_minutes?: number; domain?: "work" | "family" | "health" | "personal" | "household" | "admin" }) =>
      impl.simulateChange(db, today, a),
    ),
  );

  server.registerTool(
    "review_memory",
    {
      title: "Review memory",
      description:
        "List what Align remembers about the user (facts, preferences, experiences, commitments) so they can review or correct it. Use for 'what do you know about me', 'show your memory'.",
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
        outcomes: z.array(
          z.object({ metric: z.string(), baseline: z.number(), observed: z.number(), verdict: z.string(), title: z.string() }).passthrough(),
        ),
        hypothesis: z.string().nullable().optional(),
        hypothesis_confirmed: z.boolean().optional(),
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

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c: Buffer) => {
      buf += c.toString();
      if (buf.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(buf ? (JSON.parse(buf) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e as Error);
      }
    });
    req.on("error", reject);
  });
}

const json = (res: ServerResponse, code: number, body: unknown) =>
  res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));

export function createLifeOsHttpServer(db: DatabaseSync, today: string) {
  // ---- demo clock: mutable so the video can jump a week to show measured
  // outcomes and the adaptive next question. /demo/reset restores day one.
  let currentToday = today;

  // ---- continuous background intelligence: the engine re-runs hourly on its
  // own (and after every check-in/apply), without any prompt. unref() so test
  // processes exit cleanly.
  const engineTimer = setInterval(() => {
    try {
      runEngine(db, currentToday);
    } catch (e) {
      console.warn(`background engine run failed: ${(e as Error).message}`);
    }
  }, 60 * 60 * 1000);
  engineTimer.unref();

  // ---- simulated Alexa+ host state: conversation sessions + a self MCP client.
  // The host talks to Align ONLY over the real MCP wire — same as Alexa+ would.
  const sessions = new Map<string, SessionState>();
  let mcp: Client | null = null;

  async function mcpClient(): Promise<Client> {
    if (mcp) return mcp;
    const port = (srv.address() as AddressInfo).port;
    const c = new Client({ name: "lifeos-sim-host", version: "0.1.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    mcp = c;
    return c;
  }
  const callTool = async (name: string, args: Record<string, unknown>): Promise<ToolCallRecord> => {
    const c = await mcpClient();
    const r = (await c.callTool({ name, arguments: args })) as unknown as {
      content: Array<{ type: string; text?: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    return { name, args, text: r.content?.[0]?.text ?? "", data: r.structuredContent, isError: r.isError ?? false };
  };
  const listTools = async () => {
    const c = await mcpClient();
    const { tools } = await c.listTools();
    return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }));
  };
  const bedrockBrain = process.env.LIFEOS_LLM === "bedrock" ? makeBedrockBrain(listTools) : undefined;

  const srv = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (req.method === "OPTIONS") return res.writeHead(204).end();
    if (path === "/healthz") {
      // When the Bedrock circuit is open, replies come from the rules brain
      // even though the Bedrock brain is configured — surfaced here honestly.
      return json(res, 200, { status: "ok", today: currentToday, brain: bedrockBrain ? "bedrock" : "rules", bedrock: bedrockBrain?.status() ?? null });
    }
    if (path === "/stats") return json(res, 200, latencyReport());

    // Demo time controls (simulator only — not part of the MCP surface).
    if (path === "/demo/advance" && req.method === "POST") {
      currentToday = addDays(currentToday, 7);
      impl.ensureEngineRun(db, currentToday);
      return json(res, 200, { today: currentToday });
    }
    if (path === "/demo/reset" && req.method === "POST") {
      seed(db);
      sessions.clear();
      currentToday = today;
      return json(res, 200, { today: currentToday, reset: true });
    }

    // The proactive channel: the HOST polls this; Align speaks first only when
    // the engine found something new, and stays quiet otherwise. On real Alexa+
    // this is the add-on-initiated-turns API we request as platform feedback.
    if (path === "/proactive") {
      const r = impl.getProactiveNudge(db, currentToday);
      // The proactive turn is part of the conversation: seed the session's
      // anchors so "fix it" / "tell me more" resolve to what was just said.
      const sid = url.searchParams.get("session_id");
      if (sid && r.data.quiet !== true) {
        const state = sessions.get(sid) ?? newSession();
        sessions.set(sid, state);
        const d = r.data as { insights?: Array<{ id: string }>; question?: { id: string } | null };
        state.lastInsightId = d.insights?.[0]?.id ?? state.lastInsightId;
        state.lastQuestionId = d.question?.id ?? state.lastQuestionId;
        state.history.push({ role: "assistant", text: r.text });
      }
      return json(res, 200, { quiet: r.data.quiet === true, text: r.text, data: r.data });
    }

    if (path === "/chat" && req.method === "POST") {
      try {
        const body = await readJson(req);
        const text = String(body.text ?? "").trim();
        if (!text) return json(res, 400, { error: "text is required" });
        const sid = String(body.session_id ?? "default");
        const state = sessions.get(sid) ?? newSession();
        sessions.set(sid, state);
        const out = await orchestrate(text, state, { callTool, bedrock: bedrockBrain });
        return json(res, 200, out);
      } catch (e) {
        return json(res, 500, { error: (e as Error).message });
      }
    }

    if (path === "/" || path === "/sim") {
      try {
        const html = readFileSync(new URL("../public/sim.html", import.meta.url), "utf8");
        return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
      } catch {
        return res.writeHead(200, { "Content-Type": "text/plain" }).end("Simulator UI not built yet. MCP endpoint: POST /mcp");
      }
    }

    if (path !== "/mcp") return res.writeHead(404).end();
    if (req.method !== "POST") {
      return res
        .writeHead(405, { "Content-Type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: POST only)" }, id: null }));
    }

    // Stateless: fresh server + transport per request; all state lives in SQLite.
    const server = buildMcpServer(db, currentToday);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  return srv;
}

// ---------------------------------------------------------------- main
/** Minimal .env loader (no dependency): KEY=VALUE lines, CRLF-tolerant, never overrides real env. */
export function loadDotEnv(path = ".env"): void {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.replace(/\r$/, "").match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.trim();
    }
  } catch {
    /* no .env file — fine */
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadDotEnv();
  const db = openDb();
  migrate(db);
  const empty = (db.prepare("SELECT COUNT(*) AS n FROM people").get() as { n: number }).n === 0;
  if (empty) seed(db);
  impl.ensureEngineRun(db, DEMO_TODAY);

  const port = Number(process.env.PORT ?? 3344);
  createLifeOsHttpServer(db, DEMO_TODAY).listen(port, () => {
    console.log(`Align MCP server: http://localhost:${port}/mcp  (health: /healthz, latency: /stats)`);
    console.log(`Demo anchor date: ${DEMO_TODAY}${empty ? " — database seeded" : ""}`);
  });
}
