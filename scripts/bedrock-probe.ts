/**
 * Bedrock quota probe: one ~15-token Converse call per model, reporting the
 * exact SDK error name, message and request id. Costs a fraction of a cent
 * when a model answers. Run it to learn the moment the daily quota unlocks:
 *   npx tsx scripts/bedrock-probe.ts
 *   npx tsx scripts/bedrock-probe.ts us.anthropic.claude-haiku-4-5-20251001-v1:0   # extra ids
 */
import { readFileSync } from "node:fs";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.replace(/\r$/, "").match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.trim();
  }
} catch { /* fine */ }

const region = process.env.AWS_REGION ?? "us-east-1";
const models = [process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0", ...process.argv.slice(2)];
const client = new BedrockRuntimeClient({ region, maxAttempts: 1 });

console.log(`region ${region}`);
for (const modelId of models) {
  const t0 = Date.now();
  try {
    const r = await client.send(
      new ConverseCommand({ modelId, messages: [{ role: "user", content: [{ text: "Reply with the single word: ready" }] }], inferenceConfig: { maxTokens: 5 } }),
    );
    const text = r.output?.message?.content?.map((c) => c.text ?? "").join("") ?? "";
    console.log(`✅ ${modelId}: "${text.trim()}" · tokens in=${r.usage?.inputTokens} out=${r.usage?.outputTokens} · ${Date.now() - t0} ms · requestId ${r.$metadata.requestId}`);
  } catch (e) {
    const err = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number; requestId?: string } };
    console.log(`❌ ${modelId}: ${err.name} (HTTP ${err.$metadata?.httpStatusCode ?? "?"}): ${err.message} · requestId ${err.$metadata?.requestId ?? "?"}`);
  }
}
