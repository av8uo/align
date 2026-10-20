/**
 * One-command AWS deploy: ECR push + Amazon ECS Express Mode service.
 *   npx tsx scripts/deploy-aws.ts            # preflight, then create or update (ONE attempt)
 *   npx tsx scripts/deploy-aws.ts --check    # preflight + cost estimate only, writes nothing
 *   npx tsx scripts/deploy-aws.ts --skip-build   # reuse the image already in ECR
 *
 * (App Runner is closed to new AWS accounts — SubscriptionRequiredException —
 * so the service runs on ECS Express Mode: Fargate + ALB + HTTPS, provisioned
 * by ECS from one API call.)
 *
 * Idempotent: an existing service is updated in place (new image revision).
 * Never retries a failed provisioning call; prints the exact AWS error and stops.
 * Reads credentials from .env / environment. Never prints secrets.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { ECRClient, CreateRepositoryCommand, DescribeImagesCommand, GetAuthorizationTokenCommand } from "@aws-sdk/client-ecr";
import { EC2Client, DescribeSubnetsCommand, DescribeVpcsCommand } from "@aws-sdk/client-ec2";
import { IAMClient, AttachRolePolicyCommand, CreateRoleCommand, GetRoleCommand, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import {
  ECSClient,
  CreateExpressGatewayServiceCommand,
  DescribeExpressGatewayServiceCommand,
  DescribeServiceDeploymentsCommand,
  ListServiceDeploymentsCommand,
  UpdateExpressGatewayServiceCommand,
  type ECSExpressGatewayService,
} from "@aws-sdk/client-ecs";

// ---- env ----
try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.replace(/\r$/, "").match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.trim();
  }
} catch { /* fine */ }
const region = process.env.AWS_REGION ?? "us-east-1";
const APP = "lifeos";
const CLUSTER = "default";
const PORT = 3344;
const CPU = "512"; // 0.5 vCPU
const MEMORY = "1024"; // 1 GiB
const ROLE_EXEC = `${APP}-ecs-execution-role`;
const ROLE_INFRA = `${APP}-ecs-infrastructure-role`;
const ROLE_TASK = `${APP}-ecs-task-role`;
const CHECK_ONLY = process.argv.includes("--check");
const SKIP_BUILD = process.argv.includes("--skip-build");
const log = (s: string) => console.log(`[deploy] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cfg = { region, maxAttempts: 2 }; // SDK-level retry only for transient network errors; provisioning calls are made once

const sts = new STSClient(cfg);
const ecr = new ECRClient(cfg);
const ec2 = new EC2Client(cfg);
const iam = new IAMClient(cfg);
const ecs = new ECSClient(cfg);

const errText = (e: unknown) => {
  const err = e as { name?: string; message?: string; $metadata?: { requestId?: string; httpStatusCode?: number } };
  return `${err.name ?? "Error"}: ${err.message ?? String(e)}${err.$metadata?.requestId ? ` (requestId ${err.$metadata.requestId})` : ""}`;
};

/** Monthly estimate at us-east-1 on-demand list prices (Oct 2026). */
function costEstimate(): string {
  const H = 730;
  const fargate = (Number(CPU) / 1024) * 0.04048 * H + (Number(MEMORY) / 1024) * 0.004445 * H;
  const alb = 0.0225 * H; // ALB hourly — shared by up to 25 Express services; one here
  const lcu = 0.008 * H * 0.25; // demo traffic stays far below one LCU; 0.25 LCU is generous
  const ipv4 = 0.005 * H * 3; // public IPv4: 2 ALB nodes + 1 task
  const logs = 0.5 * 0.1; // ~100 MB ingested/month; storage negligible
  const total = fargate + alb + lcu + ipv4 + logs;
  return [
    `Fargate ${Number(CPU) / 1024} vCPU / ${Number(MEMORY) / 1024} GiB, 1 task: $${fargate.toFixed(2)}/mo`,
    `Application Load Balancer: $${alb.toFixed(2)}/mo + LCU ≈ $${lcu.toFixed(2)}/mo`,
    `Public IPv4 addresses (3): $${ipv4.toFixed(2)}/mo`,
    `CloudWatch Logs (~100 MB): $${logs.toFixed(2)}/mo`,
    `ACM certificate: $0 · ECS Express Mode itself: $0`,
    `≈ $${total.toFixed(2)}/month ≈ $${(total / 30).toFixed(2)}/day — delete the service after the hackathon`,
  ].join("\n  ");
}

async function roleExists(name: string): Promise<string | null> {
  try {
    return (await iam.send(new GetRoleCommand({ RoleName: name }))).Role!.Arn!;
  } catch (e) {
    if ((e as Error).name === "NoSuchEntityException") return null;
    throw e;
  }
}

async function createRole(name: string, service: string): Promise<string> {
  const r = await iam.send(
    new CreateRoleCommand({
      RoleName: name,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { Service: service }, Action: "sts:AssumeRole" }],
      }),
      Tags: [{ Key: "project", Value: "align" }],
    }),
  );
  log(`created IAM role ${name}`);
  return r.Role!.Arn!;
}

async function describeService(arn: string): Promise<ECSExpressGatewayService | null> {
  try {
    return (await ecs.send(new DescribeExpressGatewayServiceCommand({ serviceArn: arn }))).service ?? null;
  } catch (e) {
    const name = (e as Error).name;
    if (name === "ServiceNotFoundException" || name === "ResourceNotFoundException") return null;
    if (name === "ClientException" && /not found|does not exist/i.test((e as Error).message)) return null;
    throw e;
  }
}

const endpointOf = (s: ECSExpressGatewayService | null) =>
  s?.activeConfigurations?.flatMap((c) => c.ingressPaths ?? []).find((p) => p.endpoint)?.endpoint ?? null;

async function main() {
  // ---- preflight (read-only) ----
  const who = await sts.send(new GetCallerIdentityCommand({}));
  const account = who.Account!;
  const registry = `${account}.dkr.ecr.${region}.amazonaws.com`;
  const image = `${registry}/${APP}:latest`;
  const serviceArn = `arn:aws:ecs:${region}:${account}:service/${CLUSTER}/${APP}`;
  log(`identity ${who.Arn}, region ${region}`);

  const vpcs = await ec2.send(new DescribeVpcsCommand({ Filters: [{ Name: "is-default", Values: ["true"] }] }));
  const vpcId = vpcs.Vpcs?.[0]?.VpcId;
  if (!vpcId) throw new Error(`no default VPC in ${region} — Express Mode needs one (EC2 console → VPC → Actions → Create default VPC)`);
  const subnets = (await ec2.send(new DescribeSubnetsCommand({ Filters: [{ Name: "vpc-id", Values: [vpcId] }] }))).Subnets ?? [];
  const usable = subnets.filter((s) => s.MapPublicIpOnLaunch && (s.AvailableIpAddressCount ?? 0) >= 8);
  const azs = new Set(usable.map((s) => s.AvailabilityZone));
  log(`default VPC ${vpcId}: ${usable.length} public subnets with ≥8 free IPs across ${azs.size} AZs`);
  if (azs.size < 2) throw new Error("Express Mode needs ≥2 public subnets in ≥2 AZs with ≥8 free IPs each");

  const roles = { exec: await roleExists(ROLE_EXEC), infra: await roleExists(ROLE_INFRA), task: await roleExists(ROLE_TASK) };
  for (const [k, v] of Object.entries(roles)) log(`role ${k}: ${v ?? "MISSING (will be created)"}`);

  const existing = await describeService(serviceArn);
  log(existing ? `service exists: ${existing.status?.statusCode} ${endpointOf(existing) ?? ""}` : "service does not exist yet");

  if (CHECK_ONLY) {
    log(`estimated cost:\n  ${costEstimate()}`);
    log("--check: nothing was created. Re-run without --check to deploy.");
    return;
  }

  // ---- ECR: repository + image ----
  try {
    await ecr.send(new CreateRepositoryCommand({ repositoryName: APP }));
    log("created ECR repository");
  } catch (e) {
    if ((e as Error).name !== "RepositoryAlreadyExistsException") throw e;
  }
  if (SKIP_BUILD) {
    await ecr.send(new DescribeImagesCommand({ repositoryName: APP, imageIds: [{ imageTag: "latest" }] }));
    log("--skip-build: reusing lifeos:latest already in ECR");
  } else {
    log("building image…");
    execSync(`docker build -t ${APP}:latest .`, { stdio: "inherit", cwd: new URL("..", import.meta.url) });
    const auth = await ecr.send(new GetAuthorizationTokenCommand({}));
    const token = Buffer.from(auth.authorizationData![0]!.authorizationToken!, "base64").toString();
    const password = token.split(":")[1]!;
    execSync(`docker login --username AWS --password-stdin ${registry}`, { input: password, stdio: ["pipe", "ignore", "inherit"] });
    execSync(`docker tag ${APP}:latest ${image}`, { stdio: "inherit" });
    log("pushing image to ECR…");
    execSync(`docker push ${image}`, { stdio: "inherit" });
  }

  // ---- IAM roles (created only if missing) ----
  let created = false;
  if (!roles.exec) {
    roles.exec = await createRole(ROLE_EXEC, "ecs-tasks.amazonaws.com");
    await iam.send(new AttachRolePolicyCommand({ RoleName: ROLE_EXEC, PolicyArn: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy" }));
    created = true;
  }
  if (!roles.infra) {
    roles.infra = await createRole(ROLE_INFRA, "ecs.amazonaws.com");
    await iam.send(
      new AttachRolePolicyCommand({ RoleName: ROLE_INFRA, PolicyArn: "arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices" }),
    );
    created = true;
  }
  if (!roles.task) {
    // Task role = what the running container may do: ONLY invoke Bedrock models.
    roles.task = await createRole(ROLE_TASK, "ecs-tasks.amazonaws.com");
    await iam.send(
      new PutRolePolicyCommand({
        RoleName: ROLE_TASK,
        PolicyName: "bedrock-invoke",
        PolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [{ Effect: "Allow", Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], Resource: "*" }],
        }),
      }),
    );
    created = true;
  }
  if (created) {
    log("waiting 20s for IAM propagation…");
    await sleep(20_000);
  }

  // ---- ECS Express service: create or update (single attempt) ----
  const container = {
    image,
    containerPort: PORT,
    environment: [
      { name: "LIFEOS_LLM", value: "bedrock" },
      { name: "AWS_REGION", value: region },
      { name: "PORT", value: String(PORT) },
    ],
  };
  try {
    if (existing) {
      log("updating Express service with the new image…");
      await ecs.send(
        new UpdateExpressGatewayServiceCommand({
          serviceArn,
          executionRoleArn: roles.exec!,
          taskRoleArn: roles.task!,
          healthCheckPath: "/healthz",
          primaryContainer: container,
          cpu: CPU,
          memory: MEMORY,
        }),
      );
    } else {
      log("creating ECS Express service (Fargate + ALB + HTTPS, this takes several minutes)…");
      await ecs.send(
        new CreateExpressGatewayServiceCommand({
          serviceName: APP,
          cluster: CLUSTER,
          executionRoleArn: roles.exec!,
          infrastructureRoleArn: roles.infra!,
          taskRoleArn: roles.task!,
          healthCheckPath: "/healthz",
          primaryContainer: container,
          cpu: CPU,
          memory: MEMORY,
          cpuArchitecture: "X86_64",
          // One task is plenty for a demo; min=max prevents any scale-out bill.
          scalingTarget: { minTaskCount: 1, maxTaskCount: 1, autoScalingMetric: "AVERAGE_CPU", autoScalingTargetValue: 60 },
          tags: [{ key: "project", value: "align" }],
        }),
      );
    }
  } catch (e) {
    throw new Error(`provisioning call failed — NOT retried. ${errText(e)}`);
  }

  // ---- wait for the deployment, then for the public URL to answer ----
  let endpoint: string | null = null;
  for (let i = 0; i < 45; i++) {
    await sleep(20_000);
    const s = await describeService(serviceArn);
    endpoint = endpointOf(s);
    let deployment = "";
    try {
      const list = await ecs.send(new ListServiceDeploymentsCommand({ service: APP, cluster: CLUSTER, maxResults: 1 }));
      const arn = list.serviceDeployments?.[0]?.serviceDeploymentArn;
      if (arn) {
        const d = (await ecs.send(new DescribeServiceDeploymentsCommand({ serviceDeploymentArns: [arn] }))).serviceDeployments?.[0];
        deployment = `${d?.status ?? "?"}${d?.statusReason ? ` (${d.statusReason})` : ""}`;
        if (d?.status && /FAILED|ROLLBACK/.test(d.status)) {
          throw new Error(`deployment ${deployment} — see ECS console → Clusters → default → lifeos → Deployments / Logs. Not retried.`);
        }
      }
    } catch (e) {
      if (/Not retried/.test((e as Error).message)) throw e;
      deployment = `(deployment status unavailable: ${(e as Error).name})`;
    }
    log(`service ${s?.status?.statusCode ?? "?"} · deployment ${deployment || "pending"} · ${endpoint ? `https://${endpoint}` : "no endpoint yet"}`);
    if (endpoint && /SUCCESSFUL/.test(deployment)) break;
  }
  if (!endpoint) throw new Error("timed out (15 min) waiting for the Express service endpoint");

  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`https://${endpoint}/healthz`, { signal: AbortSignal.timeout(10_000) });
      const body = await r.text();
      if (r.ok && body.includes('"ok"')) {
        console.log(`\n✅ LIVE: https://${endpoint}\n   simulator: https://${endpoint}/sim\n   MCP:       https://${endpoint}/mcp\n   health:    https://${endpoint}/healthz → ${body}`);
        return;
      }
      log(`healthz ${r.status}: ${body.slice(0, 120)}`);
    } catch (e) {
      log(`healthz not reachable yet (${(e as Error).name}: ${(e as Error).message}) — DNS/certificate propagation`);
    }
    await sleep(20_000);
  }
  throw new Error(`endpoint https://${endpoint} exists but /healthz never returned 200 within 10 min`);
}

main().catch((e) => {
  console.error(`[deploy] FAILED: ${errText(e)}`);
  process.exit(1);
});
