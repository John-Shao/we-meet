const fs = require("node:fs/promises");
const path = require("node:path");

const source = path.join(__dirname, "../viewer");
const destination = path.join(__dirname, "../dist/viewer");
const expected = path.resolve(path.dirname(destination), "viewer");
if (path.resolve(destination) !== expected)
  throw new Error("Refusing to copy outside desktop/dist/viewer");

async function main() {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(source, destination, { recursive: true });
  console.log("copied viewer → dist/viewer");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
