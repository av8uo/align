/**
 * One-command AWS deploy: ECR push + App Runner service.
 *   npx tsx scripts/deploy-aws.ts
 *
 * Idempotent: re-running updates the existing service (new image -> StartDeployment).
 * Reads credentials from .env / environment. Never prints secrets.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { ECRClient, CreateRepositoryCommand, GetAuthorizationTokenCommand } from "@aws-sdk/client-ecr";
import {
  IAMClient, CreateRoleCommand, AttachRolePolicyCommand, PutRolePolicyCommand, GetRoleCommand,
} from "@aws-sdk/client-iam";
import {
  AppRunnerClient, CreateServiceCommand, ListServicesCommand, DescribeServiceCommand, StartDeploymentCommand,
} from "@aws-sdk/client-apprunner";

// ---- env ----
try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.replace(/\r$/, "").match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.trim();
  }
} catch { /* fine */ }
const region = process.env.AWS_REGION ?? "us-east-1";
const APP = "lifeos";
const log = (s: string) => console.log(`[deploy] ${s}`);

const sts = new STSClient({ region });
const ecr = new ECRClient({ region });
const iam = new IAMClient({ region });
const apprunner = new AppRunnerClient({ region });

async function ensureRole(name: string, service: string, setup: () => Promise<void>): Promise<{ arn: string; created: boolean }> {
  try {
    const r = await iam.send(new GetRoleCommand({ RoleName: name }));
    return { arn: r.Role!.Arn!, created: false };
  } catch {
    const r = await iam.send(
      new CreateRoleCommand({
        RoleName: name,
        AssumeRolePolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [{ Effect: "Allow", Principal: { Service: service }, Action: "sts:AssumeRole" }],
        }),
      }),
    );
    await setup();
    log(`created IAM role ${name}`);
    return { arn: r.Role!.Arn!, created: true };
  }
}

async function main() {
  const who = await sts.send(new GetCallerIdentityCommand({}));
  const account = who.Account!;
  const registry = `${account}.dkr.ecr.${region}.amazonaws.com`;
  const image = `${registry}/${APP}:latest`;
  log(`account ${account}, region ${region}`);

  // 1) ECR repository
  try {
    await ecr.send(new CreateRepositoryCommand({ repositoryName: APP }));
    log("created ECR repository");
  } catch (e) {
    if ((e as Error).name !== "RepositoryAlreadyExistsException") throw e;
    log("ECR repository exists");
  }

  // 2) Build, login, push
  log("building image…");
  execSync(`docker build -t ${APP}:latest .`, { stdio: "inherit", cwd: new URL("..", import.meta.url) });
  const auth = await ecr.send(new GetAuthorizationTokenCommand({}));
  const token = Buffer.from(auth.authorizationData![0]!.authorizationToken!, "base64").toString();
  const password = token.split(":")[1]!;
  execSync(`docker login --username AWS --password-stdin ${registry}`, { input: password, stdio: ["pipe", "ignore", "inherit"] });
  execSync(`docker tag ${APP}:latest ${image}`, { stdio: "inherit" });
  log("pushing image to ECR…");
  execSync(`docker push ${image}`, { stdio: "inherit" });

  // 3) Roles: ECR pull access + instance role with ONLY bedrock:InvokeModel*
  const access = await ensureRole(`${APP}-apprunner-ecr-access`, "build.apprunner.amazonaws.com", async () => {
    await iam.send(
      new AttachRolePolicyCommand({
        RoleName: `${APP}-apprunner-ecr-access`,
        PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess",
      }),
    );
  });
  const instance = await ensureRole(`${APP}-instance-role`, "tasks.apprunner.amazonaws.com", async () => {
    await iam.send(
      new PutRolePolicyCommand({
        RoleName: `${APP}-instance-role`,
        PolicyName: "bedrock-invoke",
        PolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [{ Effect: "Allow", Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], Resource: "*" }],
        }),
      }),
    );
  });
  if (access.created || instance.created) {
    log("waiting 15s for IAM propagation…");
    await new Promise((r) => setTimeout(r, 15_000));
  }

  // 4) App Runner service (create or redeploy)
  const services = await apprunner.send(new ListServicesCommand({}));
  const existing = services.ServiceSummaryList?.find((s) => s.ServiceName === APP);
  let serviceArn: string;
  if (existing) {
    serviceArn = existing.ServiceArn!;
    log("service exists — starting redeployment with the new image…");
    await apprunner.send(new StartDeploymentCommand({ ServiceArn: serviceArn }));
  } else {
    log("creating App Runner service…");
    const created = await apprunner.send(
      new CreateServiceCommand({
        ServiceName: APP,
        SourceConfiguration: {
          AuthenticationConfiguration: { AccessRoleArn: access.arn },
          AutoDeploymentsEnabled: false,
          ImageRepository: {
            ImageIdentifier: image,
            ImageRepositoryType: "ECR",
            ImageConfiguration: {
              Port: "3344",
              RuntimeEnvironmentVariables: { LIFEOS_LLM: "bedrock", AWS_REGION: region },
            },
          },
        },
        InstanceConfiguration: { Cpu: "512", Memory: "1024", InstanceRoleArn: instance.arn },
        HealthCheckConfiguration: { Protocol: "HTTP", Path: "/healthz", Interval: 10, Timeout: 5 },
      }),
    );
    serviceArn = created.Service!.ServiceArn!;
  }

  // 5) Wait until RUNNING
  for (let i = 0; i < 60; i++) {
    const d = await apprunner.send(new DescribeServiceCommand({ ServiceArn: serviceArn }));
    const status = d.Service!.Status!;
    const url = d.Service!.ServiceUrl;
    log(`status: ${status}${url ? ` — https://${url}` : ""}`);
    if (status === "RUNNING") {
      console.log(`\n✅ LIVE: https://${url}\n   simulator: https://${url}/sim\n   MCP:       https://${url}/mcp\n   health:    https://${url}/healthz`);
      return;
    }
    if (status.includes("FAILED")) throw new Error(`service entered ${status} — check App Runner logs in the console`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
  throw new Error("timed out waiting for RUNNING");
}

main().catch((e) => {
  console.error(`[deploy] FAILED: ${(e as Error).message}`);
  process.exit(1);
});
