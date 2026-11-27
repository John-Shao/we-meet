const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  ArtifactExportError,
  exportArtifactVersion,
} = require("../dist/work/artifact-export.js");

const versionId = "55555555-5555-4555-8555-555555555555";

test("artifact export uses the system selection and writes exact text once", async () => {
  const calls = [];
  const status = await exportArtifactVersion(
    versionId,
    { format: "text/markdown", text: "# protected" },
    async (options) => {
      calls.push(["select", options]);
      return { canceled: false, filePath: "C:\\Users\\test\\export.md" };
    },
    (filePath, text) => calls.push(["write", filePath, text]),
  );
  assert.equal(status, "exported");
  assert.deepEqual(calls, [
    [
      "select",
      {
        defaultPath: `${versionId}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      },
    ],
    ["write", "C:\\Users\\test\\export.md", "# protected"],
  ]);
});

test("artifact export cancellation performs no write", async () => {
  let writes = 0;
  const status = await exportArtifactVersion(
    versionId,
    { format: "text/plain", text: "body" },
    async () => ({ canceled: true }),
    () => {
      writes += 1;
    },
  );
  assert.equal(status, "cancelled");
  assert.equal(writes, 0);
});

test("artifact export refuses to overwrite an existing file", async () => {
  await assert.rejects(
    exportArtifactVersion(
      versionId,
      { format: "text/plain", text: "body" },
      async () => ({ canceled: false, filePath: "C:\\existing.txt" }),
      () => {
        const error = new Error("exists");
        error.code = "EEXIST";
        throw error;
      },
    ),
    (error) =>
      error instanceof ArtifactExportError && error.code === "file_exists",
  );
});

test("artifact export rejects invalid or oversized content before selection", async () => {
  let selections = 0;
  await assert.rejects(
    exportArtifactVersion(
      "../../secret",
      { format: "text/plain", text: "body" },
      async () => {
        selections += 1;
        return { canceled: false, filePath: "C:\\secret.txt" };
      },
      () => {},
    ),
    (error) =>
      error instanceof ArtifactExportError && error.code === "export_failed",
  );
  assert.equal(selections, 0);
});
