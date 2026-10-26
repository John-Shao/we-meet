import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  net,
  powerMonitor,
  safeStorage,
  screen,
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
import { RemoteControlCloud } from "./remote-control/cloud";
import { RemoteDesktopRuntime, publicRemoteError } from "./remote-control/runtime";
import { bindScreenSource } from "./remote-control/source-binding";
import { chooseCaptureSource } from "./remote-control/source-picker";
import { ScreenPicker } from "./screen-picker/picker";
import { nativeDescriptor } from "./remote-control/native-resources";
import type { RemoteDesktopEvent } from "./remote-control/bridge";

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
let aiCallWindow: BrowserWindow | undefined;
type AiCallState = {
  state: "idle" | "connecting" | "active" | "sharing" | "error" | "ended";
  startedAt?: number;
  sharing?: boolean;
};
let aiCallState: AiCallState = { state: "idle" };
let aiCallPinned = false;
const publishAiCallState = () => {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
    window.webContents.send("ai-call:status", aiCallState);
};
let auth: DesktopAuth;
let quitting = false;
let closing = false;
let loginStarting = false;
let loginTimer: NodeJS.Timeout | undefined;
let remoteControl: RemoteDesktopRuntime | undefined;
let screenPicker: ScreenPicker | undefined;
const closeRemoteControl = (reason: string) => remoteControl?.close(reason) ?? Promise.resolve();

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
    await closeRemoteControl("account_changed");
    await auth.complete(raw);
    clearTimeout(loginTimer);
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
  screenPicker?.close();
  const ses = window!.webContents.session;
  await window!.loadURL("about:blank");
  await ses.clearStorageData();
  await ses.clearCache();
  await ses.closeAllConnections();
}

async function logout(message = "") {
  clearTimeout(loginTimer);
  const remoteCleanup = closeRemoteControl("account_changed");
  auth.clear();
  await remoteCleanup;
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
    await closeRemoteControl("app_quit");
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
    titleBarStyle: "hidden",
    ...(process.platform !== "darwin" ? {
      titleBarOverlay: { color: "#f6f6f6", symbolColor: "#555555", height: 40 },
    } : {}),
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
  screenPicker = new ScreenPicker({
    rendererOrigin,
    preload: path.join(__dirname, "preload.js"),
    session: ses,
  });
  win.webContents.on("did-finish-load", publishAiCallState);
  win.on("restore", () => {
    const float = aiCallWindow;
    if (float && !float.isDestroyed() && !aiCallPinned) float.setParentWindow(win);
  });
  const openAiCallWindow = async () => {
    if (aiCallWindow && !aiCallWindow.isDestroyed()) {
      if (aiCallWindow.isMinimized()) aiCallWindow.restore();
      aiCallWindow.show();
      aiCallWindow.focus();
      return;
    }
    const float = new BrowserWindow({
      width: 420,
      height: 700,
      minWidth: 360,
      minHeight: 520,
      show: false,
      title: "打电话",
      backgroundColor: "#ffffff",
      titleBarStyle: "hidden",
      parent: win,
      alwaysOnTop: false,
      ...(process.platform !== "darwin" ? {
        titleBarOverlay: { color: "#f6f6f6", symbolColor: "#555555", height: 40 },
      } : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    aiCallWindow = float;
    aiCallPinned = false;
    float.on("closed", () => {
      if (aiCallWindow === float) aiCallWindow = undefined;
      aiCallPinned = false;
      aiCallState = { state: "ended", startedAt: aiCallState.startedAt };
      publishAiCallState();
    });
    float.once("ready-to-show", () => float.show());
    float.webContents.setWindowOpenHandler(({ url }) => {
      if (externalUrl(url)) void shell.openExternal(url).catch(() => {});
      return { action: "deny" };
    });
    float.webContents.on("will-attach-webview", (event) => event.preventDefault());
    float.webContents.on("will-navigate", (event, url) => {
      if (!sameOrigin(url, rendererOrigin)) event.preventDefault();
    });
    await float.loadURL(`${rendererOrigin}/ai-call-float`);
  };
  ipcMain.handle("ai-call:open", (event) => {
    if (
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame ||
      !sameOrigin(event.senderFrame.url, rendererOrigin)
    ) throw new Error("invalid_ai_call_request");
    return openAiCallWindow();
  });
  ipcMain.handle("ai-call:status", (event, value: unknown) => {
    const float = aiCallWindow;
    if (
      !float ||
      float.isDestroyed() ||
      event.sender !== float.webContents ||
      event.senderFrame !== float.webContents.mainFrame ||
      !sameOrigin(event.senderFrame.url, rendererOrigin)
    ) throw new Error("invalid_ai_call_status");
    if (!value || typeof value !== "object") throw new Error("invalid_ai_call_status");
    const candidate = value as Record<string, unknown>;
    const state = candidate.state;
    if (!["idle", "connecting", "active", "sharing", "error", "ended"].includes(String(state)))
      throw new Error("invalid_ai_call_status");
    aiCallState = {
      state: state as AiCallState["state"],
      startedAt: typeof candidate.startedAt === "number" ? candidate.startedAt : undefined,
      sharing: candidate.sharing === true,
    };
    publishAiCallState();
    return true;
  });
  ipcMain.handle("ai-call:pinned", (event) => {
    const float = aiCallWindow;
    if (
      !float ||
      float.isDestroyed() ||
      event.sender !== float.webContents ||
      event.senderFrame !== float.webContents.mainFrame ||
      !sameOrigin(event.senderFrame.url, rendererOrigin)
    ) throw new Error("invalid_ai_call_request");
    return float.isAlwaysOnTop();
  });
  ipcMain.handle("ai-call:set-pinned", (event, value: unknown) => {
    const float = aiCallWindow;
    if (
      !float ||
      float.isDestroyed() ||
      event.sender !== float.webContents ||
      event.senderFrame !== float.webContents.mainFrame ||
      !sameOrigin(event.senderFrame.url, rendererOrigin)
    ) throw new Error("invalid_ai_call_request");
    if (typeof value !== "boolean") throw new Error("invalid_ai_call_pin");
    float.setAlwaysOnTop(value);
    aiCallPinned = value;
    // Owned windows are hidden when the main window minimizes, so detach while pinned.
    if (value) float.setParentWindow(null);
    else if (!win.isMinimized()) float.setParentWindow(win);
    return float.isAlwaysOnTop();
  });

  remoteControl = new RemoteDesktopRuntime({ auth, cloud: new RemoteControlCloud(config.serviceOrigin, auth),
    resourceRoot: path.join(app.isPackaged ? process.resourcesPath : __dirname, "remote-input"),
    nativeDescriptor: (() => {
      if (!app.isPackaged) return undefined;
      try { return nativeDescriptor(JSON.parse(readFileSync(path.join(__dirname, "bundled-remote-input.json"), "utf8"))); }
      catch { return null; }
    })() });
  const remote = remoteControl;
  remote.on("state", (event: RemoteDesktopEvent) => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("remote-control:state", event);
    if (event.type === "state" && event.status.cleanupBlocked) report("远程控制已停止，但按键释放结果未能确认。请在本机检查键鼠状态；重新启动客户端前不能再次接受远控。");
  });
  powerMonitor.on("lock-screen", () => { void remote.close("desktop_locked"); });
  powerMonitor.on("suspend", () => { void remote.close("system_suspend"); });
  powerMonitor.on("user-did-resign-active", () => { void remote.close("session_changed"); });
  screen.on("display-added", () => { void remote.close("display_changed"); });
  screen.on("display-removed", () => { void remote.close("display_changed"); });
  screen.on("display-metrics-changed", () => { void remote.close("display_changed"); });
  const trusted = (contents: Electron.WebContents | null, origin: string) =>
    !!contents &&
    (contents.id === win.webContents.id ||
      contents.id === aiCallWindow?.webContents.id) &&
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
    if (types.some((type) => !["audio", "video"].includes(type))) {
      callback(false);
      return;
    }
    // Electron reports getDisplayMedia as a media request without media types.
    // The display-capture handler below still gates it by frame, origin,
    // user gesture and the native source picker.
    if (!types.length) {
      callback(true);
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
    let answered = false;
    const answer = (streams: Electron.Streams) => {
      if (answered) return;
      answered = true;
      try {
        callback(streams);
      } catch (error) {
        // Electron throws when a video request is denied without a stream. The
        // request is still failed for the renderer, so denial is expected here.
        if (!streams.video) return;
        throw error;
      }
    };
    const isMain = request.frame === win.webContents.mainFrame;
    const isAiCall =
      !!aiCallWindow && request.frame === aiCallWindow.webContents.mainFrame;
    if (
      (!isMain && !isAiCall) ||
      !sameOrigin(request.securityOrigin, rendererOrigin) ||
      !request.userGesture
    ) {
      answer({});
      return;
    }
    if (isAiCall) {
      const float = aiCallWindow!;
      void (async () => {
        const source = await screenPicker!.open({
          parent: float,
          isCurrent: () => !float.isDestroyed(),
        });
        if (
          source &&
          !float.isDestroyed() &&
          request.frame === float.webContents.mainFrame
        )
          answer({ video: source });
        else answer({});
      })().catch(() => answer({}));
      return;
    }
    const ticket = remote.beginCapture();
    void (async () => {
      if (ticket.context) {
        try { await remote.captureBaseline(ticket); }
        catch { if (ticket.fullScreenOnly) { answer({}); return; } }
      }
      let source: Electron.DesktopCapturerSource | undefined;
      if (ticket.fullScreenOnly) {
        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 0, height: 0 },
        });
        source = await chooseCaptureSource({
          sources,
          displays: screen.getAllDisplays(),
          fullScreenOnly: true,
          isCurrent: () => remote.captureCurrent(ticket) && !win.isDestroyed(),
          ask: options => dialog.showMessageBox(win, options),
        });
      } else {
        source = await screenPicker!.open({
          parent: win,
          isCurrent: () => remote.captureCurrent(ticket) && !win.isDestroyed(),
        });
      }
      if (!source || win.isDestroyed() || !remote.captureCurrent(ticket)) {
        answer({});
        return;
      }
      const currentSources = await desktopCapturer.getSources({
        types: ticket.fullScreenOnly ? ["screen"] : ["screen", "window"], thumbnailSize: { width: 0, height: 0 },
      });
      if (!currentSources.some(current => current.id === source.id && current.display_id === source.display_id) ||
          !remote.captureCurrent(ticket) || win.isDestroyed()) { answer({}); return; }
      if (ticket.context && source.id.startsWith("screen:")) {
        try {
          const probe = await remote.probeCapture();
          if (!probe.ready) throw new Error("native_unavailable");
          const binding = bindScreenSource(source, screen.getAllDisplays(), probe.displays,
            rect => screen.dipToScreenRect(null, rect));
          remote.selectedCapture(ticket, binding);
        } catch {
          if (ticket.fullScreenOnly) { answer({}); return; }
        }
      } else if (ticket.fullScreenOnly) { answer({}); return; }
      if (!remote.captureCurrent(ticket) || win.isDestroyed() || request.frame !== win.webContents.mainFrame) { answer({}); return; }
      answer({ video: source });
    })().catch(() => answer({}));
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
  win.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) void remote.close("page_navigation");
  });
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
    const cleanup = remote.close("renderer_gone");
    void cleanup.then(() => dialog
      .showMessageBox(win, {
        type: "error",
        message: "页面进程已停止，本机音视频采集已中断。",
        buttons: ["重新打开", "退出"],
      }))
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
        report("页面加载失败，请从标题栏“更多 → 窗口 → 重新加载”重试。");
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
  const remoteHandlers = {
    capabilities: remote.capabilities.bind(remote), showRequest: remote.showRequest.bind(remote),
    bindPublishedTrack: remote.bindPublishedTrack.bind(remote), forwardSignedMessage: remote.forwardSignedMessage.bind(remote),
    stop: remote.stop.bind(remote),
  };
  for (const [name, action] of Object.entries(remoteHandlers)) {
    ipcMain.handle(`remote-control:${name}`, async (event, ...args) => {
      if (!senderAllowed(event) || args.length !== 1 || !auth.signedIn || quitting) throw new Error("invalid_remote_request");
      try { return await action(args[0]); }
      catch (error) { throw new Error(publicRemoteError(error)); }
    });
  }
  for (const [name, action] of Object.entries({
    status: () => ({ ...status }),
    login: beginLogin,
    logout,
    retry: async () => {
      status.message = "";
      await remote.close("page_reload");
      return win.loadURL(rendererOrigin);
    },
  }))
    ipcMain.handle(`desktop:${name}`, (event, ...args) => {
      if (!senderAllowed(event) || args.length)
        throw new Error("Invalid desktop request");
      return action();
    });
  const reloadWithConfirmation = () => {
    void dialog.showMessageBox(win, {
      message: "重新加载会断开本机会议与采集，请先保存录音。",
      buttons: ["取消", "重新加载"],
      defaultId: 0,
      cancelId: 0,
    }).then(async (result) => {
      if (result.response === 1 && !win.isDestroyed()) {
        await remote.close("page_reload");
        if (!win.isDestroyed()) win.reload();
      }
    });
  };
  const desktopMenu = Menu.buildFromTemplate([
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
            click: reloadWithConfirmation,
          },
          { role: "minimize" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
        ],
      },
    ]);
  // Keep the macOS application menu; Windows/Linux use the title-bar popup.
  Menu.setApplicationMenu(process.platform === "darwin" ? desktopMenu : null);
  ipcMain.handle("desktop:menu", (event, ...args) => {
    if (!senderAllowed(event) || args.length) throw new Error("Invalid desktop request");
    desktopMenu.popup({ window: win });
  });
  ipcMain.handle("desktop:window-state", (event, ...args) => {
    if (!senderAllowed(event) || args.length) throw new Error("Invalid desktop request");
    return { fullscreen: win.isFullScreen() };
  });
  ipcMain.handle("desktop:titlebar-theme", (event, theme, ...args) => {
    if (!senderAllowed(event) || args.length || !["light", "dark"].includes(theme))
      throw new Error("Invalid desktop request");
    if (process.platform !== "darwin") win.setTitleBarOverlay({
      color: theme === "dark" ? "#1e2024" : "#f6f6f6",
      symbolColor: theme === "dark" ? "#e5e5e5" : "#555555",
      height: 40,
    });
  });
  // Windows can emit the transition before isFullScreen() reflects it.
  win.on("enter-full-screen", () => win.webContents.send("desktop:window-state", { fullscreen: true }));
  win.on("leave-full-screen", () => win.webContents.send("desktop:window-state", { fullscreen: false }));
  // Hidden menus don't register accelerators on Windows/Linux. Preserve the
  // guarded reload and zoom shortcuts without taking over text editing.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.alt) return;
    const key = input.key.toLowerCase();
    if (key === "f5" || (key === "r" && (input.control || input.meta))) {
      event.preventDefault();
      reloadWithConfirmation();
    } else if ((input.control || input.meta) && ["0", "+", "=", "-"].includes(key)) {
      event.preventDefault();
      const zoom = win.webContents.getZoomLevel();
      win.webContents.setZoomLevel(key === "0" ? 0 : Math.max(-3, Math.min(3, zoom + (key === "-" ? -0.5 : 0.5))));
    }
  });
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
      // Portable acceptance runs must not replace the installed app's login
      // protocol registration. Normal installed startup keeps its behavior.
      if (app.isPackaged && !app.commandLine.hasSwitch("no-default-protocol-registration"))
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
    void closeRemoteControl("window_closed").finally(() => app.quit());
  });
}
