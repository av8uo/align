# Enable the Bedrock brain (owner's 15-minute checklist)

The simulator ships with two interchangeable brains. The **rules brain** runs with zero setup (and is the automatic fallback). The **Bedrock brain** — Claude on Amazon Bedrock acting as the Alexa+ orchestrator — is what qualifies the AWS Builder mini challenge, and it needs YOUR AWS account. These are the exact steps.

## 1. AWS account
- Sign in (or create a free account) at https://console.aws.amazon.com — free tier is enough.

## 2. Enable Claude model access in Bedrock
1. Console → search **Bedrock** → open it. Set the region (top-right) to **us-east-1** (N. Virginia).
2. Left menu → **Model access** → *Modify model access*.
3. Enable the **Anthropic Claude** models (at minimum the current Claude Sonnet). Approval is usually instant.

## 3. Create an IAM user with a scoped key
1. Console → **IAM** → Users → *Create user* → name: `lifeos-bedrock`.
2. Attach policy: create an inline policy with just:
   ```json
   { "Version": "2012-10-17", "Statement": [{ "Effect": "Allow",
     "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
     "Resource": "*" }] }
   ```
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

## Troubleshooting
| Symptom | Fix |
|---|---|
| `AccessDeniedException` on chat | Model access not enabled in this region → step 2, check region us-east-1 |
| `ExpiredTokenException` / `UnrecognizedClientException` | Key typo or inactive key → re-create the access key |
| Replies work but `/healthz` says `rules` | `LIFEOS_LLM=bedrock` not set in the same shell as `npm start` |
| Slow first reply | Cold model routing; subsequent calls are faster. The MCP tools themselves stay <500ms either way |
