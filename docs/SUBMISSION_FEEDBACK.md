# Product Feedback, Friction Log & Feature Requests

Everything below happened for real while building Align during the hackathon window (Oct 19–20, 2026), on Windows 11, with a brand-new AWS account. Timestamps and error strings are verbatim.

---

## Part 1 — Product feedback (every tool we used)

### Alexa+ MCP Toolkit & developer docs
- **Used for:** the integration architecture — Align is an MCP add-on by design (13 tools, Streamable HTTP, spec 2025-11-25); the certification and design guides drove our tool contracts, voice-only parity, latency budget, and memory-transparency tools.
- **What worked well:** the MCP-first architecture is exactly right — we built one server and it runs under our simulated host *and* Claude unchanged. The design guide (conversation surface, display modes, 768×480 tokens) is unusually concrete, and the functional-requirements page reads like a real QA checklist — we turned it into our test plan.
- **What needs work:** the docs contradict themselves on the MCP protocol version (2025-11-25 stated; lifecycle example sends `2025-03-26`; Local Inspector example sends `2025-06-18`). The docs-home "Supported Capabilities" link 404s (`/docs/add-ons/.add-ons/…`). The quickstart's "MCP Apps standard" link points at the Streamable-HTTP transport section. Setup documents macOS/Ubuntu only. Most importantly: there is **no API for add-on-initiated turns**, which rules out an entire category of proactive agents (see Feature Request #1).
- **Onboarding:** we could not evaluate the real deploy path — the Private Preview gate meant everything past the docs was closed to us; we built a simulated host instead and clearly label it.
- **Build with it again?** Yes, emphatically — once GA. The MCP bet makes our work portable either way.

### MCP TypeScript SDK (`@modelcontextprotocol/sdk` 1.32)
- **Used for:** both sides of the wire — the server (stateless `StreamableHTTPServerTransport`, zod-validated `registerTool`) and the host (`Client` + `StreamableHTTPClientTransport`), plus our wire-level tests.
- **Worked well:** stateless HTTP mode is perfect for serverless-ish deploys; `registerTool` with zod input *and* output schemas caught real bugs; client and server in one package made end-to-end tests trivial.
- **Needs work:** the structuredContent ⇄ outputSchema contract is under-documented — we declared output schemas everywhere defensively.
- **Again?** Yes.

### Amazon Bedrock (Claude, Converse API)
- **Used for:** the agentic orchestration loop — Claude reads the MCP tool catalog, chooses tools, chains calls, and phrases the spoken reply ([src/sim/bedrock.ts](../src/sim/bedrock.ts)).
- **Worked well:** the Converse tool-use loop is clean (`toolConfig` → `stopReason: "tool_use"` → `toolResult`); mapping MCP tool schemas to Bedrock `toolSpec` was ~10 lines; IAM instance roles mean our cloud container holds zero keys.
- **What needs work:** the **new-account first-run experience** is a gauntlet — four distinct failures before the first successful call, each with an error that under-explains (full details in the friction log): the retired model-access page vs. the hidden use-case form; the one-time `aws-marketplace:Subscribe` requirement; day-one token quotas with an opaque "Too many tokens per day" error; and multi-hour silent account activation.
- **Onboarding:** rough for a genuinely new account; would be fine on a mature one.
- **Again?** Yes — the runtime API is good; the first-day funnel needs love.

### AWS App Runner → ECS Express Mode + ECR + IAM
- **Used for:** the public demo deployment — one idempotent script ([scripts/deploy-aws.ts](../scripts/deploy-aws.ts)) builds, pushes to ECR, provisions three least-privilege roles, creates the service, waits for healthy, and only prints a URL once `/healthz` answers over HTTPS.
- **Worked well:** the "container in, HTTPS URL out, task role for credentials" shape is right for hackathon-to-production, and ECS Express Mode delivers it in a single `CreateExpressGatewayService` call (ALB, certificate, security groups, log group, autoscaling all managed). ECR push with scoped, repo-pinned permissions works.
- **Needs work:** App Runner is **closed to new accounts**, but its error — `SubscriptionRequiredException: The AWS Access Key Id needs a subscription for the service` — reads like a **paywall**, not "this service is not available to you; use ECS Express Mode" (friction log F4). The caller-side IAM action set for Express Mode is only documented in a GitHub Action README, not in the ECS guide (F8).
- **Again?** Yes — ECS Express Mode specifically.

### Node.js `node:sqlite`
- **Used for:** the entire life-state model — 12 tables, synchronous reads keeping tool latency in single-digit milliseconds.
- **Worked well:** zero native-module pain on Windows (a real historical problem), in-memory databases made 40 tests fast.
- **Needs work:** nothing blocking. **Again?** Absolutely.

---

## Part 2 — Friction log

> Format per hackathon rules: task → steps → expected vs actual → severity → workaround → actionable suggestion.

### F1 — Finding the Anthropic use-case form (Bedrock)
- **Task:** enable first-time Claude access on a new AWS account.
- **Steps:** invoked the model → error: *"Model use case details have not been submitted… Fill out the Anthropic use case details form"* → went to Bedrock **Model access** → page says it has been **retired** ("models are now automatically enabled") → no link to any form → eventually found "Submit use case details" on the **Model catalog → Claude Sonnet** detail page.
- **Expected:** the error (or the retired page) links directly to the form.
- **Actual:** two dead ends; the form lives on a page the error never mentions.
- **Severity:** High. **Workaround:** manual console exploration.
- **Suggestion:** put the form's deep link in the error message itself, and on the retired model-access page.

### F2 — The hidden one-time Marketplace permission (Bedrock)
- **Task:** first Claude invocation with a least-privilege key (`bedrock:InvokeModel` only).
- **Steps:** invoked → *"not authorized to perform the required AWS Marketplace actions (aws-marketplace:ViewSubscriptions, aws-marketplace:Subscribe)"*.
- **Expected:** `bedrock:InvokeModel` to suffice, per the Bedrock permission docs we read.
- **Actual:** the **first** invocation per account also performs a Marketplace subscription and needs those two actions on the calling principal; nothing in the quota/permission docs we found describes the attach-once-then-detach pattern.
- **Severity:** High for least-privilege users (Admin users never see it — which is exactly who writes the docs).
- **Workaround:** temporary bootstrap policy with the two actions; detached after the first successful call.
- **Suggestion:** error should say "one-time, account-level" and link a doc; publish a scoped condition example.

### F3 — "Too many tokens per day" with no numbers (Bedrock)
- **Task:** first real conversation through Claude after authorization succeeded.
- **Steps:** 2–3 requests (~6–8K tokens each: a 13-tool catalog is heavy) → *"Too many tokens per day, please wait before trying again."*
- **Expected:** the error to name the quota, its value, current usage, and reset time.
- **Actual:** none of those; correlating to a specific Service Quotas entry as a beginner is guesswork; switching models (Sonnet→Haiku) hit the same wall, so it appears account-wide for day-one accounts.
- **Severity:** High during a time-boxed hackathon.
- **Workaround:** our architecture's deterministic fallback brain kept the demo fully functional — but that was our doing, not the platform's.
- **Suggestion:** include quota name + reset timestamp in the error; surface day-one limits prominently in the Bedrock getting-started page.
- **Follow-up (day 3):** a 15-token probe against Sonnet 4.5 *and* Haiku 4.5 returns the same `ThrottlingException` (HTTP 429), so this is account-level. The Service Quotas reference lists **no adjustable "tokens per day" quota for Claude Sonnet 4.5** — only per-minute ones (e.g. *Cross-region model inference tokens per minute for Anthropic Claude Sonnet 4.5 V1*, default 5,000,000) — so a self-service increase request cannot address a per-*day* throttle; only a Support case can. The error gives a beginner no way to discover that. We also made the client side responsible: one throttle now opens a circuit breaker until the next UTC day, so no further requests are burned on a quota that is known to be exhausted.

### F4 — Account activation masquerading as a paywall (AWS)
- **Task:** create the App Runner service, ~2–10 hours after account signup.
- **Steps:** `apprunner:ListServices` → `SubscriptionRequiredException: The AWS Access Key Id needs a subscription for the service` — repeatedly, for 9+ hours, while IAM/ECR/STS worked and Bedrock activated partway through.
- **Expected:** an error saying "your account is still being activated," and some console surface showing activation status.
- **Actual:** wording that implies a missing *paid subscription* (our non-expert founder asked, verbatim, *"should I pay maybe something?"*); billing console shows no banner, no status, nothing actionable.
- **Severity:** High — it nearly caused an unnecessary payment and cost a night of uncertainty.
- **Workaround:** a 20-minute retry loop and patience — which could never have worked: App Runner is no longer open to new customers (AWS now recommends ECS Express Mode). We ported the deploy script to `CreateExpressGatewayService` on day 3.
- **Suggestion:** the error should say *"App Runner is not available to this account; see ECS Express Mode"*, and the console should show it.

### F5 — The undocumented minimal IAM set for `docker push` (ECR)
- **Task:** push an image with a least-privilege policy.
- **Steps:** granted the five commonly-cited push actions → all layers uploaded → final manifest step failed: *"not authorized to perform: ecr:BatchGetImage"*.
- **Expected:** the commonly-documented "push" action set to be sufficient.
- **Actual:** `docker push` also needs `ecr:BatchGetImage` (manifest check) — discovered only at the last step of a multi-minute upload.
- **Severity:** Medium. **Workaround:** add the action, re-push (layers cached).
- **Suggestion:** one canonical "minimal policy for docker push" snippet in the ECR docs.

### F6 — Alexa+ docs internal contradictions
- **Task:** pin the MCP protocol version and follow doc links.
- **Steps/Actual:** three different `protocolVersion` values across overview (2025-11-25), client-lifecycle example (2025-03-26), and Local Inspector example (2025-06-18); docs-home "Supported Capabilities" link 404s; quickstart's "MCP Apps" link targets the transport spec.
- **Severity:** Medium (cost: an hour of cross-checking; we targeted 2025-11-25 and negotiated down).
- **Suggestion:** one canonical version constant across samples; link checker in the docs CI.

### F7 — No Windows path in Alexa+ setup
- **Task:** set up the Alexa+ dev environment on Windows 11 (where this entire project was built).
- **Actual:** prerequisites list macOS/Ubuntu only; inspector commands are bash with a manual Windows translation table.
- **Severity:** Medium. **Suggestion:** first-class Windows (or WSL-official) instructions.

---

### F8 — ECS Express Mode: the deploying user's permissions are undocumented (ECS)
- **Task:** port the deploy to ECS Express Mode with a least-privilege IAM user (no AdministratorAccess), after App Runner turned out to be closed to new accounts.
- **Steps:** read the Express Mode developer guide, the `CreateExpressGatewayService` API reference and the infrastructure-role managed policy → all describe the *roles* ECS assumes, none lists what the *caller* needs → preflight failed on `UnauthorizedOperation: ec2:DescribeVpcs`; the full action list (`ecs:CreateCluster`, `ecs:RegisterTaskDefinition`, `ecs:CreateExpressGatewayService`, `ecs:DescribeExpressGatewayService`, `ecs:ListServiceDeployments`, `ecs:DescribeServiceDeployments`, `ecs:TagResource`, `iam:PassRole` to `ecs.amazonaws.com` **and** `ecs-tasks.amazonaws.com`, `iam:CreateServiceLinkedRole` for ECS) was eventually assembled from the `aws-actions/amazon-ecs-deploy-express-service` README and a third-party CloudFormation reference.
- **Expected:** a "permissions for the user creating an Express service" section next to the role docs, as every other ECS guide page has.
- **Actual:** not in the developer guide; found by trial and error plus a GitHub Action README.
- **Severity:** Medium (High for anyone refusing AdministratorAccess).
- **Workaround:** the 9-statement policy in our repo (`docs/aws-private/deploy-user-policy.json`, private) — written once, verified by the script's `--check` preflight.
- **Suggestion:** publish the minimal caller policy for `create-express-gateway-service` in the Express Mode guide, including the two PassRole service principals.

## Part 3 — Feature requests

| # | Request | Why it matters | Urgency |
|---|---|---|---|
| 1 | **Add-on-initiated proactive turns** (and/or scheduled briefings) for MCP add-ons | Today add-ons only *respond*. An entire category — agents that watch, anticipate, and speak first (like Align's morning briefing and quiet rule) — cannot exist on the real platform. We simulate it and label it; we'd rather ship it. | **Critical** |
| 2 | **Pass recognized-speaker identity (Voice ID) to MCP tools** | Per-person memory, goals, and privacy boundaries in multi-person households; our schema is ready for it today. | Important |
| 3 | **Bedrock: transparent day-one quotas** — value + reset time in the throttle error | Time-boxed builders (hackathons!) can't plan around invisible limits. | Important |
| 4 | **AWS account-activation status surface** + distinct activation-pending error | Prevents the "do I need to pay?" moment; see friction F4. | Important |
| 5 | **Windows support for Alexa+ tooling** | Large developer population; this project proves it's viable. | Important |
| 6 | One canonical `protocolVersion` across all Alexa+ MCP samples | Removes the most confusing hour of integration. | Nice-to-have |
