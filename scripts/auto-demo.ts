// Hands-free demo run for the video: opens Edge full screen on /sim and plays
// the DEMO_SCRIPT.md beats — typing the user's lines, clicking chips, waiting
// for each spoken reply to finish. Dependency-free: drives Edge over CDP.
//
//   npx tsx scripts/auto-demo.ts            full run (start Win+Alt+R when Edge opens)
//   npx tsx scripts/auto-demo.ts --fast     no speech waits (quick smoke check)
//
// Needs the server running (npm start). Prints a timestamp per beat.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "http://localhost:3344";
const PORT = 9333;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const FAST = process.argv.includes("--fast");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}`);

// ---------- frames: full-screen scenes (one slide per narrated sentence) and demo captions
const FONT = "system-ui,Segoe UI,sans-serif";
const pill = (t: string, color: string, bg: string) =>
  `<span style="display:inline-block;margin:0 12px;padding:14px 34px;border-radius:999px;border:2px solid ${color};color:${color};background:${bg};font:600 44px ${FONT}">${t}</span>`;
const line = (t: string, size = 62, color = "#fff", weight = 700) => `<div style="font:${weight} ${size}px ${FONT};color:${color};line-height:1.25">${t}</div>`;
const gap = (px: number) => `<div style="height:${px}px"></div>`;
const LOGO = `${line("Align", 150, "#fff", 800)}${gap(8)}${line("a proactive life agent for Alexa+", 42, "#aab4c3", 500)}`;

// The technical frame: what actually runs, drawn as one pipeline. Parts carry
// data-r="n" and appear as the narrator reaches them.
const box = (title: string, sub: string, accent: string, extra = "") =>
  `<div style="border:1.5px solid ${accent};border-radius:16px;padding:18px 22px;background:#121821;min-width:230px;${extra}">
     <div style="font:700 26px ${FONT};color:${accent}">${title}</div>
     <div style="font:500 17px ${FONT};color:#aab4c3;margin-top:6px;line-height:1.45">${sub}</div></div>`;
const arrow = `<div style="font:300 46px system-ui;color:#5d6b7e;padding:0 14px">⇄</div>`;
const ENGINE = [
  "Life model · 6 areas of your life",
  "8 pattern detectors + cross-area links",
  "One question a day — only if the answer changes the plan",
  "Plan builder that learns your preferences",
  "Acts only after your yes · every change verified",
  "Measures what really happened · learns from it",
].map((l) => `<div style="padding:5px 0">• ${l}</div>`).join("");
const hidden = (n: number, html: string, tag = "div", style = "") => `<${tag} data-r="${n}" style="opacity:0;transition:opacity .7s;${style}">${html}</${tag}>`;
const ARCH_HTML = `<div style="zoom:1.45">
  <div style="font:700 40px ${FONT};color:#fff;margin-bottom:34px">How Align works</div>
  <div style="display:flex;align-items:center;justify-content:center">
    ${hidden(1, box("Alexa+ host", "voice, screen,<br>speaks first<br><span style='color:#f5a623'>simulated here</span>", "#7fa6ff"))}
    ${hidden(1, arrow)}
    ${hidden(1, box("MCP server", "13 tools<br>Streamable HTTP<br>spec 2025-11-25", "#39c47f"))}
    ${hidden(2, arrow)}
    ${hidden(2, box("Align engine", `<div style="text-align:left;font-size:17px">${ENGINE}</div>`, "#f5a623", "min-width:470px"))}
  </div>
  ${hidden(3, `The language model only phrases the replies — <span style="color:#fff">the engine decides</span>. Runs locally · 146 automated tests.`, "div", `font:500 20px ${FONT};color:#aab4c3;margin-top:34px`)}</div>`;

/** The judge's guide beside the demo: where we are in Align's loop, and what just happened. */
type Explain = { stage: number; you: string; align: string; next: string };
const STAGES = [
  ["Meets you", "learns who you are"],
  ["Remembers", "facts · goals · preferences"],
  ["Notices", "patterns across your life"],
  ["Plans", "one plan, every area"],
  ["Acts", "only with your yes · verified"],
  ["Measures", "what really happened"],
  ["Learns", "next plan from evidence"],
];

/** One slide: new `html` (cross-faded in) and/or `reveal` = show the parts marked data-r=n; the narrator `say`s it. */
type Slide = { html?: string; reveal?: number; say?: string; hold?: number };

type Step =
  | { scene: Slide[] }                     // full-screen narrated scene, slide by slide
  | { card: string; ms?: number }          // short full-screen title card
  | { explain: Explain }                   // side panels: the process timeline + you / Align's intelligence / next
  | { type: string }                       // typed into the input, then Send
  | { chip: string }                       // click a demo chip
  | { button: "fresh" | "reset" | "jump" } // sim control button
  | { pause: number };

const STEPS: Step[] = [
  { scene: [
    { html: `${line("Most startups build agents that connect to our", 56)}${gap(40)}<div>${pill("apps", "#8a94a3", "#141922")}${pill("phones", "#8a94a3", "#141922")}${pill("devices", "#8a94a3", "#141922")}</div>`,
      say: "Most startups build agents that connect to our apps, our phones, our devices." },
    { html: `${line(`But where is the agent that connects to <span style="color:#f5a623">us</span>?`, 64)}${gap(40)}<div>${pill("our health", "#39c47f", "#0f2219")}${pill("our family", "#7fa6ff", "#121a2b")}${pill("our private life", "#f5a623", "#2a1f0d")}</div>`,
      say: "But where is the agent that connects to us: our health, our family, our private life?" },
    { html: LOGO, say: "This is Align.", hold: 500 },
  ] },
  { scene: [
    { html: ARCH_HTML, reveal: 1, say: "Under the hood: a real MCP server with thirteen tools." },
    { reveal: 2, say: "A deterministic engine finds the patterns and builds the plans." },
    { reveal: 3, say: "The language model only speaks. Nothing changes without your yes.", hold: 300 },
  ] },
  { card: "Act 1 · First meeting — a blank mind", ms: 900 },
  { button: "fresh" },
  { explain: { stage: 1, you: "Nothing yet — you're a brand-new user.", align: "Its life model is empty, so it doesn't guess: it starts an interview, one question at a time.", next: "Learn who shares your life and what matters most." } },
  { explain: { stage: 2, you: "Told it about your family, and that you want to run — never in the mornings.", align: "Stored 2 facts, created a goal (run 2×/week) and a preference (no mornings), through its MCP tools.", next: "Keep learning: work, home, money — one question per turn." } },
  { type: "I'm married to Sam, and we have two kids, Maya and Leo. I'd love to run twice a week, but never in the mornings." },
  
  { card: "Act 2 · Three weeks later (seeded demo data)", ms: 900 },
  { button: "reset" },
  { explain: { stage: 3, you: "Nothing — Align spoke first.", align: "Scanned 3 weeks of your life: work is crowding out family, date night 0 of 1. Ranked by YOUR values, family first.", next: "Protect Friday 7 pm for date night with Sam." } },
  { explain: { stage: 2, you: "Said: “I hate morning gym.”", align: "Saved it as a preference. From now on, every plan it builds must respect it.", next: "Fit your workouts outside the mornings." } },
  { chip: "Actually, I hate morning gym" },
  { explain: { stage: 4, you: "Said: “Fix it.”", align: "Built ONE plan across family, health, growth and work — gym moved to evenings, locked meetings untouched.", next: "Wait for your yes. Nothing changes until then." } },
  { chip: "Fix it" },
  { explain: { stage: 5, you: "Approved: “Yes, do it.”", align: "Wrote 10 changes to your calendar, then re-read it to verify every one.", next: "Check next week whether the sessions really happen." } },
  { chip: "Yes, do it" },
  
  { card: "One week later", ms: 700 },
  { button: "jump" },
  { explain: { stage: 6, you: "Nothing — a week went by.", align: "Won't assume scheduled = done. Recalls your gym preference, and rotates its one question to health.", next: "Find out how many gym sessions really happened." } },
  { explain: { stage: 7, you: "Answered: “I made it twice!”", align: "Recorded 2 confirmed sessions. Only evidence moves the score: health goes up.", next: "Rank next week's plan by what actually worked." } },
  { type: "I made it twice!" },
  { pause: 600 },
  { scene: [
    { html: `${LOGO}${gap(50)}${line("keeps thinking while you're away", 44, "#aab4c3", 500)}${line(`one goal: every part of your life at <span style="color:#39c47f">10 / 10</span>`, 48, "#fff", 600)}`,
      say: "Align keeps thinking while you're away, with one goal: every part of your life at ten out of ten." },
    { html: `${LOGO}${gap(60)}${line("“Alexa, open Align.”", 64, "#7fa6ff", 700)}${gap(30)}${line("github.com/av8uo/align", 32, "#8a94a3", 500)}`,
      say: "Alexa, open Align.", hold: 1800 },
  ] },
];

// ---------- CDP plumbing
// A page reload can swap Edge's page target and drop the socket. Every command
// therefore waits for a live connection, and one that gets no answer (dropped
// mid-flight or timed out) reconnects and retries — never silently does nothing.
let ws: WebSocket | null = null;
let ready: Promise<void> = Promise.resolve();
let nextId = 1;
const pending = new Map<number, (v: any) => void>();
async function cdp(method: string, params: object = {}, timeoutMs = 10_000): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await ready;
    if (!ws || ws.readyState !== WebSocket.OPEN) { ready = connect(); continue; }
    const id = nextId++;
    const answer = new Promise<any>((res) => {
      pending.set(id, res);
      setTimeout(() => { if (pending.delete(id)) res(null); }, timeoutMs);
    });
    ws.send(JSON.stringify({ id, method, params }));
    const r = await answer;
    if (r) return r;
    log(`no answer to ${method} — reconnecting and retrying`);
    ready = connect();
  }
  throw new Error(`Edge stopped answering (${method}) — is the window still open?`);
}
async function js<T = any>(expr: string, timeoutMs?: number): Promise<T> {
  const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, timeoutMs);
  return r.result?.result?.value;
}
async function connect(): Promise<void> {
  if (ws) { ws.onclose = null; try { ws.close(); } catch {} ws = null; }
  for (let i = 0; i < 40; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      const page = list.find((t: any) => t.type === "page" && t.url.includes("/sim"));
      if (page) {
        const sock = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => { sock.onopen = r; sock.onerror = j; });
        sock.onmessage = (e) => { const m = JSON.parse(String(e.data)); const res = pending.get(m.id); if (res) { pending.delete(m.id); res(m); } };
        sock.onclose = () => {
          if (ws !== sock) return;
          // Unanswered commands are retried by cdp() on the next connection.
          for (const [, res] of pending) res(null);
          pending.clear();
          ws = null;
        };
        ws = sock;
        sock.send(JSON.stringify({ id: nextId++, method: "Runtime.enable" }));
        return;
      }
    } catch {}
    await sleep(250);
  }
  console.error("\nThe Edge window is gone — demo stopped.");
  process.exit(1);
}

// Front and full screen, whatever window order Windows chose at launch.
async function bringToFront() {
  await cdp("Page.bringToFront", {}, 3000).catch(() => {});
  const w = await cdp("Browser.getWindowForTarget", {}, 3000).catch(() => null);
  const windowId = w?.result?.windowId;
  if (windowId !== undefined) {
    await cdp("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }, 3000).catch(() => {});
    await cdp("Browser.setWindowBounds", { windowId, bounds: { windowState: "fullscreen" } }, 3000).catch(() => {});
  }
  await sleep(600);
}

// ---------- page helpers
const waitLoaded = async () => {
  await waitFor("the page to load", async () => (await js("document.readyState")) === "complete" && (await js("!!document.getElementById('input')")) === true, 20_000);
  await activate();
  if (FAST) await js("speechSynthesis.cancel(); document.getElementById('tts').checked = false"); // quick checks run silent
};
// Clicks go to the element itself, not to screen coordinates: a page laid out at
// another size once sent a "New user" click onto "Reset". On screen it looks the same.
async function click(selector: string) {
  const ok = await js<boolean>(`(() => { const el = ${selector}; if (!el) return false;
    el.scrollIntoView({ block: "nearest" });
    if (el.tagName === "INPUT") el.focus(); else el.click();
    return true; })()`);
  if (!ok) throw new Error(`could not find ${selector} on the page — stopping`);
}
// One real (trusted) click on an empty corner after each page load, so the page
// counts as user-activated and its speech is never blocked.
async function activate() {
  const h = (await js<number>("innerHeight")) ?? 600;
  for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: 2, y: h - 2, button: "left", clickCount: 1 });
}
// Trigger a reload (button click or location.reload) and wait until the NEW page is live.
async function reloadVia(trigger: string, what: string) {
  await js("window.__old = true");
  await js(trigger);
  await sleep(1200);
  ready = connect(); // the reload may have swapped the page target: attach to the new one
  await ready;
  let reloaded = false;
  for (let i = 0; i < 80 && !reloaded; i++) { reloaded = (await js("window.__old")) !== true; if (!reloaded) await sleep(250); }
  if (!reloaded) throw new Error(`${what} did not reload the page`);
  await waitLoaded();
}
const msgCount = () => js<number>("document.querySelectorAll('#log > *').length");
async function waitSpeechDone(maxMs = 90000) {
  if (FAST) return;
  const start = Date.now();
  await sleep(400); // let speak() begin
  while (Date.now() - start < maxMs && (await js<boolean>("speechSynthesis.speaking || speechSynthesis.pending"))) await sleep(150);
  await sleep(450); // a breath before the next line
}
// Waits that never arrive stop the run loudly — a take where nothing happens is worse than no take.
async function waitFor(what: string, done: () => Promise<boolean>, maxMs = 45_000) {
  const start = Date.now();
  while (!(await done())) {
    if (Date.now() - start > maxMs) throw new Error(`waited ${maxMs / 1000}s for ${what} — nothing came. Stopping.`);
    await sleep(250);
  }
}
async function waitReply(before: number) {
  await waitFor("Align's reply", async () => ((await msgCount()) ?? 0) >= before + 2);
  await waitSpeechDone();
}
const proactiveCount = () => js<number>("[...document.querySelectorAll('#log > *')].filter(e => e.textContent.includes('PROACTIVE')).length");
async function waitProactive(before: number) {
  await waitFor("Align to speak first", async () => ((await proactiveCount()) ?? 0) > before);
  await waitSpeechDone();
}
// --dump prints the conversation (for checking a run; reloads clear it).
const dump = async (label: string) => {
  if (!process.argv.includes("--dump")) return;
  console.log(`\n===== ${label} =====\n` + (await js<string>("[...document.querySelectorAll('#log > *')].map(e => e.innerText.replace(/\\s+/g,' ')).join('\\n- ')")) + "\n");
};
// A full-screen card that fades in over the page (the page keeps running under it).
async function mountCard(text: string, html = false) {
  await js(`(() => { const d = document.createElement('div'); d.id='__card';
    d.style.cssText='position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0a0e16;color:#fff;font:600 64px system-ui,Segoe UI,sans-serif;text-align:center;padding:40px;transition:opacity .5s;line-height:1.35;opacity:0';
    d.style.whiteSpace = ${JSON.stringify(html && text.includes("<div") ? "normal" : "pre-line")};
    d[${html} ? 'innerHTML' : 'textContent'] = ${JSON.stringify(text)};
    document.getElementById('__card')?.remove(); document.body.appendChild(d); requestAnimationFrame(() => d.style.opacity = 1); })()`);
}
const hideCard = async () => {
  await js(`(() => { const d=document.getElementById('__card'); if(d){ d.style.opacity=0; setTimeout(()=>d.remove(),500);} })()`);
  await sleep(600);
};
async function showCard(text: string, ms: number) {
  await mountCard(text);
  await sleep(500 + (FAST ? 0 : ms));
  await hideCard();
}
// Apply one slide to the card on screen: cross-fade to new html and/or reveal the parts marked data-r=n.
async function applySlide(sl: Slide) {
  if (sl.html !== undefined) {
    await js(`(() => { const d=document.getElementById('__card'); d.style.transition='opacity .35s'; d.style.opacity=0; })()`);
    await sleep(350);
    await js(`(() => { const d=document.getElementById('__card'); d.style.whiteSpace='normal'; d.innerHTML=${JSON.stringify(sl.html)}; d.style.opacity=1; })()`);
  }
  if (sl.reveal !== undefined) await js(`document.querySelectorAll('#__card [data-r="${sl.reveal}"]').forEach(e => e.style.opacity = 1)`);
}
async function playScene(slides: Slide[]) {
  // Continue from a card already on screen (the countdown logo) instead of flashing the page.
  if (!(await js("!!document.getElementById('__card')"))) await mountCard("", true);
  for (const sl of slides) {
    await applySlide(sl);
    await sleep(300);
    if (sl.say) await narrate(sl.say, 150);
    await sleep(FAST ? 0 : sl.hold ?? 0);
  }
  await hideCard();
}
// The judge's guide, in the empty side margins (the demo itself is never covered):
// left = Align's loop with the current stage lit; right = you / Align's intelligence / next.
function stepperHtml(stage: number): string {
  const rows = STAGES.map(([name, sub], i) => {
    const n = i + 1;
    const on = n === stage, done = n < stage;
    const dot = on ? "#f5a623" : done ? "#39c47f" : "#2a3340";
    return `<div style="display:flex;gap:16px;align-items:flex-start;padding:11px 0;opacity:${on ? 1 : done ? 0.75 : 0.4};transition:opacity .5s">
      <div style="flex:none;width:34px;height:34px;border-radius:50%;background:${dot};color:${on || done ? "#0a0e16" : "#8a94a3"};font:800 17px ${FONT};display:flex;align-items:center;justify-content:center;box-shadow:${on ? "0 0 18px rgba(245,166,35,.6)" : "none"}">${done ? "✓" : n}</div>
      <div><div style="font:700 ${on ? 25 : 21}px ${FONT};color:${on ? "#fff" : "#c9d1dc"}">${name}</div>
      <div style="font:500 16px ${FONT};color:#8a94a3;margin-top:2px">${sub}</div></div></div>`;
  }).join("");
  return `<div style="font:800 15px ${FONT};letter-spacing:2px;color:#f5a623;margin-bottom:10px">ALIGN'S LOOP</div>${rows}`;
}
function explainHtml(e: Explain): string {
  const part = (label: string, color: string, text: string, big = false) =>
    `<div style="margin-bottom:22px"><div style="font:800 14px ${FONT};letter-spacing:2px;color:${color};margin-bottom:6px">${label}</div>
     <div style="font:${big ? 700 : 600} ${big ? 24 : 21}px ${FONT};color:#fff;line-height:1.35">${e[label === "YOU" ? "you" : label === "WHAT ALIGN WANTS NEXT" ? "next" : "align"]}</div></div>`;
  return part("YOU", "#7fa6ff", e.you) + part("ALIGN'S INTELLIGENCE", "#f5a623", e.align, true) + part("WHAT ALIGN WANTS NEXT", "#39c47f", e.next);
}
async function explain(e: Explain) {
  await js(`(() => {
    const mk = (id) => { let c = document.getElementById(id); if (!c) { c = document.createElement('div'); c.id = id;
      c.style.cssText = 'position:fixed;z-index:9999;background:rgba(15,20,28,.97);border:1px solid #242a34;border-radius:16px;padding:24px 26px;box-shadow:0 10px 30px rgba(0,0,0,.45);transition:opacity .45s, transform .45s;opacity:0';
      document.body.appendChild(c); } return c; };
    const screenLeft = document.getElementById('screen').getBoundingClientRect().left - 18;
    const r = document.querySelector('.inputrow').getBoundingClientRect();
    const top = document.getElementById('screen').getBoundingClientRect().top;
    const L = mk('__steps'), R = mk('__why');
    Object.assign(L.style, { left: '24px', top: top + 'px', width: Math.max(260, screenLeft - 48) + 'px' });
    Object.assign(R.style, { left: (r.right + 24) + 'px', top: top + 'px', width: Math.max(260, innerWidth - r.right - 48) + 'px', borderLeft: '5px solid #f5a623' });
    L.innerHTML = ${JSON.stringify(stepperHtml(e.stage))};
    R.style.opacity = 0; R.style.transform = 'translateY(10px)';
    setTimeout(() => { R.innerHTML = ${JSON.stringify(explainHtml(e))}; R.style.opacity = 1; R.style.transform = 'none'; }, 250);
    L.style.opacity = 1;
  })()`);
}
async function narrate(text: string, after = 500) {
  if (FAST) return;
  // A different voice from Align's, so the viewer can tell narrator from agent.
  await js(`new Promise((done) => { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(${JSON.stringify(text)});
    const vs = speechSynthesis.getVoices().filter(v => v.lang.startsWith('en'));
    u.voice = vs.find(v => /Guy|Andrew|Christopher|Davis/.test(v.name)) || vs.find(v => /Online/.test(v.name)) || vs[0] || null;
    u.rate = 1.15; u.onend = done; u.onerror = done; speechSynthesis.speak(u); })`, 90_000);
  await sleep(after);
}
async function typeLine(text: string) {
  await click("document.getElementById('input')");
  for (const ch of text) { await cdp("Input.insertText", { text: ch }); await sleep(FAST ? 0 : 18); }
  await sleep(400);
  const before = await msgCount();
  await click("document.getElementById('send')");
  await waitReply(before);
}

// ---------- run
async function main() {
  const h = await fetch(`${BASE}/healthz`).then((r) => r.json()).catch(() => null);
  if (!h) throw new Error("server not running — run `npm start` first");
  log(`server ok · brain=${h.brain}`);
  await fetch(`${BASE}/demo/fresh`, { method: "POST" }); // the page opens on the blank mind, behind the title card

  const profile = mkdtempSync(join(tmpdir(), "align-edge-"));
  spawn(EDGE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    // Fixed zoom so the whole page (SIMULATED badge included) fits a 1080p screen
    // regardless of Windows display scaling — nothing scrolls during the take.
    "--force-device-scale-factor=0.9",
    // No sign-in/sync prompt: on a fresh profile Edge opens a modal sync dialog
    // that silently blocks every click on the page.
    "--inprivate", "--disable-sync",
    // Windows may open the window behind the app that launched it; a covered
    // ("hidden") page gets no input. Keep it live, and bring it to the front below.
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    "--disable-features=msEdgeSyncConsent,msImplicitSignin,CalculateNativeWinOcclusion",
    "--autoplay-policy=no-user-gesture-required", "--kiosk", `${BASE}/sim`], { detached: true, stdio: "ignore" }).unref();
  await connect();
  await cdp("Runtime.enable");
  await waitLoaded();
  // Belt and braces: close any other Edge page (dialogs, first-run tabs) that could take focus.
  const stray = ((await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())) as Array<{ id: string; type: string; url: string }>)
    .filter((t) => t.type === "page" && !t.url.includes("/sim"));
  for (const t of stray) { log(`closing stray Edge page: ${t.url}`); await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {}); }
  await bringToFront();
  const vis = await js<{ vis: string; w: number }>("({ vis: document.visibilityState, w: outerWidth * devicePixelRatio })");
  log(`window: ${vis?.vis}, ${Math.round(vis?.w ?? 0)}px wide`);
  if (vis?.vis !== "visible") console.log("  ⚠ Edge is behind another window — click on it so it comes to the front.");
  // Lay the page out again at the final full-screen size (the first load happened in a smaller window).
  await reloadVia("location.reload()", "the start-up reload");
  await js("speechSynthesis.cancel()"); // the page's own opening briefing waits until we start
  await js("speechSynthesis.getVoices().length"); // warm the voice list
  log("Edge is open full screen.");
  // --preview <dir>: screenshot every card (no voice), then quit — for checking the framing.
  const pi = process.argv.indexOf("--preview");
  if (pi > 0) {
    const { writeFileSync } = await import("node:fs");
    let n = 0;
    const snap = async () => {
      await sleep(800); // fades done
      const shot = await cdp("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(process.argv[pi + 1]!, `frame-${++n}.png`), Buffer.from(shot.result.data, "base64"));
    };
    for (const s of STEPS) {
      if ("card" in s) { await mountCard(s.card); await snap(); }
      else if ("scene" in s) {
        await mountCard("", true);
        for (const sl of s.scene) { await applySlide(sl); await snap(); }
      }
    }
    await js("document.getElementById('__card')?.remove()");
    for (const s of STEPS) if ("explain" in s && [1, 5].includes(s.explain.stage)) { await explain(s.explain); await snap(); }
    log(`saved ${n} frame screenshots`);
    await cdp("Browser.close", {}, 2000).catch(() => {});
    process.exit(0);
  }
  if (!FAST) {
    await mountCard(LOGO, true); // the recording opens on a clean frame
    console.log("\n  >>> Click once on the Edge window, press Win+Alt+R to start recording.");
    console.log("  >>> The demo starts by itself in 20 seconds.\n");
    for (let s = 20; s > 0; s--) { process.stdout.write(`  ${s}… `); await sleep(1000); }
    console.log("\n");
  }

  for (let i = 0; i < STEPS.length; i++) {
    const s = STEPS[i]!;
    // The explanation right after a reloading/time-jump button is shown as soon
    // as the page is back, so it is on screen while Align speaks first.
    const after = STEPS[i + 1];
    const explainNext = after && "explain" in after ? after.explain : null;
    if ("card" in s) { log(`card: ${s.card}`); await showCard(s.card, s.ms ?? 2000); }
    else if ("scene" in s) { log(`scene: ${s.scene[0]!.say?.slice(0, 40)}…`); await playScene(s.scene); }
    else if ("explain" in s) { const prev = STEPS[i - 1]; if (!(prev && "button" in prev)) await explain(s.explain); }
    else if ("pause" in s) await sleep(FAST ? 0 : s.pause);
    else if ("type" in s) { log(`type: ${s.type.slice(0, 50)}`); await typeLine(s.type); }
    else if ("chip" in s) {
      log(`chip: ${s.chip}`);
      const before = await msgCount();
      await click(`[...document.querySelectorAll('#chips button')].find(b => b.textContent === ${JSON.stringify(s.chip)})`);
      await waitReply(before);
    } else if ("button" in s) {
      log(`button: ${s.button}`);
      if (s.button === "jump") {
        const n = await proactiveCount();
        if (explainNext) await explain(explainNext);
        await click("document.getElementById('jump')"); await waitProactive(n);
      }
      else {
        await dump(`before ${s.button}`);
        await reloadVia(`document.getElementById('${s.button}').click()`, `the ${s.button} button`);
        // Check the scene is the one we think: blank mind after "fresh", seeded life after "reset".
        const fam = ((await fetch(`${BASE}/balance`).then((r) => r.json())) as { balance: Array<{ domain: string; score: number | null }> }).balance.find((b) => b.domain === "family")?.score ?? null;
        if ((s.button === "fresh") !== (fam === null)) throw new Error(`after "${s.button}" the demo data is wrong (family score ${fam}) — stopping before a bad take`);
        if (explainNext) await explain(explainNext);
        await waitProactive(0);
      }
    }
  }
  await dump("end");
  log("DONE — press Win+Alt+R to stop recording. Close Edge with Alt+F4.");
  if (ws) { ws.onclose = null; ws.close(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
