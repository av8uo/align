# AWS setup (owner's one-session checklist — unlocks Bedrock AND the public demo)

One AWS account powers both remaining blockers:
1. the **Bedrock brain** (Claude as the Alexa+ orchestrator — the AWS Builder prize), and
2. the **public demo on AWS App Runner** (always-on HTTPS URL for judges; Claude automates the deploy once your keys exist — you only do steps 1–4 below).

"Everything runs on AWS" is also the strongest possible AWS Builder story.

## 1. AWS account
- Sign in (or create a free account) at https://console.aws.amazon.com — free tier is enough.

## 2. Enable Claude model access in Bedrock
1. Console → search **Bedrock** → open it. Set the region (top-right) to **us-east-1** (N. Virginia).
2. Left menu → **Model access** → *Modify model access*.
3. Enable the **Anthropic Claude** models (at minimum the current Claude Sonnet). Approval is usually instant.

## 3. Create an IAM user
1. Console → **IAM** → Users → *Create user* → name: `lifeos-hackathon`.
2. Permissions → *Attach policies directly* → **AdministratorAccess**.
   (Pragmatic for one hackathon week in your personal account — it lets Claude set up ECR + App Runner + env config for you. Delete this user right after the hackathon. If you prefer least-privilege instead, attach: `AmazonBedrockFullAccess`, `AmazonEC2ContainerRegistryFullAccess`, `AWSAppRunnerFullAccess`, plus `iam:CreateRole`/`iam:PassRole` for the App Runner ECR access role.)
3. User → *Security credentials* → *Create access key* (choose "Application running outside AWS").
4. Copy the **Access key ID** and **Secret access key** once — they are shown only once.

## 4. Configure this project (PowerShell)
Never commit these. `.env` and shell env vars are both fine; `.env` is already gitignored.
```powershell
$env:AWS_ACCESS_KEY_ID = "AKIA..."
$env:AWS_SECRET_ACCESS_KEY = "..."
$env:AWS_REGION = "us-east-1"
$env:LIFEOS_LLM = "bedrock"
npm start
```
Optional model override: `$env:BEDROCK_MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"` (the default). If your account offers a newer Claude Sonnet inference profile, use its id instead.

## 5. Verify
1. `curl http://localhost:3344/healthz` → must show `"brain":"bedrock"`.
2. Open http://localhost:3344/sim and say something OUTSIDE the rules patterns, e.g. *"I feel like my weekends disappear, what should I do?"* — a useful, tool-grounded answer proves the LLM path (the rules brain would just file a check-in).
3. Failure drill (already covered by automated tests, worth seeing once): set `$env:AWS_ACCESS_KEY_ID="broken"`, restart, chat — the reply still works and the server log shows `bedrock brain failed (...); falling back to rules`.

## 6. Hand off to Claude (deployment)
Once the env vars from step 4 are set in the session, say so — Claude then:
1. creates an ECR repository and pushes the already-built Docker image,
2. creates the App Runner service (0.25 vCPU, health check on `/healthz`, env `LIFEOS_LLM=bedrock`),
3. gives you the public `https://….awsapprunner.com` URL and smoke-tests the full demo arc on it.
Expected cost: roughly $5–10 for the hackathon week; delete the service afterwards.

## Troubleshooting
| Symptom | Fix |
|---|---|
| `AccessDeniedException` on chat | Model access not enabled in this region → step 2, check region us-east-1 |
| `ExpiredTokenException` / `UnrecognizedClientException` | Key typo or inactive key → re-create the access key |
| Replies work but `/healthz` says `rules` | `LIFEOS_LLM=bedrock` not set in the same shell as `npm start` |
| Slow first reply | Cold model routing; subsequent calls are faster. The MCP tools themselves stay <500ms either way |
