(async () => {
  const fs = require("node:fs");
  const net = require("node:net");
  const { execFileSync } = require("node:child_process");
  const cfg = JSON.parse(process.env.H06_CONFIG);
  const results = { mode: cfg.mode };
  const progress = (label) => {
    try {
      fs.appendFileSync(`${cfg.allowed}/progress.log`, `${label}\n`);
    } catch {}
  };
  progress("start");
  const watchdog = setTimeout(() => {
    try {
      fs.writeFileSync(cfg.out, JSON.stringify({ ...results, watchdog: true }, null, 2));
    } catch {}
    process.exit(3);
  }, 30000);

  function attemptSync(fn) {
    try {
      return { ok: true, value: fn() };
    } catch (error) {
      return { ok: false, error: error.code ?? error.message };
    }
  }

  async function attempt(fn) {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      return { ok: false, error: error.code ?? error.message };
    }
  }

  function tcpConnect(host, port) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
      }, 3000);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.end();
        resolve(`${host}:${port} connected`);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  progress("read-tests");
  results.read_allowed = attemptSync(() => fs.readFileSync(`${cfg.allowed}/allowed.txt`, "utf8").trim());
  results.read_secret = attemptSync(() => fs.readFileSync(`${cfg.secret}/secret.txt`, "utf8").trim());
  results.read_secret_via_junction = attemptSync(() => fs.readFileSync(`${cfg.junction}/secret.txt`, "utf8").trim());
  results.write_allowed = attemptSync(() => {
    fs.writeFileSync(`${cfg.allowed}/written-by-child-${cfg.mode}.txt`, `written by ${cfg.mode}`);
    return "written";
  });
  results.write_secret = attemptSync(() => {
    fs.writeFileSync(`${cfg.secret}/written-by-child.txt`, "should not happen");
    return "written";
  });
  results.list_secret = attemptSync(() => fs.readdirSync(cfg.secret).join(","));
  results.read_user_secret = attemptSync(() => fs.readFileSync(cfg.userSecret, "utf8").trim());
  progress("net-local");
  results.net_local = await attempt(() => tcpConnect("127.0.0.1", Number(cfg.localPort)));
  progress("net-external");
  results.net_external = await attempt(() => tcpConnect("1.1.1.1", 443));
  fs.writeFileSync(cfg.out, JSON.stringify({ ...results, partial: true }, null, 2));
  progress("spawn-test");
  results.spawn_cmd_read_secret = attemptSync(() =>
    execFileSync("cmd.exe", ["/c", "type", `${cfg.secret}\\secret.txt`], {
      encoding: "utf8",
      timeout: 5000,
      killSignal: "SIGKILL",
    }).trim(),
  );
  progress("done");
  clearTimeout(watchdog);
  fs.writeFileSync(cfg.out, JSON.stringify(results, null, 2));
})().catch((error) => {
  try {
    require("node:fs").writeFileSync(process.env.H06_ERROR_OUT, String((error && error.stack) || error));
  } catch {}
  process.exit(1);
});
