const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { _electron, expect } = require("../../frontend/node_modules/@playwright/test");

const project = path.resolve(__dirname, "..");
const fixtures = process.env.E2E_FIXTURES || "D:/workspace/we-meet-e2e-fixtures";
const issuer = process.env.E2E_ISSUER || "http://localhost:8083/realms/meet";
const apiOrigin = process.env.E2E_WORK_API || "http://127.0.0.1:8080";
const gatewayOrigin = process.env.E2E_WORK_GATEWAY || "https://127.0.0.1:9443";
const dbContainer = process.env.E2E_PG_CONTAINER || "work-pg16";
const dbName = process.env.E2E_DB || "work_e2e";
const output = path.join(project, "test-results", "work-e2e");
fs.mkdirSync(output, { recursive: true });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let stopApprover = null;
async function until(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await wait(100);
  }
  throw new Error(`timed out: ${label}${last ? `: ${last.message}` : ""}`);
}
function psql(sql) {
  return execFileSync("docker", ["exec", dbContainer, "psql", "-U", "postgres", "-d", dbName, "-tAc", sql], { encoding: "utf8" }).trim();
}
function one(sql) { return psql(sql).split("\n").pop().trim(); }
// The local face refuses approval creation until the org has a configured policy
// (set_local_policy bumps effective_epoch; request_approval requires > 0). A real admin
// PATCHes /work/v2/admin/local-policy; the harness provisions the same document directly.
function provisionLocalPolicy(actor) {
  const org = one("select id from work.org order by created_at limit 1");
  const revision = Number(one(`select revision from work.local_execution_policy where org_id='${org}'`) || 0);
  // The composer grants the workspace with all four workspace tools, so the org allowlist
  // must contain them; a single-rule policy matches every path under the granted root.
  const document = JSON.stringify({
    allowed_tools: ["workspace.list", "workspace.read", "workspace.search", "artifact.write"],
    allowed_destinations: ["device_local"],
    classification_rules: [{ matcher: { path_prefix: "" }, classification: "local_only", max_confirmable: "local_only" }],
    classification_default: "local_only",
    classification_default_confirmed: true,
    classification_floor: "local_only",
    readonly_max_actions: 3,
    readonly_ttl: "1 hour",
    input_limit_bytes: 262144,
    output_limit_bytes: 262144,
  }).replace(/'/g, "''");
  psql(`begin; select set_config('app.org_id','${org}',true); select set_config('app.subject_id','${actor}',true); select work.set_local_policy('${org}', ${revision}, '${document}'::jsonb, '${actor}', 'e2e-local-policy-${revision + 1}'); commit`);
  return org;
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
function proxyWork(req, res, token) {
  const upstream = new URL(req.url, apiOrigin);
  const headers = { ...req.headers, host: upstream.host };
  if (upstream.pathname === "/work/v2/tasks") {
    const auth = String(req.headers.authorization || "");
    const claims = auth.startsWith("Bearer ") ? JSON.parse(Buffer.from(auth.slice(7).split(".")[1], "base64url").toString("utf8")) : {};
    console.error("submit headers", { authorization: auth.slice(0, 24), client: req.headers["x-work-client"], cookie: Boolean(req.headers.cookie), token: { sub: claims.sub, iss: claims.iss, aud: claims.aud, exp: claims.exp, iat: claims.iat }, now: Math.floor(Date.now() / 1000) });
    const bodyChunks = [];
    req.on("data", (chunk) => bodyChunks.push(chunk));
    req.on("end", () => console.error("submit body", Buffer.concat(bodyChunks).toString("utf8")));
  }
  const cookie = `sessionid=${encodeURIComponent(token)}`;
  headers.cookie = headers.cookie ? `${headers.cookie}; ${cookie}` : cookie;
  const call = upstream.protocol === "https:" ? https.request : http.request;
  const out = call(upstream, { method: req.method, headers }, (up) => {
    const chunks = [];
    const capture = upstream.pathname === "/work/v2/tasks" || upstream.pathname === "/work/v2/local-task-previews";
    if (capture) up.on("data", (chunk) => chunks.push(chunk));
    if (capture) up.on("end", () => console.error("work response", upstream.pathname, up.statusCode, Buffer.concat(chunks).toString("utf8").slice(0, 2000)));
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  out.on("error", () => { res.writeHead(502); res.end("work api unavailable"); });
  req.pipe(out);
}
const https = require("node:https");
async function main() {
  const tokenResponse = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "desktop", username: "meet", password: "meet", scope: "openid profile email" }),
  });
  const token = await tokenResponse.json();
  if (!token.access_token) throw new Error(`token grant failed: ${token.error_description || token.error}`);
  const tokenFile = path.join(output, "token.json");
  fs.writeFileSync(tokenFile, JSON.stringify(token));
  const actor = JSON.parse(Buffer.from(token.access_token.split(".")[1], "base64url").toString("utf8")).sub;
  provisionLocalPolicy(actor);

  const renderer = path.resolve(project, "../frontend/dist");
  let sessionTickets = 0;
  const proxy = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://fixture.invalid").pathname;
    if (req.method === "POST" && pathname.endsWith("/session-tickets")) sessionTickets += 1;
    if (pathname.startsWith("/work/v1/") || pathname.startsWith("/work/v2/")) { console.error("proxy", req.method, pathname); return proxyWork(req, res, token.access_token); }
    if (pathname === "/api/v1.0/config/") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ feedback: { url: "" }, background_image: {}, subtitle: { enabled: false }, telephony: { enabled: false }, livekit: { url: "", default_sources: [] }, is_silent_login_enabled: false }));
    }
    if (/^\/api\/v1\.0\/users\/me\/?$/.test(pathname)) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ id: "meet", email: "meet@example.test", full_name: "Work E2E", language: "zh", timezone: "Asia/Shanghai" }));
    }
    if (pathname.startsWith("/api/v1.0/")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ results: [], count: 0, items: [] }));
    }
    let file = path.join(renderer, pathname);
    if (!file.startsWith(renderer) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(renderer, "index.html");
    res.setHeader("content-type", mime[path.extname(file)] || "application/octet-stream");
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const serviceOrigin = `http://127.0.0.1:${proxy.address().port}`;

  let app;
  let fixture;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "work-e2e-"));
  const userData = path.join(root, "userData");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "out"), { recursive: true });
  const fixturePort = await freePort();
  const modelReady = path.join(root, "model-ready");
  const deviceLog = path.join(root, "device.log");
  const scenario = path.join(root, "scenario.json");
  // The fixture loop is model → artifact.write → stop. The model-only leg is the one this smoke
  // drives: the approval wait is the point, and a Run that writes no sealed artifact ends with
  // the design's no_deliverable finish, which is the expected terminal for this fixture.
  fs.writeFileSync(scenario, JSON.stringify([{ role: "assistant", content: "Work E2E model completed." }]));
  fixture = spawn(path.join(project, "dist", "work-device", "node.exe"), [path.join(project, "dist", "work-device", "work-device-bundle", "fixture-server.mjs"), String(fixturePort), scenario], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture model did not start")), 10000);
    fixture.stdout.once("data", (chunk) => { clearTimeout(timer); String(chunk).includes("fixture listening") ? resolve() : reject(new Error("fixture model failed")); });
    fixture.once("error", reject);
  });
  const env = { ...process.env, WEMEET_USER_DATA: userData, WEMEET_SERVICE_URL: serviceOrigin, WEMEET_RENDERER_URL: serviceOrigin, WEMEET_OIDC_ISSUER: issuer, WEMEET_WORK_GATEWAY_ORIGIN: gatewayOrigin, WEMEET_WORK_SERVER_NAME: "localhost", WEMEET_WORK_CA_PEM_PATH: path.join(fixtures, "ca.pem"), WEMEET_E2E_WORKSPACE: workspace, WEMEET_E2E_TOKEN_FILE: tokenFile, WEMEET_E2E_FIXTURE_PORT: String(fixturePort), WEMEET_E2E_MODEL_READY: modelReady, WEMEET_E2E_DEVICE_LOG: deviceLog };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    console.error("launch signed-in electron");
    app = await _electron.launch({ executablePath: require("electron"), args: ["--require", path.join(__dirname, "work-e2e-main-hook.cjs"), project], env, timeout: 30000 });
    app.process().stderr.on("data", (chunk) => console.error("main", String(chunk).trim()));
    const page = await app.firstWindow();
    await page.addInitScript(() => localStorage.setItem("i18nextLng", "zh"));
    page.on("pageerror", (error) => console.error("pageerror", error.stack || error.message));
    page.on("console", (message) => { if (message.type() === "error") console.error("console", message.text()); });
    page.on("response", async (response) => {
      if (response.url().endsWith("/work/v1/bootstrap")) {
        console.error("bootstrap", response.status(), await response.text());
      }
    });
    await page.goto(`${serviceOrigin}/work/new`);
    await expect(page.getByLabel("任务描述", { exact: true })).toBeVisible({ timeout: 15000 });
    console.error("stage composer visible", await page.evaluate(() => window.weMeetDesktop.getStatus()), root);

    const brokerConfig = path.join(userData, "work-device", "broker.json");
    await until(() => fs.existsSync(brokerConfig), "broker config");
    const config = JSON.parse(fs.readFileSync(brokerConfig, "utf8"));
    console.error("stage broker config");
    await until(() => {
      if (!fs.existsSync(modelReady)) return false;
      const result = fs.readFileSync(modelReady, "utf8");
      if (result.startsWith("error:")) throw new Error(result.slice(6));
      return result === "ok";
    }, "fixture model configuration", 60000);
    console.error("stage model configured");

    await until(() => sessionTickets > 0, "session ticket delivery", 30000);
    await wait(1000);
    const grant = await page.evaluate(() => window.weMeetDesktop.work.grantWorkspace(["out"]));
    assert.ok(grant && grant.grantId);
    console.error("stage grant", grant.grantId);
    await page.getByLabel("任务描述", { exact: true }).fill("本机端到端验收任务");
    await page.getByRole("button", { name: "保存本机草稿", exact: true }).click();
    await expect(page.getByText("本机目录授权", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "在本机预览并提交", exact: true }).click();
    // ask_each parks every non-readonly action on an approval. The pending TTL is the policy's
// 10-minute window (0082), and the execute lease keeps renewing underneath it, so the decision
// may land well after the activation lease's first 20-30 seconds. E2E_APPROVAL_DELAY_MS holds the
// first decision for that long to prove the window and the renewal actually hold.
    const approvalDelayMs = Number(process.env.E2E_APPROVAL_DELAY_MS || 0);
    let approved = 0;
    let approving = true;
    let delayLeft = approvalDelayMs;
    let taskId;
    stopApprover = () => { approving = false; };
    const approver = (async () => {
      while (approving) {
        try {
          if (delayLeft > 0) {
            const pending = await app.evaluate(async ({}, id) => {
              const driver = globalThis.__workE2EDriver;
              if (!driver) return 0;
              return (await driver.listPendingLocalApprovals()).filter((a) => !id || a.taskId === id).length;
            }, taskId ?? null);
            if (pending > 0) {
              console.error("stage approval delay", delayLeft);
              await wait(delayLeft);
              delayLeft = 0;
            }
          }
          const decided = await app.evaluate(async ({}, id) => {
            const driver = globalThis.__workE2EDriver;
            if (!driver) return 0;
            let count = 0;
            for (const approval of await driver.listPendingLocalApprovals()) {
              if (id && approval.taskId !== id) continue;
              // A stale pending row from an earlier run can expire between list and read; that is
              // an expected shape refusal, not a reason to stop deciding the live approval.
              try {
                const detail = await driver.getLocalApproval(approval.approvalId);
                await driver.decideLocalApproval(detail, "approved", globalThis.crypto.randomUUID());
                count += 1;
              } catch (error) {
                console.error("approval skip", approval.approvalId, error.message);
              }
            }
            return count;
          }, taskId ?? null);
          approved += decided;
        } catch (error) {
          console.error("approval loop", error.message);
        }
        await wait(300);
      }
    })();
    await expect(page).toHaveURL(/\/work\/items\/[0-9a-f-]+$/, { timeout: 30000 });
    taskId = new URL(page.url()).pathname.split("/").pop();
    let truth;
    try {
      truth = await until(() => {
        const row = psql(`select t.state||'|'||r.state||'|'||coalesce(r.terminal_reason,'')||'|'||coalesce(b.state,'')||'|'||(select count(*)::text from work.device_model_result m where m.run_id=r.id and m.state='completed' and m.outcome='succeeded') from work.task t join work.run r on r.task_id=t.id and r.org_id=t.org_id left join work.device_run_binding b on b.run_id=r.id and b.org_id=r.org_id where t.id='${taskId}'`);
        if (!row.includes("|") || row.startsWith("|")) return null;
        const [taskState, runState, terminalReason, bindingState, modelResults] = row.split("|");
        // The model-only fixture chain ends in the design's no_deliverable finish; that is a
        // terminal Run with a settled model result, not an open queue entry.
        return taskState === "open" && ["completed", "failed", "canceled"].includes(runState) && bindingState !== "offered" && Number(modelResults) >= 1 ? row : null;
      }, "task/run/binding/model truth", 90000);
    } catch (error) {
      console.error("device log", fs.existsSync(deviceLog) ? fs.readFileSync(deviceLog, "utf8").slice(-8000) : "missing");
      throw error;
    }
    const [taskState, runState, terminalReason, bindingState, modelResults] = truth.split("|");
    assert.equal(taskState, "open");
    assert.ok(runState === "completed" || (runState === "failed" && terminalReason === "no_deliverable"));
    assert.notEqual(bindingState, "offered");
    assert.ok(Number(modelResults) >= 1);
    const receipt = { passed: true, taskId, taskState, runState, terminalReason, bindingState, modelResults: Number(modelResults), approvals: approved, approvalDelayMs, device: config.profile_id, profileHash: config.runtime_digest, testedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    console.log(JSON.stringify(receipt));
  } finally {
    if (stopApprover) stopApprover();
    if (fixture) fixture.kill();
    if (app) await app.close().catch(() => {});
    await new Promise((resolve) => proxy.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
