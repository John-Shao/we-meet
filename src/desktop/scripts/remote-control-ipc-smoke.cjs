// Real application main/preload/IPC in a fresh profile. Synthetic login/cloud
// state and an isolated renderer fixture; no meeting, native helper or input.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { _electron } = require("../../frontend/node_modules/@playwright/test");

async function main() {
  const project = path.resolve(__dirname, "..");
  await fs.mkdir(path.join(project, "test-results"), { recursive: true });
  const output = await fs.mkdtemp(
    path.join(project, "test-results/remote-ipc-"),
  );
  const profile = path.join(output, "profile");
  const preload = path.join(output, "fixture-preload.cjs");
  await fs.writeFile(
    preload,
    `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('remoteIPCFixture', {
  invoke: (channel, args) => ipcRenderer.invoke(channel, ...args).then(
    value => ({ ok: true, value }), error => ({ ok: false, error: error.message }))
});\n`,
  );
  const servers = [];
  const listen = async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><body><h1>Remote-control IPC fixture</h1></body></html>",
      );
    });
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return `http://127.0.0.1:${server.address().port}`;
  };
  let app, page;
  const checks = [];
  try {
    const origin = await listen(),
      foreignOrigin = await listen();
    const env = {
      ...process.env,
      WEMEET_USER_DATA: profile,
      WEMEET_SERVICE_URL: origin,
      WEMEET_OIDC_ISSUER: origin,
      WEMEET_RENDERER_URL: origin,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath: require("electron"),
      args: [project, "--no-default-protocol-registration"],
      env,
      timeout: 30000,
    });
    page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => !!window.weMeetDesktop);
    const initial = await app.evaluate(
      ({ app, BrowserWindow }, fixture) => {
        if (app.getPath("userData") !== fixture.profile || app.isPackaged)
          throw new Error("Refuse a non-isolated application");
        const req = process
          .getBuiltinModule("module")
          .createRequire(fixture.project + "/package.json");
        const { DesktopAuth } = req("./dist/auth.js");
        const { RemoteControlCloud } = req("./dist/remote-control/cloud.js");
        const { RemoteInputHelper } = req(
          "./dist/remote-control/native-helper.js",
        );
        globalThis.remoteIPCState = {
          signedIn: true,
          cloudCalls: 0,
          nativeCalls: 0,
        };
        Object.defineProperty(DesktopAuth.prototype, "signedIn", {
          get: () => globalThis.remoteIPCState.signedIn,
        });
        Object.defineProperty(DesktopAuth.prototype, "subject", {
          get: () => "isolated-ipc-subject",
        });
        RemoteControlCloud.prototype.request = async () => {
          globalThis.remoteIPCState.cloudCalls++;
          if (globalThis.remoteIPCState.cloudFault)
            throw new Error("Private fixture response must not be disclosed");
          return {
            data: { enabled: false },
            serverTime: 1800000000,
            startedAt: performance.now(),
            receivedAt: performance.now(),
          };
        };
        // Any accidental native startup fails this fixture; never inject input.
        RemoteInputHelper.probe = async () => {
          globalThis.remoteIPCState.nativeCalls++;
          throw new Error("Unexpected native probe");
        };
        RemoteInputHelper.prototype.start = async () => {
          globalThis.remoteIPCState.nativeCalls++;
          throw new Error("Unexpected native startup");
        };
        const win = BrowserWindow.getAllWindows()[0];
        globalThis.remoteIPCWindow = win;
        globalThis.remoteIPCPreload =
          win.webContents.session.registerPreloadScript({
            type: "frame",
            filePath: fixture.preload,
          });
        win.webContents.session.webRequest.onBeforeRequest(
          (details, callback) => {
            const url = new URL(details.url);
            callback({
              cancel:
                ["http:", "https:"].includes(url.protocol) &&
                !fixture.origins.includes(url.origin),
            });
          },
        );
        const prefs = win.webContents.getLastWebPreferences();
        return {
          electron: process.versions.electron,
          sandbox: prefs.sandbox,
          contextIsolation: prefs.contextIsolation,
          nodeIntegration: prefs.nodeIntegration,
          nodeIntegrationInSubFrames: prefs.nodeIntegrationInSubFrames,
        };
      },
      { profile, project, preload, origins: [origin, foreignOrigin] },
    );
    assert.equal(initial.sandbox, true);
    assert.equal(initial.contextIsolation, true);
    assert.equal(initial.nodeIntegration, false);
    await page.reload();
    await page.waitForFunction(() => !!window.remoteIPCFixture);
    const reference = {
      roomId: "12345678-1234-1234-1234-123456789012",
      roomSid: "RM_fixture",
      participantSid: "PA_fixture",
    };
    const invoke = (target, name, args) =>
      target.evaluate(
        ({ name, args }) =>
          window.remoteIPCFixture.invoke(`remote-control:${name}`, args),
        { name, args },
      );
    const state = () => app.evaluate(() => globalThis.remoteIPCState);
    const refused = (result, code = "invalid_remote_request") => {
      assert.equal(result.ok, false);
      assert.ok(result.error.endsWith(code), result.error);
    };
    assert.equal(await page.evaluate(() => typeof window.require), "undefined");
    const valid = await page.evaluate(
      (reference) => window.weMeetDesktop.remoteControl.capabilities(reference),
      reference,
    );
    assert.equal(valid.enabled, false);
    assert.equal((await state()).cloudCalls, 1);
    checks.push("trusted-main-frame-reaches-runtime");
    for (const args of [[], [reference, reference]])
      refused(await invoke(page, "capabilities", args));
    for (const args of [
      [null],
      [{ ...reference, approve: true }],
      [{ ...reference, roomId: "../other" }],
    ])
      refused(await invoke(page, "capabilities", args));
    checks.push("argument-count-and-schema-rejected");
    await app.evaluate(() => {
      globalThis.remoteIPCState.cloudFault = true;
    });
    const failed = await invoke(page, "capabilities", [reference]);
    refused(failed, "remote_unavailable");
    assert.equal(failed.error.includes("Private fixture"), false);
    await app.evaluate(() => {
      globalThis.remoteIPCState.cloudFault = false;
    });
    checks.push("unexpected-cloud-error-is-redacted-over-real-ipc");
    await app.evaluate(() => {
      globalThis.remoteIPCState.signedIn = false;
    });
    for (const name of [
      "capabilities",
      "showRequest",
      "bindPublishedTrack",
      "forwardSignedMessage",
      "stop",
    ])
      refused(await invoke(page, name, [reference]));
    await app.evaluate(() => {
      globalThis.remoteIPCState.signedIn = true;
    });
    checks.push("signed-out-denied-for-all-five-handlers");
    const frameAttached = page.waitForEvent("frameattached");
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.name = "child";
      frame.src = "/child";
      document.body.append(frame);
    });
    const child = await frameAttached;
    await child.waitForURL(origin + "/child");
    const childBridge = await child.evaluate(
      () => typeof window.remoteIPCFixture,
    );
    if (childBridge === "object") {
      refused(await invoke(child, "capabilities", [reference]));
      checks.push("same-origin-child-ipc-rejected");
    } else {
      assert.equal(childBridge, "undefined");
      assert.equal(
        await child.evaluate(() => typeof window.weMeetDesktop),
        "undefined",
      );
      checks.push("same-origin-child-has-no-preload-ipc");
    }
    const foreignContents = await app.evaluate(
      async ({ BrowserWindow }, { origin, reference }) => {
        const extra = new BrowserWindow({
          show: false,
          webPreferences: {
            session: globalThis.remoteIPCWindow.webContents.session,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        try {
          await extra.loadURL(origin);
          return await extra.webContents.executeJavaScript(
            `window.remoteIPCFixture.invoke('remote-control:capabilities', [${JSON.stringify(reference)}])`,
          );
        } finally {
          extra.destroy();
        }
      },
      { origin, reference },
    );
    refused(foreignContents);
    checks.push("other-webcontents-at-trusted-origin-rejected");
    await app.evaluate(async (_electron, url) => {
      await globalThis.remoteIPCWindow.loadURL(url);
    }, foreignOrigin);
    await page.waitForFunction(() => !!window.remoteIPCFixture);
    refused(await invoke(page, "capabilities", [reference]));
    checks.push("main-frame-at-foreign-origin-rejected");
    const end = await state();
    assert.equal(end.cloudCalls, 2);
    assert.equal(end.nativeCalls, 0);
    await fs.writeFile(
      path.join(output, "report.json"),
      JSON.stringify(
        {
          passed: true,
          testedAt: new Date().toISOString(),
          initial,
          checks,
          cloudCalls: end.cloudCalls,
          nativeCalls: end.nativeCalls,
          scope:
            "Actual development main/preload/IPC with synthetic login/cloud and a loopback renderer; no real login, meeting, native input, packaged-app or installer acceptance",
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`Remote-control IPC smoke passed: ${output}`);
  } catch (error) {
    await fs.writeFile(
      path.join(output, "report.json"),
      JSON.stringify(
        {
          passed: false,
          testedAt: new Date().toISOString(),
          checks,
          error: error.message,
        },
        null,
        2,
      ) + "\n",
    );
    console.error(`Remote-control IPC smoke failed: ${output}`, error);
    process.exitCode = 1;
  } finally {
    if (app) {
      await app
        .evaluate(({ app }) => {
          if (globalThis.remoteIPCWindow && globalThis.remoteIPCPreload)
            globalThis.remoteIPCWindow.webContents.session.unregisterPreloadScript(
              globalThis.remoteIPCPreload,
            );
          app.exit(0);
        })
        .catch(() => {});
      await app.close().catch(() => {});
    }
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
          }),
      ),
    );
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
