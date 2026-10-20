# AWS setup (owner's checklist — Bedrock brain + public demo on ECS Express Mode)

One AWS account powers both:
1. the **Bedrock brain** (Claude as the Alexa+ orchestrator — the AWS Builder prize), and
2. the **public demo on Amazon ECS Express Mode** (Fargate + Application Load Balancer + HTTPS, provisioned by one API call; Claude automates the deploy — you only do the console steps below).

> App Runner was the original target. It is **closed to new AWS accounts** (`SubscriptionRequiredException`), so the deploy script now targets ECS Express Mode. Nothing else changed: same Docker image, same port, same `/healthz`.

> **Submission decision (Oct 20):** the hosted deployment is **deferred** — ≈ $45/month is not justified for a demo that judges can run locally in two commands, and the Official Rules require only a repository + video. Steps 2–3 below are kept for later; **do not run step 3** unless you accept the cost. `--check` is always safe (read-only).

## 1. Already done (keep)
- IAM user `lifeos-hackathon` with access keys in `.env` (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION=us-east-1`, `LIFEOS_LLM=bedrock`).
- Bedrock: Anthropic use-case form submitted, Claude models authorized, marketplace subscription done.
- ECR repository `lifeos` with the image pushed.

## 2. Update the deploy user's policy (console, ~3 minutes) — REQUIRED before deploying
The script needs ECS/EC2-read/IAM-role permissions that the old App Runner policy does not grant. Replace the inline policy with [docs/aws-private/deploy-user-policy.json](aws-private/deploy-user-policy.json) (private, gitignored).

1. Console → **IAM** → **Utilisateurs** → `lifeos-hackathon` → onglet **Autorisations**.
2. In the list, open the inline policy **`lifeos-deploy-least-privilege`** → **Modifier**.
3. Choose **JSON**, select all, paste the full content of `deploy-user-policy.json` → **Suivant** → **Enregistrer les modifications**.
4. Verify from the project folder (read-only, creates nothing):
   ```bash
   npx tsx scripts/deploy-aws.ts --check
   ```
   Expected: identity, default VPC with ≥2 public subnets, three roles reported `MISSING (will be created)`, a cost estimate, and `--check: nothing was created`.

What the policy allows, and nothing more: push to the one ECR repo; read the default VPC/subnets; create/read exactly three roles named `lifeos-ecs-*` and attach only the two AWS-managed ECS policies to them; pass those roles only to ECS; create/update/describe/delete ECS Express services; create the ECS service-linked role once.

## 3. Deploy (one attempt, ~8–12 minutes)
```bash
npx tsx scripts/deploy-aws.ts --skip-build
```
(`--skip-build` reuses the image already in ECR; omit it after code changes.) The script creates the three roles if missing, calls `CreateExpressGatewayService` **once**, follows the deployment, then polls `https://<endpoint>/healthz`. It prints `✅ LIVE` **only** when `/healthz` returns 200 over HTTPS. On any AWS error it prints the exact exception + request id and stops — it never retries provisioning.

Re-running later updates the existing service in place (new image revision, canary rollout).

**Cost (us-east-1, list prices):** Fargate 0.5 vCPU/1 GiB ≈ $18/month, ALB ≈ $16/month + LCU, public IPv4 ≈ $11/month, logs < $1 → **≈ $1.50/day**. Delete the service after the hackathon (ECS console → Clusters → default → Services → lifeos → **Supprimer**), which also removes the ALB listener/target group; the ALB itself is deleted once no Express service uses it.

## 4. Bedrock daily quota (the remaining blocker)
Symptom: every Claude call returns `ThrottlingException (HTTP 429): Too many tokens per day, please wait before trying again.` — for Sonnet 4.5 **and** Haiku 4.5, i.e. account-level. Verify any time with:
```bash
npx tsx scripts/bedrock-probe.ts
```
(one ~15-token request per model; prints the exact error name, message and request id, or `✅` once it works).

Facts that matter:
- Model: `us.anthropic.claude-sonnet-4-5-20250929-v1:0` (cross-region inference profile), API: Converse, region us-east-1.
- The AWS quota reference lists **no adjustable "tokens per day" quota for Claude Sonnet 4.5**. The per-minute quota you requested on Oct 20 (*Cross-region model inference tokens per minute for Anthropic Claude Sonnet 4.5 V1*, default 5,000,000) is a different window and **cannot** lift a per-day throttle.
- This is a known new-account condition; the only route is a Support case.

**Open the Support case (free on Basic support):** Console → **Support** → **Centre de support** → **Créer un cas** → **Augmentation des limites de service** (service limit increase) → Service: **Amazon Bedrock** → Region **US East (N. Virginia)** → Quota: *tokens per day* for **Anthropic Claude Sonnet 4.5** (cross-region profile `us.anthropic.claude-sonnet-4-5-20250929-v1:0`) → Description:

> New account (created Oct 2026). Every Converse call to Anthropic Claude Sonnet 4.5 and Claude Haiku 4.5 in us-east-1 returns ThrottlingException "Too many tokens per day" (e.g. request id ddef6098-8c39-46ee-b7b2-7a0fcae69a29). Use case: hackathon demo (Amazon Developer Hackathon, Alexa+ track, deadline Oct 23). Model access and marketplace subscription are already approved. Please raise the daily token quota for Claude Sonnet 4.5 from 0 to the default.

Meanwhile the server stays fully functional: the Bedrock brain's **circuit breaker** opens on the first throttle until the next UTC day and every turn is answered by the deterministic rules brain through the same MCP tools. `GET /healthz` shows it: `"bedrock": {"open": true, "until": "...", "reason": "...", "trips": 1}`.

## 5. Verify the brain
1. `curl http://localhost:3344/healthz` → `"brain":"bedrock"` and `"bedrock":{"open":false,...}` once the quota is lifted.
2. Open http://localhost:3344/sim and say something OUTSIDE the rules patterns, e.g. *"I feel like my weekends disappear, what should I do?"* — a tool-grounded answer proves the LLM path.
3. Failure drill (covered by automated tests): set `AWS_ACCESS_KEY_ID=broken`, restart, chat — the reply still works and the log shows `bedrock brain failed (...); falling back to rules`.

## 6. After the hackathon
- Delete the ECS Express service (step 3), then the three `lifeos-ecs-*` roles, the ECR repository, and the IAM user.

## Troubleshooting
| Symptom | Fix |
|---|---|
| `UnauthorizedOperation: … ec2:DescribeVpcs` on `--check` | Step 2 not done yet (old policy still attached) |
| `AccessDeniedException` on chat | Model access not enabled in this region → Bedrock → Model access, region us-east-1 |
| `ThrottlingException: Too many tokens per day` | Step 4 — Support case; the demo keeps working on the rules brain |
| Replies work but `/healthz` says `rules` | `LIFEOS_LLM=bedrock` not set in the same shell as `npm start` |
| `/healthz` says `bedrock` but `"open": true` | Circuit breaker is open after a throttle; closes automatically at the shown time (restart the server to force) |
| Deploy: deployment `FAILED`/`ROLLBACK` | ECS console → Clusters → default → lifeos → Journaux: container logs; typical cause is the task failing `/healthz` within 300 s |