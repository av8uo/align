// Replays the auto-demo conversation over HTTP (no browser) and prints each
// reply, its estimated speaking time, and the Life Balance after every turn.
//   npx tsx scripts/demo-trace.ts
const BASE = "http://localhost:3344";
const WPS = 2.75; // spoken words per second at the sim's TTS rate (1.1)
const post = (p: string, body?: object) =>
  fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const get = (p: string) => fetch(BASE + p).then((r) => r.json());

let total = 0;
const session = "trace-" + Date.now();
async function balance() {
  const d = await get("/balance");
  return (d.balance || []).map((b: any) => `${b.domain} ${b.score ?? "—"}${b.planned > (b.score ?? 999) ? ` (plan ${b.planned})` : ""}`).join(" · ");
}
function show(label: string, text: string, ms: number) {
  const words = text.split(/\s+/).length;
  const secs = words / WPS;
  total += secs + ms / 1000;
  console.log(`\n▶ ${label}  (${words} words ≈ ${secs.toFixed(0)}s spoken, ${(ms / 1000).toFixed(1)}s think)\n  ${text}`);
}
async function proactive() {
  const t = Date.now();
  const r = await get("/proactive?session_id=" + session);
  show("PROACTIVE", r.text ?? "(quiet)", Date.now() - t);
  console.log("  balance: " + (await balance()));
}
async function say(text: string) {
  const t = Date.now();
  const r = await post("/chat", { session_id: session, text });
  show(`YOU: ${text}`, r.reply, Date.now() - t);
  console.log(`  tools: ${(r.toolCalls || []).map((c: any) => c.name).join(" → ")}\n  balance: ` + (await balance()));
}

await post("/demo/fresh");
console.log("=== ACT 1 · blank mind ===  balance: " + (await balance()));
await proactive();
// Same lines as scripts/auto-demo.ts.
await say("I'm married to Sam, and we have two kids, Maya and Leo. I'd love to run twice a week, but never in the mornings.");
await post("/demo/reset");
console.log("\n=== ACT 2 · three weeks later ===  balance: " + (await balance()));
await proactive();
await say("Actually, I hate morning gym");
await say("Fix it");
await say("Yes, do it");
await post("/demo/advance");
console.log("\n=== ONE WEEK LATER ===");
await proactive();
await say("I made it twice!");
console.log(`\nTOTAL ≈ ${Math.round(total)}s of speech+thinking (plus typing, cards, narration)`);
