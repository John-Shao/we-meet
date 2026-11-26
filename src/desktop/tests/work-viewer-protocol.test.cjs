const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  VIEWER_CSP,
  VIEWER_SCHEME_PRIVILEGES,
  readViewerAsset,
  resolveViewerAsset,
  viewerSecurityHeaders,
} = require("../dist/work/viewer-assets.js");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "work-viewer-assets-"));
  await fs.writeFile(path.join(root, "index.html"), "<html>viewer</html>");
  await fs.writeFile(path.join(root, "viewer.js"), "console.log('viewer')");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("viewer scheme privileges are minimal and never bypass CSP", () => {
  assert.equal(VIEWER_SCHEME_PRIVILEGES.standard, true);
  assert.equal(VIEWER_SCHEME_PRIVILEGES.secure, true);
  assert.equal(VIEWER_SCHEME_PRIVILEGES.supportFetchAPI, true);
  assert.equal(VIEWER_SCHEME_PRIVILEGES.corsEnabled, true);
  assert.equal(VIEWER_SCHEME_PRIVILEGES.stream, true);
  assert.equal(VIEWER_SCHEME_PRIVILEGES.bypassCSP, false);
  assert.equal(VIEWER_SCHEME_PRIVILEGES.allowServiceWorkers, false);
  assert.equal(VIEWER_SCHEME_PRIVILEGES.codeCache, false);
  assert.match(VIEWER_CSP, /connect-src 'none'/);
  assert.match(VIEWER_CSP, /frame-src 'none'/);
  assert.match(VIEWER_CSP, /form-action 'none'/);
  assert.match(VIEWER_CSP, /base-uri 'none'/);
});

test("viewer serves only bundle assets with no-store and nosniff", async (t) => {
  const root = await fixture(t);
  const file = await resolveViewerAsset(
    root,
    "wemeet-local://viewer/index.html",
  );
  assert.equal(file, path.join(await fs.realpath(root), "index.html"));
  const asset = await readViewerAsset(root, "wemeet-local://viewer/viewer.js");
  assert.equal(asset.body.toString(), "console.log('viewer')");
  assert.equal(asset.headers["Content-Type"], "text/javascript; charset=utf-8");
  assert.equal(asset.headers["Cache-Control"], "no-store");
  assert.equal(asset.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(asset.headers["Referrer-Policy"], "no-referrer");
  assert.equal(asset.headers["Content-Security-Policy"], VIEWER_CSP);
  assert.equal(
    viewerSecurityHeaders("index.html")["Content-Type"],
    "text/html; charset=utf-8",
  );
});

test("viewer rejects traversal, encoded separators, foreign schemes and unclosed asset types", async (t) => {
  const root = await fixture(t);
  for (const url of [
    "wemeet-local://viewer/../secret.txt",
    "wemeet-local://viewer/%2e%2e/secret.txt",
    "wemeet-local://viewer/%2Fetc/passwd",
    "wemeet-local://viewer/%5Cetc/passwd",
    "wemeet-local://viewer/index.html?x=1",
    "wemeet-local://viewer/index.html#x",
    "wemeet-local://other/index.html",
    "https://example.test/index.html",
    "file:///C:/secret.txt",
    "wemeet-local://viewer/secret.txt",
  ]) {
    await assert.rejects(resolveViewerAsset(root, url), url);
  }
});

test("viewer refuses oversized assets", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "large.js");
  await fs.writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(
    readViewerAsset(root, "wemeet-local://viewer/large.js"),
    /size limit/,
  );
});
