const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const electron = require("electron");
const root = path.join(__dirname, "..");

test(
  "real Electron viewer enforces DOM network cookie and process isolation",
  { timeout: 30000 },
  () => {
    const result = spawnSync(
      electron,
      [path.join(root, "scripts/viewer-smoke.cjs")],
      { cwd: root, encoding: "utf8", timeout: 20000 },
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const line = result.stdout
      .split(/\r?\n/)
      .find((value) => value.startsWith('{"ok":true'));
    assert.ok(line, result.stdout);
    const evidence = JSON.parse(line);
    assert.equal(evidence.dom.images, 0);
    assert.equal(evidence.dom.links, 0);
    assert.equal(evidence.dom.nodeIntegration, false);
    assert.equal(evidence.fetchResult, "rejected");
    assert.equal(evidence.popup, null);
    assert.equal(evidence.viewerCookies, 0);
    assert.equal(evidence.mainPreloadExposed, false);
    assert.equal(evidence.mainWindowSentinelAbsent, true);
    assert.equal(evidence.viewerProcess.isolatedFromMain, true);
    assert.ok(evidence.viewerProcess.pid > 0);
    assert.equal(evidence.viewerProcess.type, "Tab");
    assert.equal(evidence.objectBindingAccepted, true);
    assert.deepEqual(evidence.approvalDecision, {
      accepted: true,
      decision: "rejected",
    });
    assert.equal(evidence.destinationWarningAccepted, true);
    assert.equal(evidence.readonlyRemembranceAccepted, true);
    assert.equal(evidence.staleRequestRejected, true);
    assert.deepEqual(evidence.acceptedProofRequests, [
      "request-1",
      "request-2",
      "request-3",
    ]);
    assert.equal(evidence.acceptanceGestureAccepted, true);
    assert.deepEqual(evidence.artifactEdit, {
      prepareAccepted: true,
      confirmAccepted: true,
      taskContextStayedInMain: true,
      retainedDraftResumed: true,
    });
  },
);
