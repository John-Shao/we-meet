import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  net,
  safeStorage,
  session,
  shell,
} from "electron";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ManagedRuntime } from "./managed-runtime";
import { LocalWorkClient, readKeyFile, LocalConfiguration } from "./local-work";
import { WorkCoordinator } from "./work-coordinator";
import { DesktopAuth } from "./auth";
import {
  CALLBACK,
  DEFAULT_CONFIG,
  externalUrl,
  sameOrigin,
  validateConfig,
} from "./policy";
import { installRenderer } from "./renderer";
import { forwardRequest } from "./forward";
import { loadInitialPage } from "./startup";

if (!app.isPackaged && process.env.WEMEET_USER_DATA)
  app.setPath("userData", process.env.WEMEET_USER_DATA);
const configPath = path.join(__dirname, "runtime-config.json");
const config = validateConfig(
  {
    ...(existsSync(configPath)
      ? JSON.parse(readFileSync(configPath, "utf8"))
      : DEFAULT_CONFIG),
    ...(!app.isPackaged && process.env.WEMEET_SERVICE_URL
      ? { serviceOrigin: process.env.WEMEET_SERVICE_URL }
      : {}),
    ...(!app.isPackaged && process.env.WEMEET_OIDC_ISSUER
      ? { issuer: process.env.WEMEET_OIDC_ISSUER }
      : {}),
  },
  !app.isPackaged,
);
const devRenderer = !app.isPackaged
  ? process.env.WEMEET_RENDERER_URL
  : undefined;
if (devRenderer)
  validateConfig({ ...config, serviceOrigin: devRenderer }, true);
const rendererOrigin = devRenderer || config.serviceOrigin;
let window: BrowserWindow | undefined;
let auth: DesktopAuth;
let quitting = false;
let closing = false;
let loginStarting = false;
let loginTimer: NodeJS.Timeout | undefined;
let localWork: LocalWorkClient | undefined;
let localOwner = "";
let localCoordinator: WorkCoordinator | undefined;
const localGrants = new Map<string, string>();
const remoteWorkspaces = new Set<string>();
let localConfiguring = false;
let managedRuntime: ManagedRuntime | undefined;
let managedExecutable = "";
let managedError = "";

async function closeLocalWork() {
  const client = localWork;
  const coordinator = localCoordinator;
  localCoordinator = undefined;
  localWork = undefined;
  localOwner = "";
  localGrants.clear();
  remoteWorkspaces.clear();
  await coordinator?.close();
  await client?.close();
}

async function localCloudRequest(endpoint: string, body?: Record<string, any>) {
  if (!/^(?:capabilities\/|local\/(?:devices\/|tasks\/|workspaces\/|inbox\/|runs\/[0-9a-f-]{36}\/(?:claim|report|sync)\/)|runs\/[0-9a-f-]{36}\/cancel\/)$/.test(endpoint)) throw new Error("invalid_local_request");
  const epoch = auth.epoch;
  const token = await auth.access();
  if (!token || epoch !== auth.epoch || quitting) throw new Error("local_account_changed");
  try {
    const response = await fetch(config.serviceOrigin + "/api/v1.0/work/" + endpoint, {
      method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(8000),
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    const reader = response.body?.getReader();
    if (reader) for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.length;
      if (bytes > 2_100_000) { await reader.cancel(); throw new Error("local_coordination_mismatch"); }
      chunks.push(next.value);
    }
    if (epoch !== auth.epoch || !auth.signedIn || quitting) throw new Error("local_account_changed");
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!response.ok) throw new Error(typeof value.code === "string" && /^[a-z_]{1,60}$/.test(value.code) ? value.code : `local_http_${response.status}`);
    return value;
  } catch (error) {
    if (error instanceof Error && /^[a-z_0-9]{1,60}$/.test(error.message)) throw error;
    throw new Error("local_cloud_pending");
  }
}

function coordinator() {
  const client = localClient();
  if (!localCoordinator) localCoordinator = new WorkCoordinator(client, localPaths().root, {
    request: localCloudRequest,
    encrypt: value => safeStorage.encryptString(value),
    decrypt: value => safeStorage.decryptString(value),
    remoteWorkspaces: () => [...remoteWorkspaces].filter(id => localGrants.has(id)),
  });
  return localCoordinator;
}

function localPaths() {
  if (!auth?.signedIn || !auth.subject) throw new Error("local_login_required");
  const owner = createHash("sha256").update(config.issuer + "\n" + auth.subject).digest("hex");
  const root = path.join(app.getPath("userData"), "local-work-v1", owner);
  return { owner, root, configuration: path.join(root, "configuration.enc") };
}

function localClient() {
  const paths = localPaths();
  if (localWork && localOwner === paths.owner) return localWork;
  if (localWork) throw new Error("local_account_changed");
  if (!existsSync(paths.configuration)) throw new Error("local_setup_required");
  const configuration = JSON.parse(safeStorage.decryptString(readFileSync(paths.configuration))) as LocalConfiguration;
  if (configuration.source === "bundled") {
    if (!managedExecutable) throw new Error(managedError || "local_runtime_unavailable");
    configuration.executable = managedExecutable;
  }
  localWork = new LocalWorkClient(configuration, paths.root);
  localOwner = paths.owner;
  return localWork;
}
const status = {
  version: app.getVersion(),
  serviceOrigin: config.serviceOrigin,
  connection: "connecting",
  auth: "signed-out",
  message: "",
};
const publish = () => {
  if (window && !window.isDestroyed())
    window.webContents.send("desktop:status", { ...status });
};
function focus() {
  if (window?.isMinimized()) window.restore();
  window?.show();
  window?.focus();
}
function report(message: string) {
  status.message = message;
  publish();
}

async function beginLogin() {
  if (loginStarting || auth.loginPending) {
    focus();
    return;
  }
  loginStarting = true;
  status.auth = "signing-in";
  report("请在系统浏览器完成登录，完成后返回 We-Meet。");
  try {
    await shell.openExternal(await auth.begin());
    clearTimeout(loginTimer);
    loginTimer = setTimeout(() => {
      status.auth = auth.signedIn ? "signed-in" : "signed-out";
      report("登录已过期，请重新登录。");
    }, 300000);
  } catch {
    auth.cancelLogin();
    status.auth = auth.signedIn ? "signed-in" : "signed-out";
    report("无法启动登录，请检查网络及桌面登录服务配置后重试。");
  } finally {
    loginStarting = false;
  }
}

async function receiveCallback(raw?: string) {
  if (!raw || !auth) return;
  focus();
  if (!auth.loginPending && auth.signedIn) return; // Duplicate callback cannot disturb a completed login.
  try {
    await auth.complete(raw);
    clearTimeout(loginTimer);
    await closeLocalWork();
    await resetWebSession();
    status.auth = "signed-in";
    status.message = "";
    await window?.loadURL(rendererOrigin);
  } catch {
    report("登录回跳无效或已过期，请重新发起登录。");
  }
  publish();
}

async function resetWebSession() {
  const ses = window!.webContents.session;
  await window!.loadURL("about:blank");
  await ses.clearStorageData();
  await ses.clearCache();
  await ses.closeAllConnections();
}

async function logout(message = "") {
  clearTimeout(loginTimer);
  auth.clear();
  await closeLocalWork();
  status.auth = "signed-out";
  status.message = message;
  await resetWebSession();
  await window?.loadURL(rendererOrigin);
  publish();
}

async function confirmExit() {
  if (closing || !window) return;
  closing = true;
  const result = await dialog.showMessageBox(window, {
    type: "question",
    title: "退出 We-Meet",
    buttons: ["继续使用", "退出"],
    defaultId: 0,
    cancelId: 0,
    message: "确定退出 We-Meet？",
    detail:
      "退出将取消本机 Agent 任务，并断开本机会议、屏幕共享和音视频采集。正在录音时，请先回到页面停止并保存；在服务端执行的任务继续运行。",
  });
  closing = false;
  if (result.response === 1) {
    quitting = true;
    await closeLocalWork();
    app.quit();
  }
}

async function createWindow() {
  const ses = session.fromPartition("persist:we-meet-desktop-v1");
  const tokenPath = path.join(app.getPath("userData"), "session-v1.enc");
  const remove = (file: string) => {
    try {
      unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  auth = new DesktopAuth(config, {
    read: () =>
      existsSync(tokenPath)
        ? safeStorage.decryptString(readFileSync(tokenPath))
        : undefined,
    write: (value) => {
      if (
        !safeStorage.isEncryptionAvailable() ||
        (process.platform === "linux" &&
          safeStorage.getSelectedStorageBackend() === "basic_text")
      )
        throw new Error("安全凭据存储不可用。");
      mkdirSync(path.dirname(tokenPath), { recursive: true });
      writeFileSync(tokenPath + ".tmp", safeStorage.encryptString(value));
      renameSync(tokenPath + ".tmp", tokenPath);
    },
    clear: () => {
      remove(tokenPath);
      remove(tokenPath + ".tmp");
    },
  }, fetch, () => {
    void logout("登录已失效，请重新登录。").catch(() => {
      report("登录已失效，请重启客户端后重新登录。");
    });
  });
  status.auth = auth.signedIn ? "signed-in" : "signed-out";
  if (!devRenderer)
    installRenderer(
      ses,
      path.join(__dirname, "renderer"),
      config.serviceOrigin,
      auth,
      (online) => {
        status.connection = online ? "online" : "offline";
        status.auth = auth.signedIn
          ? "signed-in"
          : auth.loginPending
            ? "signing-in"
            : "signed-out";
        publish();
      },
      fetch,
      request => forwardRequest(request, options => net.request({ ...options, session: ses })),
    );
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: "We-Meet",
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  const win = window;
  const trusted = (contents: Electron.WebContents | null, origin: string) =>
    !!contents &&
    contents.id === win.webContents.id &&
    sameOrigin(origin, rendererOrigin);
  const grants = new Set<string>();
  ses.setPermissionCheckHandler(
    (contents, permission, origin) =>
      trusted(contents, origin) &&
      ["media", "display-capture"].includes(permission),
  );
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (
      !trusted(contents, details.requestingUrl) ||
      details.isMainFrame === false ||
      !["media", "display-capture"].includes(permission)
    ) {
      callback(false);
      return;
    }
    if (permission === "display-capture") {
      callback(true);
      return;
    }
    const types = "mediaTypes" in details ? details.mediaTypes || [] : [];
    if (
      !types.length ||
      types.some((type) => !["audio", "video"].includes(type))
    ) {
      callback(false);
      return;
    }
    const key = types.slice().sort().join(",");
    if (grants.has(key)) {
      callback(true);
      return;
    }
    void dialog
      .showMessageBox(win, {
        type: "question",
        title: "媒体设备权限",
        message: `允许 We-Meet 使用${types.includes("audio") ? "麦克风" : ""}${types.length > 1 ? "和" : ""}${types.includes("video") ? "摄像头" : ""}？`,
        buttons: ["拒绝", "允许本次运行"],
        defaultId: 0,
        cancelId: 0,
      })
      .then((result) => {
        if (result.response === 1) grants.add(key);
        callback(result.response === 1);
      })
      .catch(() => callback(false));
  });
  ses.setDisplayMediaRequestHandler((request, callback) => {
    if (
      request.frame !== win.webContents.mainFrame ||
      !sameOrigin(request.securityOrigin, rendererOrigin) ||
      !request.userGesture
    ) {
      callback({});
      return;
    }
    void (async () => {
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 0, height: 0 },
      });
      const available = sources.slice(0, 20);
      const result = await dialog.showMessageBox(win, {
        title: "选择要共享的屏幕或窗口",
        message: "仅共享你选择的内容。停止共享请使用会议页面中的按钮。",
        buttons: ["取消", ...available.map((source) => source.name)],
        cancelId: 0,
        defaultId: 0,
      });
      const source = available[result.response - 1];
      if (!source || win.isDestroyed()) {
        callback({});
        return;
      }
      callback({ video: source });
    })().catch(() => callback({}));
  });
  const external = (url: string) => {
    if (externalUrl(url))
      void shell.openExternal(url).catch(() => report("无法打开链接。"));
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: "deny" };
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.webContents.on("will-navigate", (event, url) => {
    if (!sameOrigin(url, rendererOrigin)) {
      event.preventDefault();
      external(url);
      return;
    }
    const pathname = new URL(url).pathname;
    if (/^\/api\/v1\.0\/authenticate\/?$/.test(pathname)) {
      event.preventDefault();
      void beginLogin();
    } else if (/^\/api\/v1\.0\/logout\/?$/.test(pathname)) {
      event.preventDefault();
      void logout().catch(() => report("退出处理失败，请关闭客户端后重试。"));
    }
  });
  win.webContents.on("will-redirect", (event, url, _inPlace, isMainFrame) => {
    if (isMainFrame && !sameOrigin(url, rendererOrigin)) event.preventDefault();
  });
  win.webContents.on("render-process-gone", () => {
    void dialog
      .showMessageBox(win, {
        type: "error",
        message: "页面进程已停止，本机音视频采集已中断。",
        buttons: ["重新打开", "退出"],
      })
      .then((result) => {
        if (!result.response) void win.loadURL(rendererOrigin);
        else {
          quitting = true;
          app.quit();
        }
      });
  });
  win.webContents.on(
    "did-fail-load",
    (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3)
        report("页面加载失败，请从“窗口 → 重新加载”重试。");
    },
  );
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      void confirmExit();
    }
  });
  const senderAllowed = (event: Electron.IpcMainInvokeEvent) =>
    event.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame &&
    sameOrigin(event.senderFrame.url, rendererOrigin);
  const localHandlers: Record<string, (...args: any[]) => Promise<unknown>> = {
    status: async () => {
      const paths = localPaths();
      const runtime = managedRuntime ? await managedRuntime.status() : undefined;
      if (!existsSync(paths.configuration)) return { configured: false, contract: "work-local/v1", bundled_runtime: !!managedExecutable, runtime };
      const capabilities = await localClient().request("capabilities");
      const cloud = await localCloudRequest("capabilities/").catch(() => null);
      coordinator(); // Resume reporting existing jobs only; never submit on restart.
      return { configured: true, ...capabilities, bundled_runtime: !!managedExecutable, runtime, coordination_enabled: cloud?.local_agent_enabled === true, remote_enabled: cloud?.remote_agent_enabled === true, coordination_contract: cloud?.coordination_contract };
    },
    configure: async (model: string) => {
      if (typeof model !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(model)) throw new Error("invalid_model");
      const paths = localPaths();
      const epoch = auth.epoch;
      if (managedRuntime && !managedExecutable) throw new Error(managedError || "runtime_integrity_failed");
      const binary = managedExecutable ? { canceled: false, filePaths: [managedExecutable] } : await dialog.showOpenDialog(win, { title: "选择独立安装的 work-agent-local.exe", properties: ["openFile"], filters: [{ name: "Local Agent", extensions: ["exe"] }] });
      if (binary.canceled) return null;
      const secret = await dialog.showOpenDialog(win, { title: "选择含 DEEPSEEK_API_KEY 的本地 .env 文件", properties: ["openFile"] });
      if (secret.canceled) return null;
      if (epoch !== auth.epoch || paths.owner !== localPaths().owner) throw new Error("local_account_changed");
      if (!safeStorage.isEncryptionAvailable() || (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")) throw new Error("local_secure_storage_unavailable");
      const configuration: LocalConfiguration = { executable: binary.filePaths[0], apiKey: readKeyFile(secret.filePaths[0]), model, ...(managedExecutable ? { source: "bundled" as const } : {}) };
      await closeLocalWork();
      const client = new LocalWorkClient(configuration, paths.root);
      try {
        const capabilities = await client.request("capabilities");
        if (!capabilities.ready || capabilities.engine !== "dsh" || !capabilities.features?.includes("command_approval")) throw new Error("local_adapter_upgrade_required");
        if (epoch !== auth.epoch || paths.owner !== localPaths().owner) throw new Error("local_account_changed");
        mkdirSync(paths.root, { recursive: true });
        writeFileSync(paths.configuration + ".tmp", safeStorage.encryptString(JSON.stringify(configuration)));
        renameSync(paths.configuration + ".tmp", paths.configuration);
        localWork = client; localOwner = paths.owner;
        return capabilities;
      } catch (error) { await client.close(); throw error; }
    },
    "pick-workspace": async () => {
      const epoch = auth.epoch;
      const client = localClient();
      const selection = await dialog.showOpenDialog(win, { title: "选择本地工作空间", properties: ["openDirectory"] });
      if (selection.canceled) return null;
      const consent = await dialog.showMessageBox(win, { type: "question", title: "授权本地 dsh", message: selection.filePaths[0], detail: "dsh 可以读取文件、生成或修改文件并执行本机命令。工作空间是工作起点，不是操作系统沙箱。提供给模型的内容会通过 API 发送至 DeepSeek。授权仅在本次登录会话有效。", buttons: ["取消", "授权此工作空间"], defaultId: 0, cancelId: 0 });
      if (!consent.response) return null;
      if (epoch !== auth.epoch || client !== localWork) throw new Error("local_account_changed");
      const directory = realpathSync(selection.filePaths[0]);
      const grant = await client.request("grant", { path: directory });
      if (epoch !== auth.epoch || client !== localWork) throw new Error("local_account_changed");
      if (!validId(grant.id) || grant.path !== directory) throw new Error("local_protocol_mismatch");
      localGrants.set(grant.id, directory);
      return grant;
    },
    list: async () => coordinator().list(),
    "remote-inbox": async () => coordinator().inbox(),
    "remote-workspace": async (id: string, enabled: boolean) => {
      if (!validId(id) || typeof enabled !== "boolean" || !localGrants.has(id)) throw new Error("workspace_permission_required");
      const epoch = auth.epoch;
      const client = localClient();
      const value = await coordinator().registerWorkspace(id, path.basename(localGrants.get(id)!), enabled);
      if (epoch !== auth.epoch || client !== localWork || !localGrants.has(id)) throw new Error("local_account_changed");
      if (enabled) remoteWorkspaces.add(id); else remoteWorkspaces.delete(id);
      return value.workspace;
    },
    "take-remote": async (id: string, workspaceId: string) => {
      if (!validId(id) || !validId(workspaceId) || !localGrants.has(workspaceId) || !remoteWorkspaces.has(workspaceId)) throw new Error("workspace_permission_required");
      const epoch = auth.epoch;
      const client = localClient();
      const c = coordinator();
      const pending = (await c.inbox()).find((r: any) => r.run_id === id && r.workspace_id === workspaceId);
      if (!pending) throw new Error("local_assignment_closed");
      const consent = await dialog.showMessageBox(win, { title: "领取远程工作", message: pending.goal, detail: `工作空间：${localGrants.get(workspaceId)}\n此请求将在本机执行。具体命令与文件操作仍需逐次审批。`, buttons: ["暂不领取", "领取此任务"], defaultId: 0, cancelId: 0 });
      if (consent.response !== 1) return null;
      if (epoch !== auth.epoch || client !== localWork || !localGrants.has(workspaceId) || !remoteWorkspaces.has(workspaceId)) throw new Error("local_account_changed");
      return c.takeRemote(id, workspaceId);
    },
    submit: async (body: unknown) => {
      if (!(await localClient().request("capabilities")).features?.includes("command_approval")) throw new Error("local_adapter_upgrade_required");
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid_local_request");
      const value = body as Record<string, unknown>;
      if (Object.keys(value).some(key => !["goal", "run_id", "workspace_id", "track_cloud", "sources"].includes(key)) || typeof value.goal !== "string" || !value.goal.trim() || value.goal.length > 8000 || !validId(value.run_id) || !validId(value.workspace_id) || (value.track_cloud !== undefined && typeof value.track_cloud !== "boolean") || (value.sources !== undefined && (!Array.isArray(value.sources) || value.sources.length > 10))) throw new Error("invalid_local_request");
      const workspace = localGrants.get(value.workspace_id as string);
      if (!workspace) throw new Error("workspace_permission_required");
      if (value.track_cloud) return coordinator().submit(value, path.basename(workspace));
      if (coordinator().has(value.run_id as string)) throw new Error("local_tracking_pending");
      return localClient().request("submit", { run_id: value.run_id, workspace_id: value.workspace_id, goal: value.goal });
    },
    get: async (runId: string) => { if (!validId(runId)) throw new Error("invalid_local_request"); return coordinator().get(runId); },
    cancel: async (runId: string) => { if (!validId(runId)) throw new Error("invalid_local_request"); return coordinator().cancel(runId); },
    resume: async (runId: string, workspaceId: string) => {
      if (!(await localClient().request("capabilities")).features?.includes("command_approval")) throw new Error("local_adapter_upgrade_required");
      if (!validId(runId) || !validId(workspaceId) || !localGrants.has(workspaceId)) throw new Error("workspace_permission_required");
      return coordinator().resume(runId, workspaceId, path.basename(localGrants.get(workspaceId)!));
    },
    "sync-files": async (runId: string, names: unknown) => {
      if (!validId(runId) || !Array.isArray(names) || !names.length || names.length > 20 || names.some(name => typeof name !== "string" || name.length > 120 || /[\\/:\x00]/.test(name)) || new Set(names).size !== names.length) throw new Error("invalid_local_request");
      return coordinator().syncFiles(runId, names);
    },
    "review-approval": async (runId: string, id: string, fingerprint: string) => {
      const epoch = auth.epoch;
      if (!validId(runId) || !validId(id) || typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("invalid_local_request");
      const client = localClient();
      const job = await client.request("get", { run_id: runId });
      const workspace = localGrants.get(job.workspace_id);
      const approval = job.approvals?.find((item: any) => item.id === id && item.sha256 === fingerprint);
      if (!workspace || !approval || job.state !== "running") throw new Error("approval_unavailable");
      const decision = await dialog.showMessageBox(win, {
        type: "warning", title: "审阅本机操作", message: "允许此次命令执行？",
        detail: `工作空间：${workspace}\n工具：${approval.tool}\n具体参数：\n${approval.arguments}\n\n此命令可能修改或删除文件、访问网络或启动程序。批准只适用于此次操作。`,
        buttons: ["拒绝此次操作", "允许此次操作"], defaultId: 0, cancelId: 0,
      });
      if (epoch !== auth.epoch || client !== localWork || !localGrants.has(job.workspace_id)) throw new Error("local_account_changed");
      await client.request("review-approval", { run_id: runId, id, sha256: fingerprint, allow: decision.response === 1 });
      return coordinator().get(runId);
    },
    "open-artifact": async (runId: string, name: string) => {
      const epoch = auth.epoch;
      if (!validId(runId) || typeof name !== "string" || name.length > 120 || /[\\/:\x00]/.test(name)) throw new Error("invalid_local_request");
      const result = await localClient().request("artifact-path", { run_id: runId, name });
      const job = await localClient().request("get", { run_id: runId });
      const workspace = localGrants.get(job.workspace_id);
      if (!workspace) throw new Error("workspace_permission_required");
      const expected = path.join(workspace, "WeMeet成果", runId, "output", name);
      if (result.path !== expected || realpathSync(expected) !== expected || !lstatSync(expected).isFile() || lstatSync(expected).nlink !== 1) throw new Error("artifact_changed");
      if (!auth.signedIn || epoch !== auth.epoch) throw new Error("local_account_changed");
      const error = await shell.openPath(result.path);
      if (error) throw new Error("local_open_failed");
    },
  };
  const changeRuntime = async (rollback: boolean) => {
    if (!managedRuntime) throw new Error("local_runtime_unavailable");
    const paths = localPaths();
    const epoch = auth.epoch;
    if (existsSync(paths.configuration) && (await localClient().request("list")).some((j: any) => ["queued", "running"].includes(j.state))) throw new Error("runtime_tasks_active");
    const configuration = existsSync(paths.configuration) ? JSON.parse(safeStorage.decryptString(readFileSync(paths.configuration))) as LocalConfiguration : null;
    const probe = async (executable: string) => {
      const client = new LocalWorkClient({ executable, apiKey: configuration?.apiKey || "sk-runtime-probe-no-provider-call", model: configuration?.model || "deepseek-flash", source: "bundled" }, path.join(paths.root, "runtime-probes", randomUUID()));
      try {
        const c = await client.request("capabilities");
        if (!c.ready || c.contract !== "work-local/v1" || c.engine !== "dsh" || !c.features?.includes("command_approval")) throw new Error("local_adapter_upgrade_required");
        if (epoch !== auth.epoch) throw new Error("local_account_changed");
      } finally { await client.close(); }
    };
    if (rollback) {
      const consent = await dialog.showMessageBox(win, { title: "回退本机执行器", message: "回退到上一个已验证版本？", detail: "运行环境将重新校验，随后需要重新授权工作空间。", buttons: ["取消", "回退"], defaultId: 0, cancelId: 0 });
      if (consent.response !== 1) return null;
      if (epoch !== auth.epoch) throw new Error("local_account_changed");
      await closeLocalWork();
      await managedRuntime.rollback(probe);
    } else {
      if (!(await managedRuntime.status()).signed_updates_enabled) throw new Error("runtime_signing_unconfigured");
      const choice = await dialog.showOpenDialog(win, { title: "选择已签名的运行环境升级包", properties: ["openFile"], filters: [{ name: "Signed Runtime", extensions: ["zip"] }] });
      if (choice.canceled) return null;
      if (epoch !== auth.epoch) throw new Error("local_account_changed");
      const stage = path.join(app.getPath("userData"), "runtime-staging", randomUUID());
      mkdirSync(path.dirname(stage), { recursive: true });
      await promisify(execFile)(path.join(process.env.SYSTEMROOT!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-File", path.join(__dirname, "extract-runtime.ps1"), "-Archive", choice.filePaths[0], "-Destination", stage], { windowsHide: true, timeout: 120000 });
      if (epoch !== auth.epoch) throw new Error("local_account_changed");
      await closeLocalWork();
      await managedRuntime.install(stage, probe);
    }
    managedExecutable = (await managedRuntime.resolve()).executable;
    managedError = "";
    return managedRuntime.status();
  };
  localHandlers["update-runtime"] = () => changeRuntime(false);
  localHandlers["rollback-runtime"] = () => changeRuntime(true);
  const localArity: Record<string, number> = { status: 0, configure: 1, "pick-workspace": 0, list: 0, submit: 1, get: 1, cancel: 1, "open-artifact": 2, resume: 2, "sync-files": 2, "review-approval": 3, "update-runtime": 0, "rollback-runtime": 0, "remote-workspace": 2, "remote-inbox": 0, "take-remote": 2 };
  const validId = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
  for (const [name, handler] of Object.entries(localHandlers))
    ipcMain.handle(`work:${name}`, async (event, ...args) => {
      if (!senderAllowed(event) || args.length !== localArity[name] || !auth.signedIn || quitting) throw new Error("Invalid local Work request");
      if (localConfiguring) throw new Error("local_busy");
      const changing = ["configure", "update-runtime", "rollback-runtime"].includes(name);
      if (changing) localConfiguring = true;
      const epoch = auth.epoch;
      try {
        const result = await handler(...args);
        if (epoch !== auth.epoch || !auth.signedIn) throw new Error("local_account_changed");
        return result;
      } catch (error) {
        const code = error instanceof Error && /^[a-z_0-9]{1,60}$/.test(error.message) ? error.message : "local_request_failed";
        throw new Error(code);
      } finally { if (changing) localConfiguring = false; }
    });
  for (const [name, action] of Object.entries({
    status: () => ({ ...status }),
    login: beginLogin,
    logout,
    retry: () => {
      status.message = "";
      return win.loadURL(rendererOrigin);
    },
  }))
    ipcMain.handle(`desktop:${name}`, (event, ...args) => {
      if (!senderAllowed(event) || args.length)
        throw new Error("Invalid desktop request");
      return action();
    });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "We-Meet",
        submenu: [
          {
            label: "关于 We-Meet",
            click: () => {
              void dialog.showMessageBox(win, {
                message: `We-Meet ${app.getVersion()}`,
                detail: `服务：${config.serviceOrigin}\n内部试用版本；升级前请停止并保存本机录音。`,
              });
            },
          },
          {
            label: "退出账号",
            click: () => {
              void logout().catch(() => report("退出处理失败。"));
            },
          },
          { type: "separator" },
          {
            label: "退出客户端",
            accelerator: "Alt+F4",
            click: () => {
              void confirmExit();
            },
          },
        ],
      },
      {
        label: "编辑",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "窗口",
        submenu: [
          {
            label: "重新加载",
            accelerator: "Ctrl+R",
            click: () => {
              void dialog
                .showMessageBox(win, {
                  message: "重新加载会断开本机会议与采集，请先保存录音。",
                  buttons: ["取消", "重新加载"],
                  defaultId: 0,
                  cancelId: 0,
                })
                .then((result) => {
                  if (result.response === 1) win.reload();
                });
            },
          },
          { role: "minimize" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
        ],
      },
    ]),
  );
  await loadInitialPage(win, rendererOrigin);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    focus();
    void receiveCallback(argv.find((arg) => arg.startsWith(CALLBACK)));
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    void receiveCallback(url);
  });
  app.on("before-quit", (event) => {
    if (!quitting && window) {
      event.preventDefault();
      void confirmExit();
    }
  });
  void app
    .whenReady()
    .then(async () => {
      const descriptor = path.join(__dirname, "bundled-runtime.json");
      if (existsSync(descriptor) && process.platform === "win32") {
        const trustFile = path.join(__dirname, "runtime-trust.json");
        managedRuntime = new ManagedRuntime(app.isPackaged ? path.join(process.resourcesPath, "local-agent") : path.join(__dirname, "../.agent-runtime"), path.join(app.getPath("userData"), "managed-runtime-v1"), JSON.parse(readFileSync(descriptor, "utf8")), existsSync(trustFile) ? JSON.parse(readFileSync(trustFile, "utf8")) : []);
        try { managedExecutable = (await managedRuntime.resolve()).executable; }
        catch { managedError = "runtime_integrity_failed"; }
      }
      if (app.isPackaged)
        app.setAsDefaultProtocolClient("online.we-meet.desktop");
      await createWindow();
      await receiveCallback(
        process.argv.find((arg) => arg.startsWith(CALLBACK)),
      );
    })
    .catch(() => {
      if (quitting) return;
      dialog.showErrorBox(
        "We-Meet 启动失败",
        "请检查安装文件是否完整，重新安装后重试。",
      );
      quitting = true;
      app.quit();
    });
  app.on("window-all-closed", () => {
    quitting = true;
    void closeLocalWork().finally(() => app.quit());
  });
}
