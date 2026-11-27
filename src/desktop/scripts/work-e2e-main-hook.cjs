const { app, dialog, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const originalHandle = ipcMain.handle;
ipcMain.handle = function (channel, listener) {
  if (channel !== "work:accept-local-artifact-version")
    return originalHandle.call(this, channel, listener);
  return originalHandle.call(this, channel, async (event, ...args) => {
    console.error("work e2e acceptance IPC", JSON.stringify(args));
    const result = await listener(event, ...args);
    console.error("work e2e acceptance IPC result", JSON.stringify(result));
    return result;
  });
};
const originalOn = ipcMain.on;
ipcMain.on = function (channel, listener) {
  if (channel !== "work-viewer:message")
    return originalOn.call(this, channel, listener);
  return originalOn.call(this, channel, async (event, ...args) => {
    console.error("work e2e viewer message", JSON.stringify(args));
    return listener(event, ...args);
  });
};

const workspace = process.env.WEMEET_E2E_WORKSPACE;
if (!workspace) throw new Error("WEMEET_E2E_WORKSPACE is required");

dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
dialog.showOpenDialog = async () => ({
  canceled: false,
  filePaths: [workspace],
});

app.prependOnceListener("ready", () => {
  const { safeStorage } = require("electron");
  const tokenFile = process.env.WEMEET_E2E_TOKEN_FILE;
  const userData = process.env.WEMEET_USER_DATA;
  if (!tokenFile || !userData) throw new Error("E2E token/userData missing");
  const token = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  const payload = JSON.parse(
    Buffer.from(token.access_token.split(".")[1], "base64url").toString("utf8"),
  );
  const saved = {
    serviceOrigin: process.env.WEMEET_SERVICE_URL,
    issuer: process.env.WEMEET_OIDC_ISSUER,
    clientId: "desktop",
    tokens: {
      access: token.access_token,
      refresh: token.refresh_token,
      expiresAt: Date.now() + token.expires_in * 1000,
      subject: payload.sub,
    },
  };
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(
    path.join(userData, "session-v1.enc"),
    safeStorage.encryptString(JSON.stringify(saved)),
  );

  const { WorkDeviceDriver } = require("../dist/work/driver.js");
  const { BrokerPipe } = require("../dist/work/pipe.js");
  const originalStart = WorkDeviceDriver.prototype.start;
  WorkDeviceDriver.prototype.start = function (...args) {
    globalThis.__workE2EDriver = this;
    return originalStart.apply(this, args);
  };

  // Observe the actual serialized acceptance request frame at the pipe boundary. This is an
  // observation only: the real BrokerPipe still writes it and validates the real reply.
  const pipeLog = process.env.WEMEET_E2E_ACCEPTANCE_PIPE_LOG;
  const approvalPipeLog = process.env.WEMEET_E2E_APPROVAL_PIPE_LOG;
  const originalWriteJson = BrokerPipe.prototype.writeJson;
  BrokerPipe.prototype.writeJson = function (value) {
    if (
      pipeLog &&
      (value.method === "prepareLocalAcceptance" ||
        (approvalPipeLog && value.method === "prepareLocalApprovalDecision"))
    ) {
      fs.appendFileSync(
        approvalPipeLog && value.method === "prepareLocalApprovalDecision"
          ? approvalPipeLog
          : pipeLog,
        JSON.stringify({ at: Date.now(), direction: "request", ...value }) +
          "\n",
      );
    }
    return originalWriteJson.apply(this, arguments);
  };
  const originalCall = BrokerPipe.prototype.call;
  BrokerPipe.prototype.call = async function (method, ...args) {
    const started = Date.now();
    try {
      const result = await originalCall.call(this, method, ...args);
      if (method === "prepareLocalAcceptance")
        console.error(
          "work e2e prepare acceptance reply",
          Date.now() - started,
          JSON.stringify(result),
        );
      if (method === "prepareLocalApprovalDecision")
        console.error(
          "work e2e prepare approval reply",
          Date.now() - started,
          JSON.stringify(result),
        );
      return result;
    } catch (error) {
      if (method === "prepareLocalAcceptance")
        console.error(
          "work e2e prepare acceptance error",
          Date.now() - started,
          error.code || error.message,
        );
      if (method === "prepareLocalApprovalDecision")
        console.error(
          "work e2e prepare approval error",
          Date.now() - started,
          error.code || error.message,
        );
      throw error;
    }
  };

  // The staged input facts only exist after the real Broker stageLocalInput call. Use those
  // returned facts to complete the existing fixture scenario before the model can run; no
  // content hash, body reference, grant, artifact or proof is synthesized by the harness.
  const scenario = process.env.WEMEET_E2E_FIXTURE_SCENARIO;
  const artifactId = process.env.WEMEET_E2E_ARTIFACT_ID;
  const versionId = process.env.WEMEET_E2E_VERSION_ID;
  let grantId;

  // Broker stderr carries the device's own frame refusals; the smoke test needs them to tell a
  // dropped offer from a refused one. The supervisor keeps stderr in memory only, so tee it.
  const deviceLog = process.env.WEMEET_E2E_DEVICE_LOG;
  const { BrokerSupervisor } = require("../dist/work/broker.js");
  const originalBrokerStart = BrokerSupervisor.prototype.start;
  BrokerSupervisor.prototype.start = async function (...args) {
    await originalBrokerStart.apply(this, args);
    if (this.child?.pid) globalThis.__workE2EBrokerPid = this.child.pid;
    const stream = this.child && this.child.stderr;
    if (deviceLog && stream) {
      stream.on("data", (chunk) => fs.appendFileSync(deviceLog, chunk));
    }
  };

  globalThis.__workE2EViewerPid = () => {
    const { BrowserWindow } = require("electron");
    const win = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().startsWith("wemeet-local://viewer"),
    );
    return win?.webContents.getOSProcessId();
  };

  const originalGrant = WorkDeviceDriver.prototype.grantWorkspace;
  WorkDeviceDriver.prototype.grantWorkspace = async function (...args) {
    try {
      const result = await originalGrant.apply(this, args);
      grantId = result.grantId;
      return result;
    } catch (error) {
      console.error("work e2e grant failed", error);
      throw error;
    }
  };
  const originalStage = WorkDeviceDriver.prototype.stageLocalInput;
  WorkDeviceDriver.prototype.stageLocalInput = async function (...args) {
    const result = await originalStage.apply(this, args);
    if (scenario && artifactId && versionId && grantId) {
      const writeArgs = {
        grant_id: grantId,
        artifact_id: artifactId,
        version_id: versionId,
        format: "md",
        body_ref: result.localInputRef,
        content_hash: result.contentHash,
        byte_count: String(result.byteCount),
      };
      fs.writeFileSync(
        scenario,
        JSON.stringify([
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "artifact.write",
                  arguments: JSON.stringify(writeArgs),
                },
              },
            ],
          },
          { role: "assistant", content: "Artifact written." },
        ]),
      );
    }
    return result;
  };
  const originalOpen = WorkDeviceDriver.prototype.openLocalContent;
  WorkDeviceDriver.prototype.openLocalContent = async function (...args) {
    try {
      const result = await originalOpen.apply(this, args);
      if (args[0] === "artifact_version")
        console.error(
          "work e2e open artifact",
          args[1],
          result.status,
          result.contentHash,
        );
      return result;
    } catch (error) {
      if (args[0] === "artifact_version")
        console.error(
          "work e2e open artifact failed",
          args[1],
          error.code || error.message,
        );
      throw error;
    }
  };
  const originalSubmit = WorkDeviceDriver.prototype.submitLocalTask;
  WorkDeviceDriver.prototype.submitLocalTask = async function (...args) {
    try {
      return await originalSubmit.apply(this, args);
    } catch (error) {
      console.error("work e2e submit failed", error);
      throw error;
    }
  };

  const fixturePort = process.env.WEMEET_E2E_FIXTURE_PORT;
  const readyFile = process.env.WEMEET_E2E_MODEL_READY;
  if (!fixturePort || !readyFile) return;
  const profile = JSON.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "dist",
        "work-device",
        "work-device-bundle",
        "dev-fixture-profile.json",
      ),
      "utf8",
    ),
  );
  const timer = setInterval(() => {
    const driver = globalThis.__workE2EDriver;
    if (!driver || driver.currentState !== "running") return;
    clearInterval(timer);
    void driver
      .configureLocalModel(profile.profile_id, Number(fixturePort), {
        allowedSigners: profile.listener_requirement.allowed_signers,
        allowUserPinnedHash:
          profile.listener_requirement.allow_user_pinned_hash,
        allowedServiceSids: profile.listener_requirement.allowed_service_sids,
      })
      .then(() => fs.writeFileSync(readyFile, "ok"))
      .catch((error) => fs.writeFileSync(readyFile, `error:${error.message}`));
  }, 100);
});
