const { app, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const workspace = process.env.WEMEET_E2E_WORKSPACE;
if (!workspace) throw new Error("WEMEET_E2E_WORKSPACE is required");

dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });

app.prependOnceListener("ready", () => {
  const { safeStorage } = require("electron");
  const tokenFile = process.env.WEMEET_E2E_TOKEN_FILE;
  const userData = process.env.WEMEET_USER_DATA;
  if (!tokenFile || !userData) throw new Error("E2E token/userData missing");
  const token = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  const payload = JSON.parse(Buffer.from(token.access_token.split(".")[1], "base64url").toString("utf8"));
  const saved = {
    serviceOrigin: process.env.WEMEET_SERVICE_URL,
    issuer: process.env.WEMEET_OIDC_ISSUER,
    clientId: "desktop",
    tokens: { access: token.access_token, refresh: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000, subject: payload.sub },
  };
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "session-v1.enc"), safeStorage.encryptString(JSON.stringify(saved)));

  const { WorkDeviceDriver } = require("../dist/work/driver.js");
  const originalStart = WorkDeviceDriver.prototype.start;
  WorkDeviceDriver.prototype.start = function (...args) {
    globalThis.__workE2EDriver = this;
    return originalStart.apply(this, args);
  };

  // Broker stderr carries the device's own frame refusals; the smoke test needs them to tell a
  // dropped offer from a refused one. The supervisor keeps stderr in memory only, so tee it.
  const deviceLog = process.env.WEMEET_E2E_DEVICE_LOG;
  const { BrokerSupervisor } = require("../dist/work/broker.js");
  const originalBrokerStart = BrokerSupervisor.prototype.start;
  BrokerSupervisor.prototype.start = async function (...args) {
    await originalBrokerStart.apply(this, args);
    const stream = this.child && this.child.stderr;
    if (deviceLog && stream) {
      stream.on("data", (chunk) => fs.appendFileSync(deviceLog, chunk));
    }
  };

  const originalGrant = WorkDeviceDriver.prototype.grantWorkspace;
  WorkDeviceDriver.prototype.grantWorkspace = async function (...args) {
    try { return await originalGrant.apply(this, args); }
    catch (error) { console.error("work e2e grant failed", error); throw error; }
  };
  const originalSubmit = WorkDeviceDriver.prototype.submitLocalTask;
  WorkDeviceDriver.prototype.submitLocalTask = async function (...args) {
    try { return await originalSubmit.apply(this, args); }
    catch (error) { console.error("work e2e submit failed", error); throw error; }
  };

  const fixturePort = process.env.WEMEET_E2E_FIXTURE_PORT;
  const readyFile = process.env.WEMEET_E2E_MODEL_READY;
  if (!fixturePort || !readyFile) return;
  const profile = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "dist", "work-device", "work-device-bundle", "dev-fixture-profile.json"), "utf8"));
  const timer = setInterval(() => {
    const driver = globalThis.__workE2EDriver;
    if (!driver || driver.currentState !== "running") return;
    clearInterval(timer);
    void driver.configureLocalModel(profile.profile_id, Number(fixturePort), {
      allowedSigners: profile.listener_requirement.allowed_signers,
      allowUserPinnedHash: profile.listener_requirement.allow_user_pinned_hash,
      allowedServiceSids: profile.listener_requirement.allowed_service_sids,
    }).then(() => fs.writeFileSync(readyFile, "ok"))
      .catch((error) => fs.writeFileSync(readyFile, `error:${error.message}`));
  }, 100);
});
