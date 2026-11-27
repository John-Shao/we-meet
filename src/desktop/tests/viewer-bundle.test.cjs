const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const viewer = require("../viewer/viewer-render.js");
const clipboard = require("../dist/work/clipboard-provenance.js");

test("trusted artifact clipboard tokens bind text, expire and fail closed", () => {
  const now = 1_000_000;
  const versionId = "11111111-1111-4111-8111-111111111111";
  const text = '<script>alert("x")</script>';
  const html = clipboard.createClipboardHtml(text, versionId, now);
  assert.equal(html.includes(text), false);
  assert.deepEqual(clipboard.readClipboardProvenance(html, text, now + 1), {
    derived: true,
    sources: [versionId],
  });
  assert.deepEqual(clipboard.readClipboardProvenance(html, "transplanted", now), {
    derived: true,
    sources: [],
  });
  assert.deepEqual(
    clipboard.readClipboardProvenance(html, text, now + 5 * 60 * 1000),
    { derived: true, sources: [] },
  );
  assert.deepEqual(
    clipboard.readClipboardProvenance("<p>external</p>", "external", now),
    { derived: true, sources: [] },
  );
  assert.deepEqual(
    clipboard.readClipboardProvenance(
      html.replace("wemeet-", "wemeetX-"),
      text,
      now,
    ),
    { derived: true, sources: [] },
  );
  assert.deepEqual(
    clipboard.readClipboardProvenance(`${html}${html}`, text, now),
    { derived: true, sources: [] },
  );
  const tampered = html.replace(
    /wemeet-clipboard-source-v1:([A-Za-z0-9_-]+)/,
    (_match, token) =>
      `wemeet-clipboard-source-v1:${token[0] === "A" ? "B" : "A"}${token.slice(1)}`,
  );
  assert.deepEqual(clipboard.readClipboardProvenance(tampered, text, now), {
    derived: true,
    sources: [],
  });
  assert.deepEqual(
    clipboard.readClipboardProvenance(
      clipboard.createClipboardHtml("external", null, now),
      "external",
      now,
    ),
    { derived: true, sources: [] },
  );
});

test("viewer renders untrusted content only through textContent", () => {
  const element = { textContent: "" };
  Object.defineProperty(element, "innerHTML", {
    set() {
      throw new Error("innerHTML must never be used");
    },
  });
  const payload =
    '<img src="https://evil.test/x" onerror="alert(1)"><script>alert(1)</script>';
  viewer.render(element, payload);
  assert.equal(element.textContent, payload);
});

test("viewer accepts only closed text formats and bounded payloads", () => {
  assert.deepEqual(
    viewer.parseMessage({
      type: "render",
      format: "text/plain",
      text: "hello",
    }),
    {
      format: "text/plain",
      text: "hello",
    },
  );
  assert.deepEqual(
    viewer.parseMessage({
      type: "render",
      format: "text/markdown",
      text: "[x](https://evil.test)",
    }),
    {
      format: "text/markdown",
      text: "[x](https://evil.test)",
    },
  );
  for (const value of [
    null,
    { type: "render", format: "text/html", text: "<script>x</script>" },
    { type: "render", format: "text/plain", text: 1 },
    { type: "navigate", format: "text/plain", text: "x" },
    {
      type: "render",
      format: "text/plain",
      text: "x".repeat(viewer.MAX_TEXT_BYTES + 1),
    },
  ])
    assert.equal(viewer.parseMessage(value), null);
});

test("viewer accepts an export binding only for a closed version id", () => {
  const versionId = "55555555-5555-4555-8555-555555555555";
  assert.deepEqual(
    viewer.parseMessage({
      type: "render",
      format: "text/markdown",
      text: "body",
      export_version_id: versionId,
    }),
    { format: "text/markdown", text: "body", export_version_id: versionId },
  );
  assert.equal(
    viewer.parseMessage({
      type: "render",
      format: "text/plain",
      text: "body",
      export_version_id: "../../secret",
    }),
    null,
  );
});

test("viewer resumes only closed retained draft metadata", () => {
  const message = {
    type: "render",
    format: "text/markdown",
    text: "draft body",
    edit: {
      format: "text/markdown",
      artifact_id: "11111111-1111-4111-8111-111111111111",
      task_id: "22222222-2222-4222-8222-222222222222",
      base_version_no: 4,
      base_hash: `sha256:${"a".repeat(64)}`,
    },
    draft: {
      request_id: "33333333-3333-4333-8333-333333333333",
      content_hash: `sha256:${"b".repeat(64)}`,
      byte_count: "9",
      base_byte_count: "4",
      publish_state: "pending_publish",
    },
  };
  const input = {
    ...message,
    edit: {
      artifact_id: message.edit.artifact_id,
      task_id: message.edit.task_id,
      base_version_no: message.edit.base_version_no,
      base_hash: message.edit.base_hash,
    },
  };
  const expected = { ...message };
  delete expected.type;
  assert.deepEqual(viewer.parseMessage(input), expected);
  assert.equal(viewer.parseMessage({ ...message, draft: { ...message.draft, body: "secret" } }), null);
  assert.equal(viewer.parseMessage({ ...message, draft: { ...message.draft, publish_state: "published" } }), null);
});

test("viewer bundle has no active-content or network escape hatch", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../viewer/viewer-render.js"),
    "utf8",
  );
  const bootstrap = fs.readFileSync(
    path.join(__dirname, "../viewer/viewer.js"),
    "utf8",
  );
  const html = fs.readFileSync(
    path.join(__dirname, "../viewer/index.html"),
    "utf8",
  );
  for (const token of [
    "innerHTML",
    "outerHTML",
    "document.write",
    "eval(",
    "fetch(",
    "WebSocket",
    "XMLHttpRequest",
    "DOMParser",
  ]) {
    assert.equal(source.includes(token), false, token);
    assert.equal(bootstrap.includes(token), false, token);
  }
  assert.equal(/<script[^>]+src=["']https?:/i.test(html), false);
  assert.equal(/<(img|iframe|form|object|embed)\b/i.test(html), false);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /id="approve"/);
  assert.match(html, /id="remember-readonly"/);
  assert.match(bootstrap, /decideLocalApproval/);
});

test("desktop build ships the viewer bundle beside the protocol handler", () => {
  for (const file of [
    "index.html",
    "viewer.css",
    "viewer-render.js",
    "viewer.js",
  ]) {
    assert.equal(
      fs.existsSync(path.join(__dirname, "../dist/viewer", file)),
      true,
      file,
    );
  }
});
