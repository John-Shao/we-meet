import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
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
import { createHash, randomUUID } from "node:crypto";
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
import {
  RemoteDesktopRuntime,
  publicRemoteError,
} from "./remote-control/runtime";
import { bindScreenSource } from "./remote-control/source-binding";
import { chooseCaptureSource } from "./remote-control/source-picker";
import { ScreenPicker } from "./screen-picker/picker";
import { nativeDescriptor } from "./remote-control/native-resources";
import { WorkApi, WorkApiError } from "./work/api";
import { WorkDeviceDriver, type LocalApprovalDetail } from "./work/driver";
import {
  ArtifactExportError,
  exportArtifactVersion,
} from "./work/artifact-export";
import { DeviceStore } from "./work/store";
import { workDeviceDescriptor } from "./work/broker";
import {
  installViewerProtocol,
  registerViewerScheme,
} from "./work/viewer-protocol";
import { ViewerManager } from "./work/viewer-window";
import {
  createClipboardHtml,
  readClipboardProvenance,
} from "./work/clipboard-provenance";
import type {
  LocalArtifactAcceptanceContext,
  LocalArtifactEditContext,
  LocalArtifactEditDraft,
  LocalContentKind,
} from "./work/bridge";
import type { RemoteDesktopEvent } from "./remote-control/bridge";

registerViewerScheme();

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
    ...(!app.isPackaged &&
    process.env.WEMEET_WORK_GATEWAY_ORIGIN &&
    process.env.WEMEET_WORK_SERVER_NAME &&
    process.env.WEMEET_WORK_CA_PEM_PATH
      ? {
          work: {
            gatewayOrigin: process.env.WEMEET_WORK_GATEWAY_ORIGIN,
            serverName: process.env.WEMEET_WORK_SERVER_NAME,
            caPemPath: process.env.WEMEET_WORK_CA_PEM_PATH,
          },
        }
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
let workDriver: WorkDeviceDriver | undefined;
let workViewer: ViewerManager | undefined;
let workMainWindow: BrowserWindow | undefined;
const viewerEditContexts = new Map<number, LocalArtifactEditContext>();
const viewerDrafts = new Map<number, LocalArtifactEditDraft>();
const viewerClipboard = new Map<
  number,
  { derived: boolean; sources: string[] }
>();
const viewerApprovals = new Map<
  number,
  { detail: LocalApprovalDetail; requestId: string }
>();
const viewerAcceptances = new Map<
  number,
  { context: LocalArtifactAcceptanceContext; requestId: string }
>();
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function armApprovalViewer(
  viewer: ViewerManager,
  viewerWindow: BrowserWindow,
  approvalId: string,
  requestId: string,
  canRememberReadonly: boolean,
  destinationFacts: LocalApprovalDetail["destinationFacts"],
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (viewerWindow.isDestroyed()) return;
    if (viewer.isReady(viewerWindow)) {
      viewer.send(viewerWindow, {
        type: "approval",
        approval_id: approvalId,
        request_id: requestId,
        can_remember_readonly: canRememberReadonly,
        local_only_taint: destinationFacts.localOnlyTaint,
        current_action_taints: destinationFacts.currentActionTaints,
        available_destinations: destinationFacts.availableDestinations,
      });
      viewer.authorizeRequest(viewerWindow, requestId);
      return;
    }
    await delay(25);
  }
}
async function armArtifactAcceptanceViewer(
  viewer: ViewerManager,
  viewerWindow: BrowserWindow,
  context: LocalArtifactAcceptanceContext,
  requestId: string,
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (viewerWindow.isDestroyed()) return;
    if (viewer.isReady(viewerWindow)) {
      viewer.send(viewerWindow, {
        type: "artifact_accept",
        artifact_id: context.artifactId,
        version_id: context.versionId,
        content_hash: context.contentHash,
        request_id: requestId,
      });
      viewer.authorizeRequest(viewerWindow, requestId);
      return;
    }
    await delay(25);
  }
}
let startWorkDriver: () => Promise<void> = async () => {};
const closeRemoteControl = (reason: string) =>
  remoteControl?.close(reason) ?? Promise.resolve();
const stopWorkDriver = () => {
  workViewer?.closeAll();
  viewerEditContexts.clear();
  viewerDrafts.clear();
  viewerApprovals.clear();
  viewerAcceptances.clear();
  return workDriver?.stop() ?? Promise.resolve();
};

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
    void startWorkDriver();
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
  const workCleanup = stopWorkDriver();
  auth.clear();
  await remoteCleanup;
  await workCleanup;
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
    await stopWorkDriver();
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
  auth = new DesktopAuth(
    config,
    {
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
    },
    fetch,
    () => {
      void logout("登录已失效，请重新登录。").catch(() => {
        report("登录已失效，请重启客户端后重新登录。");
      });
    },
  );
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
      (request) =>
        forwardRequest(request, (options) =>
          net.request({ ...options, session: ses }),
        ),
    );
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: "We-Meet",
    backgroundColor: "#ffffff",
    titleBarStyle: "hidden",
    ...(process.platform !== "darwin"
      ? {
          titleBarOverlay: {
            color: "#f6f6f6",
            symbolColor: "#555555",
            height: 40,
          },
        }
      : {}),
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
  workMainWindow = win;
  screenPicker = new ScreenPicker({
    rendererOrigin,
    preload: path.join(__dirname, "preload.js"),
    session: ses,
  });
  win.webContents.on("did-finish-load", publishAiCallState);
  win.on("restore", () => {
    const float = aiCallWindow;
    if (float && !float.isDestroyed() && !aiCallPinned)
      float.setParentWindow(win);
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
      ...(process.platform !== "darwin"
        ? {
            titleBarOverlay: {
              color: "#f6f6f6",
              symbolColor: "#555555",
              height: 40,
            },
          }
        : {}),
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
    float.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
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
    )
      throw new Error("invalid_ai_call_request");
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
    )
      throw new Error("invalid_ai_call_status");
    if (!value || typeof value !== "object")
      throw new Error("invalid_ai_call_status");
    const candidate = value as Record<string, unknown>;
    const state = candidate.state;
    if (
      !["idle", "connecting", "active", "sharing", "error", "ended"].includes(
        String(state),
      )
    )
      throw new Error("invalid_ai_call_status");
    aiCallState = {
      state: state as AiCallState["state"],
      startedAt:
        typeof candidate.startedAt === "number"
          ? candidate.startedAt
          : undefined,
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
    )
      throw new Error("invalid_ai_call_request");
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
    )
      throw new Error("invalid_ai_call_request");
    if (typeof value !== "boolean") throw new Error("invalid_ai_call_pin");
    float.setAlwaysOnTop(value);
    aiCallPinned = value;
    // Owned windows are hidden when the main window minimizes, so detach while pinned.
    if (value) float.setParentWindow(null);
    else if (!win.isMinimized()) float.setParentWindow(win);
    return float.isAlwaysOnTop();
  });

  remoteControl = new RemoteDesktopRuntime({
    auth,
    cloud: new RemoteControlCloud(config.serviceOrigin, auth),
    resourceRoot: path.join(
      app.isPackaged ? process.resourcesPath : __dirname,
      "remote-input",
    ),
    nativeDescriptor: (() => {
      if (!app.isPackaged) return undefined;
      try {
        return nativeDescriptor(
          JSON.parse(
            readFileSync(
              path.join(__dirname, "bundled-remote-input.json"),
              "utf8",
            ),
          ),
        );
      } catch {
        return null;
      }
    })(),
  });
  const remote = remoteControl;
  remote.on("state", (event: RemoteDesktopEvent) => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed())
      win.webContents.send("remote-control:state", event);
    if (event.type === "state" && event.status.cleanupBlocked)
      report(
        "远程控制已停止，但按键释放结果未能确认。请在本机检查键鼠状态；重新启动客户端前不能再次接受远控。",
      );
  });
  powerMonitor.on("lock-screen", () => {
    void remote.close("desktop_locked");
  });
  powerMonitor.on("suspend", () => {
    void remote.close("system_suspend");
  });
  powerMonitor.on("user-did-resign-active", () => {
    void remote.close("session_changed");
  });
  screen.on("display-added", () => {
    void remote.close("display_changed");
  });
  screen.on("display-removed", () => {
    void remote.close("display_changed");
  });
  screen.on("display-metrics-changed", () => {
    void remote.close("display_changed");
  });
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
        try {
          await remote.captureBaseline(ticket);
        } catch {
          if (ticket.fullScreenOnly) {
            answer({});
            return;
          }
        }
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
          ask: (options) => dialog.showMessageBox(win, options),
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
        types: ticket.fullScreenOnly ? ["screen"] : ["screen", "window"],
        thumbnailSize: { width: 0, height: 0 },
      });
      if (
        !currentSources.some(
          (current) =>
            current.id === source.id &&
            current.display_id === source.display_id,
        ) ||
        !remote.captureCurrent(ticket) ||
        win.isDestroyed()
      ) {
        answer({});
        return;
      }
      if (ticket.context && source.id.startsWith("screen:")) {
        try {
          const probe = await remote.probeCapture();
          if (!probe.ready) throw new Error("native_unavailable");
          const binding = bindScreenSource(
            source,
            screen.getAllDisplays(),
            probe.displays,
            (rect) => screen.dipToScreenRect(null, rect),
          );
          remote.selectedCapture(ticket, binding);
        } catch {
          if (ticket.fullScreenOnly) {
            answer({});
            return;
          }
        }
      } else if (ticket.fullScreenOnly) {
        answer({});
        return;
      }
      if (
        !remote.captureCurrent(ticket) ||
        win.isDestroyed() ||
        request.frame !== win.webContents.mainFrame
      ) {
        answer({});
        return;
      }
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
  win.webContents.on(
    "did-start-navigation",
    (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) void remote.close("page_navigation");
    },
  );
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
    void cleanup
      .then(() =>
        dialog.showMessageBox(win, {
          type: "error",
          message: "页面进程已停止，本机音视频采集已中断。",
          buttons: ["重新打开", "退出"],
        }),
      )
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
    capabilities: remote.capabilities.bind(remote),
    showRequest: remote.showRequest.bind(remote),
    bindPublishedTrack: remote.bindPublishedTrack.bind(remote),
    forwardSignedMessage: remote.forwardSignedMessage.bind(remote),
    stop: remote.stop.bind(remote),
  };
  for (const [name, action] of Object.entries(remoteHandlers)) {
    ipcMain.handle(`remote-control:${name}`, async (event, ...args) => {
      if (
        !senderAllowed(event) ||
        args.length !== 1 ||
        !auth.signedIn ||
        quitting
      )
        throw new Error("invalid_remote_request");
      try {
        return await action(args[0]);
      } catch (error) {
        throw new Error(publicRemoteError(error));
      }
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
    void dialog
      .showMessageBox(win, {
        message: "重新加载会断开本机会议与采集，请先保存录音。",
        buttons: ["取消", "重新加载"],
        defaultId: 0,
        cancelId: 0,
      })
      .then(async (result) => {
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
    if (!senderAllowed(event) || args.length)
      throw new Error("Invalid desktop request");
    desktopMenu.popup({ window: win });
  });
  ipcMain.handle("desktop:window-state", (event, ...args) => {
    if (!senderAllowed(event) || args.length)
      throw new Error("Invalid desktop request");
    return { fullscreen: win.isFullScreen() };
  });
  ipcMain.handle("desktop:titlebar-theme", (event, theme, ...args) => {
    if (
      !senderAllowed(event) ||
      args.length ||
      !["light", "dark"].includes(theme)
    )
      throw new Error("Invalid desktop request");
    if (process.platform !== "darwin")
      win.setTitleBarOverlay({
        color: theme === "dark" ? "#1e2024" : "#f6f6f6",
        symbolColor: theme === "dark" ? "#e5e5e5" : "#555555",
        height: 40,
      });
  });
  // Windows can emit the transition before isFullScreen() reflects it.
  win.on("enter-full-screen", () =>
    win.webContents.send("desktop:window-state", { fullscreen: true }),
  );
  win.on("leave-full-screen", () =>
    win.webContents.send("desktop:window-state", { fullscreen: false }),
  );
  // Hidden menus don't register accelerators on Windows/Linux. Preserve the
  // guarded reload and zoom shortcuts without taking over text editing.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.alt) return;
    const key = input.key.toLowerCase();
    if (key === "f5" || (key === "r" && (input.control || input.meta))) {
      event.preventDefault();
      reloadWithConfirmation();
    } else if (
      (input.control || input.meta) &&
      ["0", "+", "=", "-"].includes(key)
    ) {
      event.preventDefault();
      const zoom = win.webContents.getZoomLevel();
      win.webContents.setZoomLevel(
        key === "0"
          ? 0
          : Math.max(-3, Math.min(3, zoom + (key === "-" ? -0.5 : 0.5))),
      );
    }
  });
  // The Work device driver (M2): main-process only. No preload method and no renderer
  // whitelist entry is added — the pairing gesture is a main-process dialog (§2.1 step 2,
  // the §1.1 deviation is registered in the design), and driver failures surface through
  // the existing desktop:status message channel.
  if (config.work) {
    const work = config.work;
    workViewer = new ViewerManager(
      path.join(__dirname, "viewer-preload.js"),
      (viewerContents, method, payload) => {
        const driver = workDriver;
        const viewer = workViewer;
        const context = viewerEditContexts.get(viewerContents.id);
        const viewerWindow = viewer?.windowFor(viewerContents);
        const data = payload as Record<string, unknown> | undefined;
        if (!driver || !viewer || !viewerWindow) return;
        if (method === "copyLocalArtifactVersion" && data) {
          const source = viewer.renderedArtifactVersion(viewerContents);
          if (!source || data.text !== source.text) return;
          void clipboard.write([
            new ClipboardItem({
              "text/plain": source.text,
              "text/html": createClipboardHtml(source.text, source.versionId),
            }),
          ]).catch(() => {
            viewer.send(viewerWindow, {
              type: "error",
              code: "invalid_work_request",
            });
          });
          return;
        }
        if (method === "exportArtifactVersion" && data) {
          const source = viewer.renderedArtifactVersion(viewerContents);
          if (!source || data.version_id !== source.versionId) return;
          void (async () => {
            try {
              const content = await driver.openLocalContent(
                "artifact_version",
                source.versionId,
              );
              if (
                content.status !== "available" ||
                content.text !== source.text
              ) {
                viewer.send(viewerWindow, {
                  type: "error",
                  code: "invalid_work_request",
                });
                return;
              }
              try {
                const status = await exportArtifactVersion(
                  source.versionId,
                  content,
                  (options) => dialog.showSaveDialog(viewerWindow, options),
                  (filePath, text) =>
                    writeFileSync(filePath, text, {
                      encoding: "utf8",
                      flag: "wx",
                      mode: 0o600,
                    }),
                );
                viewer.send(viewerWindow, { type: "export_status", status });
              } catch (error) {
                viewer.send(viewerWindow, {
                  type: "error",
                  code:
                    error instanceof ArtifactExportError
                      ? error.code
                      : "export_failed",
                });
                return;
              }
            } catch {
              viewer.send(viewerWindow, {
                type: "error",
                code: "export_failed",
              });
            }
          })();
          return;
        }
        if (method === "pasteLocalArtifactText") {
          void (async () => {
            try {
              const items = await clipboard.read();
              const item = items.find((candidate) =>
                candidate.types.includes("text/plain"),
              );
              if (!item) {
                viewer.send(viewerWindow, {
                  type: "error",
                  code: "invalid_work_request",
                });
                return;
              }
              const textBlob = await item.getType("text/plain");
              if (!(textBlob instanceof Blob) || textBlob.size > 1024 * 1024) {
                viewer.send(viewerWindow, {
                  type: "error",
                  code: "invalid_work_request",
                });
                return;
              }
              const text = await textBlob.text();
              let html = "";
              if (item.types.includes("text/html")) {
                const htmlBlob = await item.getType("text/html");
                if (
                  !(htmlBlob instanceof Blob) ||
                  htmlBlob.size > 2 * 1024 * 1024
                ) {
                  viewer.send(viewerWindow, {
                    type: "error",
                    code: "invalid_work_request",
                  });
                  return;
                }
                html = await htmlBlob.text();
              }
              const provenance = readClipboardProvenance(html, text);
              if (text.includes("\x00")) {
                viewer.send(viewerWindow, {
                  type: "error",
                  code: "invalid_work_request",
                });
                return;
              }
              viewerClipboard.set(viewerContents.id, provenance);
              viewer.send(viewerWindow, {
                type: "clipboard_paste",
                text,
                clipboard_derived: provenance.derived,
                clipboard_source_version_ids: provenance.sources,
              });
            } catch {
              viewer.send(viewerWindow, { type: "error", code: "invalid_work_request" });
            }
          })();
          return;
        }
        if (method === "decideLocalApproval" && data) {
          const approval = viewerApprovals.get(viewerContents.id);
          if (!approval || data.request_id !== approval.requestId) return;
          const decision = data.decision;
          if (decision !== "approved" && decision !== "rejected") return;
          void (async () => {
            try {
              const result = await driver.decideLocalApproval(
                approval.detail,
                decision,
                approval.requestId,
                data.remember_readonly === true,
              );
              viewer.send(viewerWindow, {
                type: "approval_decided",
                decision: result.decision,
                approval_revision: String(result.approvalRevision),
              });
              workMainWindow?.webContents.send("work:approval-decided", {
                approvalId: result.approvalId,
                runId: result.runId,
              });
            } catch {
              viewer.send(viewerWindow, {
                type: "error",
                code: "invalid_work_request",
              });
            }
          })();
          return;
        }
        if (method === "signObjectProof" && data) {
          const acceptance = viewerAcceptances.get(viewerContents.id);
          if (
            !acceptance ||
            data.request_id !== acceptance.requestId ||
            data.purpose !== "accept" ||
            data.artifact_id !== acceptance.context.artifactId ||
            data.version_id !== acceptance.context.versionId ||
            data.content_hash !== acceptance.context.contentHash
          )
            return;
          viewerAcceptances.delete(viewerContents.id);
          void (async () => {
            try {
              const accepted = await driver.acceptLocalArtifactVersion(
                acceptance.context,
              );
              viewer.send(viewerWindow, {
                type: "artifact_accepted",
                ...accepted,
              });
              workMainWindow?.webContents.send(
                "work:artifact-accepted",
                accepted,
              );
            } catch {
              viewer.send(viewerWindow, {
                type: "error",
                code: "invalid_work_request",
              });
            }
          })();
          return;
        }
        if (method === "prepareUserArtifactVersion" && context && data) {
          void (async () => {
            try {
              const draft = await driver.prepareLocalArtifactEdit({
                context,
                format: data.format as "text/plain" | "text/markdown",
                body: data.body as string,
                clipboardDerived: viewerClipboard.get(viewerContents.id)?.derived ?? false,
                clipboardSourceVersionIds:
                  viewerClipboard.get(viewerContents.id)?.sources ?? [],
              });
              viewerClipboard.delete(viewerContents.id);
              viewerDrafts.set(viewerContents.id, draft);
              viewer.send(viewerWindow, {
                type: "draft",
                request_id: draft.requestId,
                version_id: draft.versionId,
                content_hash: draft.contentHash,
                byte_count: String(draft.byteCount),
                base_byte_count: String(draft.baseByteCount),
              });
              viewer.authorizeRequest(viewerWindow, draft.requestId);
            } catch {
              viewer.send(viewerWindow, {
                type: "error",
                code: "invalid_work_request",
              });
            }
          })();
          return;
        }
        if (method === "confirmLocalWrite" && data) {
          const requestId = data.request_id as string;
          const sealedHash = data.sealed_hash as string;
          const action = data.action as string;
          void (async () => {
            try {
              if (action === "confirm") {
                const published = await driver.confirmLocalArtifactEdit(
                  requestId,
                  sealedHash,
                );
                viewer.send(viewerWindow, { type: "published", ...published });
                workMainWindow?.webContents.send(
                  "work:artifact-published",
                  published,
                );
              } else {
                const status = await driver.decideLocalArtifactEdit(
                  requestId,
                  sealedHash,
                  action as "discard" | "cancel",
                );
                viewer.send(viewerWindow, { type: "status", status });
              }
            } catch {
              if (action === "confirm" && viewerDrafts.has(viewerContents.id))
                viewer.authorizeRequest(viewerWindow, requestId);
              viewer.send(viewerWindow, {
                type: "error",
                code: "invalid_work_request",
              });
            }
          })();
        }
      },
    );
    workViewer.install();
    const devicePath = path.join(app.getPath("userData"), "work-device-v1.enc");
    const storeIo = {
      read: () =>
        existsSync(devicePath)
          ? safeStorage.decryptString(readFileSync(devicePath))
          : undefined,
      write: (value: string) => {
        if (
          !safeStorage.isEncryptionAvailable() ||
          (process.platform === "linux" &&
            safeStorage.getSelectedStorageBackend() === "basic_text")
        )
          throw new Error("安全凭据存储不可用。");
        mkdirSync(path.dirname(devicePath), { recursive: true });
        writeFileSync(devicePath + ".tmp", safeStorage.encryptString(value));
        renameSync(devicePath + ".tmp", devicePath);
      },
      clear: () => {
        try {
          unlinkSync(devicePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        try {
          unlinkSync(devicePath + ".tmp");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      },
    };
    const workResourceRoot = path.join(
      app.isPackaged ? process.resourcesPath : __dirname,
      "work-device",
    );
    const workDescriptor = (() => {
      if (!app.isPackaged) return undefined;
      try {
        return workDeviceDescriptor(
          JSON.parse(
            readFileSync(
              path.join(__dirname, "bundled-work-device.json"),
              "utf8",
            ),
          ),
        );
      } catch {
        return null;
      }
    })();
    startWorkDriver = async () => {
      if (!auth.signedIn || !auth.subject || quitting) return;
      await stopWorkDriver();
      const subject = auth.subject;
      workDriver = new WorkDeviceDriver({
        auth,
        api: new WorkApi(config.serviceOrigin, auth),
        work,
        binding: {
          issuer: config.issuer,
          clientId: config.clientId,
          serviceOrigin: config.serviceOrigin,
        },
        resourceRoot: workResourceRoot,
        descriptor: workDescriptor,
        configDir: path.join(app.getPath("userData"), "work-device"),
        store: new DeviceStore(storeIo, {
          issuer: config.issuer,
          clientId: config.clientId,
          serviceOrigin: config.serviceOrigin,
          subject,
        }),
        askDeviceName: async (defaultName) => {
          if (win.isDestroyed()) return undefined;
          const result = await dialog.showMessageBox(win, {
            type: "question",
            title: "配对 Work 设备",
            message: `将本机配对为 Work 设备「${defaultName}」？`,
            detail:
              "配对后，本机可在当前账号已授权的范围内执行本机任务。设备私钥留在本机 Windows 密钥存储中，不会上传。",
            buttons: ["取消", "确认配对"],
            defaultId: 0,
            cancelId: 0,
          });
          return result.response === 1 ? defaultName : undefined;
        },
        // §1.1: only the main process may trigger the system folder selector; the renderer's path
        // string is never the root. The Broker binds the actual object the selector returned.
        selectWorkspaceDirectory: async () => {
          if (win.isDestroyed()) return undefined;
          const result = await dialog.showOpenDialog(win, {
            title: "选择 Work 工作目录",
            properties: ["openDirectory"],
          });
          return result.canceled || result.filePaths.length === 0
            ? undefined
            : result.filePaths[0];
        },
        // §4.2 step 3/5: show the ACTUAL location the Broker opened (not the selector path), the
        // volume label, and the two warnings. Cancel produces no grant (the Broker closes the handle).
        confirmWorkspaceRoot: async (facts) => {
          if (win.isDestroyed()) return false;
          const warnings: string[] = [];
          if (facts.differsFromSelected)
            warnings.push("实际位置与所选不同（上级目录可能被重定向）。");
          if (facts.otherUserWritable)
            warnings.push("其他本机用户可修改此目录。");
          const result = await dialog.showMessageBox(win, {
            type: warnings.length > 0 ? "warning" : "question",
            title: "授权 Work 工作目录",
            message: `授权本机任务访问目录「${facts.actualLocation}」？`,
            detail: [
              `实际位置：${facts.actualLocation}`,
              `卷标：${facts.volumeLabel || "(无)"}`,
              `所选路径：${facts.selectedPath}`,
              ...warnings,
              "授权后本机任务可在该目录内读取/搜索文件，并在成果目录创建新版本。私钥与正文留在本机。",
            ].join("\n"),
            buttons: ["取消", "确认授权"],
            defaultId: 0,
            cancelId: 0,
          });
          return result.response === 1;
        },
        confirmWorkspaceRebind: async (facts) => {
          if (win.isDestroyed()) return false;
          const result = await dialog.showMessageBox(win, {
            type: "warning",
            title: "重新审批 Work 目录改绑",
            message: "确认将本机 Run 的工作目录授权改绑到新 grant？",
            detail: [
              `Run：${facts.runId}`,
              `当前 grant：${facts.oldGrantId}`,
              `新 grant：${facts.newGrantId}`,
              `根身份：${facts.rootIdentityHash}`,
              "仅同一实际目录可改绑；未派发步骤将重新审批，已派发步骤只核账，不会改写成新执行。",
            ].join("\n"),
            buttons: ["取消", "确认改绑并重新审批"],
            defaultId: 0,
            cancelId: 0,
          });
          return result.response === 1;
        },
        // §5.4 step 3: show the listener process name / path / signer / running account. The account
        // is rendered as its SID (a name translation is a later native face); the LAN-open warning is
        // the §5.4 末段 hint. Cancel produces no binding.
        confirmLocalModel: async (facts) => {
          if (win.isDestroyed()) return false;
          const warnings: string[] = [];
          if (facts.listensOnAllInterfaces)
            warnings.push("该模型服务对局域网开放。");
          const result = await dialog.showMessageBox(win, {
            type: warnings.length > 0 ? "warning" : "question",
            title: "确认本机模型服务",
            message: `将本机任务的本机模型请求发往「${facts.processName}」？`,
            detail: [
              `进程名：${facts.processName}`,
              `映像路径：${facts.imagePath}`,
              `签名者：${facts.signerThumbprint ?? "(未签名)"}`,
              `运行账户 (SID)：${facts.ownerSid}`,
              `映像 SHA-256：${facts.imageSha256}`,
              ...warnings,
              "确认后本机模型请求只发往该已确认的 loopback 服务；正文留在本机。",
            ].join("\n"),
            buttons: ["取消", "确认"],
            defaultId: 0,
            cancelId: 0,
          });
          return result.response === 1;
        },
        confirmLocalConfigurationProbe: async (facts) => {
          if (win.isDestroyed()) return false;
          const result = await dialog.showMessageBox(win, {
            type: "question",
            title: "确认运行本机模型验证探针",
            message: `确认使用「${facts.model}」运行固定的一次性验证探针？`,
            detail: [
              `Profile：${facts.profileId}`,
              `本机端点：${facts.localRef}`,
              `Probe：${facts.probeId}`,
              `预览哈希：${facts.previewHash}`,
              "探针只发送固定模板，不包含任务正文或文件工具；会计入模型用量。",
            ].join("\n"),
            buttons: ["取消", "运行探针"],
            defaultId: 0,
            cancelId: 0,
          });
          return result.response === 1;
        },
        confirmLocalSubmission: async (facts) => {
          if (win.isDestroyed()) return false;
          const result = await dialog.showMessageBox(win, {
            type: "question",
            title: "确认提交本机 Work 任务",
            message: "确认将已预览的任务提交到本机设备执行？",
            detail: [
              `提交请求：${facts.clientRequestId}`,
              `本机输入：${facts.inputRef}`,
              `输入 SHA-256：${facts.inputHash}`,
              `预览：${facts.previewHash}`,
              `目标选择：${facts.targetSelectionHash}`,
              `执行 profile：${facts.profileId} @ ${facts.profileRevision}`,
              `Profile SHA-256：${facts.profileHash}`,
              `目录授权：${facts.selectedGrantIds.map((id, index) => `${id} @ ${facts.grantRevisions[index]}`).join("、")}`,
              `当前认证 epoch：${facts.authEpoch}`,
              facts.artifactClassificationFloor === "local_only"
                ? "所选目录包含 local_only 内容：成果只留本机，不可云同步；设备外模型目的地不可用。"
                : "所选目录允许脱敏摘录；成果分类仍以服务端执行结果为准。",
              `当前可用目的地：${facts.availableDestinations.join("、") || "(无)"}`,
              "确认后设备才会签署 local_intent；正文仍只留在本机。",
            ].join("\n"),
            buttons: ["取消", "确认提交"],
            defaultId: 0,
            cancelId: 0,
          });
          return result.response === 1;
        },
        report,
      });
      await workDriver.start();
    };
    ipcMain.handle("work:get-active-execution-profile", async (event, ...args) => {
      if (
        !senderAllowed(event) ||
        args.length !== 1 ||
        typeof args[0] !== "string" ||
        args[0].length === 0 ||
        args[0].length > 128 ||
        args[0].trim() !== args[0]
      ) {
        throw new Error("invalid_work_request");
      }
      if (!workDriver || workDriver.currentState !== "running") {
        throw new Error("work_device_unavailable");
      }
      try {
        return await workDriver.getActiveExecutionProfile(args[0]);
      } catch (error) {
        if (
          error instanceof WorkApiError &&
          error.code === "work_account_changed"
        ) {
          throw new Error("work_account_changed");
        }
        throw new Error("work_device_unavailable");
      }
    });
    ipcMain.handle("work:get-current-session-id", async (event, ...args) => {
      if (!senderAllowed(event) || args.length !== 0) {
        throw new Error("invalid_work_request");
      }
      if (!workDriver || workDriver.currentState !== "running") {
        throw new Error("work_device_unavailable");
      }
      try {
        return await workDriver.getCurrentSessionId();
      } catch {
        throw new Error("work_device_unavailable");
      }
    });
    ipcMain.handle("work:create-device-model-binding", async (event, ...args) => {
      if (
        !senderAllowed(event) ||
        args.length !== 1 ||
        !args[0] ||
        typeof args[0] !== "object" ||
        Array.isArray(args[0]) ||
        Object.keys(args[0]).sort().join(",") !== "port,profileId,sessionId" ||
        typeof args[0].profileId !== "string" ||
        args[0].profileId.length === 0 ||
        args[0].profileId.length > 128 ||
        args[0].profileId.trim() !== args[0].profileId ||
        !Number.isInteger(args[0].port) ||
        args[0].port < 1 ||
        args[0].port > 65535 ||
        typeof args[0].sessionId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          args[0].sessionId,
        )
      ) {
        throw new Error("invalid_work_request");
      }
      if (!workDriver || workDriver.currentState !== "running") {
        throw new Error("work_device_unavailable");
      }
      try {
        return await workDriver.createDeviceModelBinding(
          args[0].profileId,
          args[0].port,
          args[0].sessionId,
        );
      } catch (error) {
        if (
          error instanceof WorkApiError &&
          error.code === "work_account_changed"
        ) {
          throw new Error("work_account_changed");
        }
        throw new Error("work_device_unavailable");
      }
    });
    ipcMain.handle("work:get-model-probe", async (event, ...args) => {
      if (
        !senderAllowed(event) ||
        args.length !== 1 ||
        typeof args[0] !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          args[0],
        )
      ) {
        throw new Error("invalid_work_request");
      }
      if (!workDriver || workDriver.currentState !== "running") {
        throw new Error("work_device_unavailable");
      }
      try {
        return await workDriver.getModelProbe(args[0]);
      } catch (error) {
        if (
          error instanceof WorkApiError &&
          error.code === "work_account_changed"
        ) {
          throw new Error("work_account_changed");
        }
        throw new Error("work_device_unavailable");
      }
    });
    ipcMain.handle("work:submit-configuration-probe", async (event, ...args) => {
      if (
        !senderAllowed(event) ||
        args.length !== 1 ||
        typeof args[0] !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          args[0],
        )
      ) {
        throw new Error("invalid_work_request");
      }
      if (!workDriver || workDriver.currentState !== "running") {
        throw new Error("work_device_unavailable");
      }
      try {
        return await workDriver.submitConfigurationProbe(args[0]);
      } catch (error) {
        if (
          error instanceof WorkApiError &&
          error.code === "work_account_changed"
        ) {
          throw new Error("work_account_changed");
        }
        throw new Error("work_device_unavailable");
      }
    });
    ipcMain.handle("work:stage-local-input", async (event, ...args) => {
      if (
        !senderAllowed(event) ||
        args.length !== 1 ||
        typeof args[0] !== "string"
      ) {
        throw new Error("invalid_work_request");
      }
      const text = args[0];
      if (
        !text.trim() ||
        text.includes("\x00") ||
        Buffer.byteLength(text, "utf8") > 60 * 1024
      ) {
        throw new Error("invalid_work_request");
      }
      if (!workDriver || workDriver.currentState !== "running") {
        throw new Error("work_device_unavailable");
      }
      try {
        return await workDriver.stageLocalInput(text);
      } catch (error) {
        if (
          error instanceof WorkApiError &&
          error.code === "work_account_changed"
        ) {
          throw new Error("work_account_changed");
        }
        throw new Error("work_device_unavailable");
      }
    });
    ipcMain.handle("work:submit-local-task", async (event, ...args) => {
      if (
        !senderAllowed(event) ||
        args.length !== 1 ||
        !args[0] ||
        typeof args[0] !== "object" ||
        Array.isArray(args[0])
      ) {
        throw new Error("invalid_work_request");
      }
      if (!workDriver || workDriver.currentState !== "running") {
        throw new Error("work_device_unavailable");
      }
      try {
        return await workDriver.submitLocalTask(args[0]);
      } catch (error) {
        if (
          error instanceof WorkApiError &&
          error.code === "work_account_changed"
        ) {
          throw new Error("work_account_changed");
        }
        throw new Error("work_device_unavailable");
      }
    });
    ipcMain.handle("work:confirm-local-submission", async (event, ...args) => {
      if (
        !senderAllowed(event) ||
        args.length !== 1 ||
        !args[0] ||
        typeof args[0] !== "object" ||
        Array.isArray(args[0])
      ) {
        throw new Error("invalid_work_request");
      }
      if (!workDriver || workDriver.currentState !== "running") {
        throw new Error("work_device_unavailable");
      }
      try {
        return await workDriver.confirmLocalSubmission(args[0]);
      } catch (error) {
        if (
          error instanceof WorkApiError &&
          error.code === "work_account_changed"
        ) {
          throw new Error("work_account_changed");
        }
        throw new Error("work_device_unavailable");
      }
    });
    ipcMain.handle(
      "work:list-local-artifact-drafts",
      async (event, ...args) => {
        if (!senderAllowed(event) || args.length !== 1) return [];
        const request = args[0];
        if (
          !request ||
          typeof request !== "object" ||
          Array.isArray(request) ||
          Object.keys(request).sort().join(",") !== "artifactId,taskId" ||
          typeof request.taskId !== "string" ||
          typeof request.artifactId !== "string"
        )
          return [];
        if (!workDriver || workDriver.currentState !== "running") return [];
        try {
          return await workDriver.listLocalArtifactDrafts(
            request.taskId,
            request.artifactId,
          );
        } catch {
          return [];
        }
      },
    );
    ipcMain.handle("work:open-local-artifact-draft", async (event, ...args) => {
      if (!senderAllowed(event) || args.length !== 1)
        return { status: "denied" };
      const request = args[0];
      if (
        !request ||
        typeof request !== "object" ||
        Array.isArray(request) ||
        Object.keys(request).sort().join(",") !==
          "artifactId,taskId,versionId" ||
        typeof request.taskId !== "string" ||
        typeof request.artifactId !== "string" ||
        typeof request.versionId !== "string"
      )
        return { status: "denied" };
      if (!workDriver || workDriver.currentState !== "running" || !workViewer) {
        return { status: "not_on_this_device" };
      }
      try {
        const result = await workDriver.openLocalArtifactDraft(
          request.taskId,
          request.artifactId,
          request.versionId,
        );
        if (result.status !== "available") return result;
        const context: LocalArtifactEditContext = {
          artifactId: result.draft.artifactId,
          taskId: result.draft.taskId,
          baseVersionId: result.draft.baseVersionId,
          baseVersionNo: result.draft.baseVersionNo,
          baseHash: result.draft.baseHash,
        };
        const viewerWindow = workViewer.openObject(
          { kind: "artifact_edit", id: context.artifactId },
          {
            type: "render",
            format: result.format,
            text: result.text,
            edit: {
              artifact_id: context.artifactId,
              task_id: context.taskId,
              base_version_no: context.baseVersionNo,
              base_hash: context.baseHash,
            },
            draft: {
              request_id: result.draft.requestId,
              content_hash: result.draft.contentHash,
              byte_count: String(result.draft.byteCount),
              base_byte_count: String(result.draft.baseByteCount),
              publish_state: result.draft.publishState,
            },
          },
          win,
        );
        const id = viewerWindow.webContents.id;
        viewerEditContexts.set(id, context);
        viewerDrafts.set(id, {
          requestId: result.draft.requestId,
          versionId: result.draft.versionId,
          contentHash: result.draft.contentHash,
          byteCount: result.draft.byteCount,
          baseByteCount: result.draft.baseByteCount,
        });
        viewerWindow.once("closed", () => {
          viewerEditContexts.delete(id);
          viewerDrafts.delete(id);
          viewerClipboard.delete(id);
        });
        return { status: "opened" };
      } catch {
        return { status: "denied" };
      }
    });
    ipcMain.handle("work:edit-local-artifact", async (event, ...args) => {
      if (!senderAllowed(event) || args.length !== 1)
        return { status: "denied" };
      const request = args[0];
      if (
        !request ||
        typeof request !== "object" ||
        Array.isArray(request) ||
        Object.keys(request).sort().join(",") !==
          "artifact_id,base_hash,base_version_id,base_version_no,task_id"
      )
        return { status: "denied" };
      const context = request as LocalArtifactEditContext;
      const uuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      if (
        !uuid.test(context.artifactId) ||
        !uuid.test(context.taskId) ||
        !uuid.test(context.baseVersionId) ||
        !Number.isSafeInteger(context.baseVersionNo) ||
        context.baseVersionNo < 1 ||
        typeof context.baseHash !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(context.baseHash)
      )
        return { status: "denied" };
      if (!workDriver || workDriver.currentState !== "running" || !workViewer) {
        return { status: "not_on_this_device" };
      }
      try {
        const result = await workDriver.editLocalArtifact(context);
        if (result.status !== "available") return result;
        const viewerWindow = workViewer.openObject(
          { kind: "artifact_edit", id: context.artifactId },
          {
            type: "render",
            format: result.format,
            text: result.text,
            edit: {
              artifact_id: context.artifactId,
              task_id: context.taskId,
              base_version_no: context.baseVersionNo,
              base_hash: context.baseHash,
            },
          },
          win,
        );
        const id = viewerWindow.webContents.id;
        viewerEditContexts.set(id, context);
        viewerDrafts.delete(id);
        viewerClipboard.delete(id);
        viewerWindow.once("closed", () => {
          viewerEditContexts.delete(id);
          viewerDrafts.delete(id);
          viewerClipboard.delete(id);
        });
        return { status: "opened" };
      } catch {
        return { status: "denied" };
      }
    });
    ipcMain.handle(
      "work:list-pending-local-approvals",
      async (event, ...args) => {
        if (!senderAllowed(event) || args.length !== 0)
          return { status: "denied", approvals: [] };
        if (!workDriver || workDriver.currentState !== "running") {
          return { status: "not_on_this_device", approvals: [] };
        }
        try {
          return {
            status: "available",
            approvals: await workDriver.listPendingLocalApprovals(),
          };
        } catch {
          return { status: "denied", approvals: [] };
        }
      },
    );
    ipcMain.handle("work:open-local-content", async (event, ...args) => {
      if (!senderAllowed(event) || args.length !== 1) {
        return { status: "denied" };
      }
      const request = args[0];
      if (
        !request ||
        typeof request !== "object" ||
        Array.isArray(request) ||
        Object.keys(request).sort().join(",") !== "id,kind"
      ) {
        return { status: "denied" };
      }
      const { kind, id } = request as Record<string, unknown>;
      if (
        typeof kind !== "string" ||
        ![
          "approval",
          "run_transcript",
          "artifact_version",
          "artifact_edit",
        ].includes(kind) ||
        typeof id !== "string" ||
        id.length === 0 ||
        id.length > 512 ||
        id.includes("\x00")
      ) {
        return { status: "denied" };
      }
      if (!workDriver || workDriver.currentState !== "running" || !workViewer) {
        return { status: "not_on_this_device" };
      }
      try {
        const result = await workDriver.openLocalContent(
          kind as LocalContentKind,
          id,
        );
        if (result.status !== "available") return result;
        const approval =
          kind === "approval"
            ? {
                detail: await workDriver.getLocalApproval(id),
                requestId: randomUUID(),
              }
            : undefined;
        const viewerWindow = workViewer.openObject(
          { kind: kind as LocalContentKind, id },
          {
            type: "render",
            format: result.format,
            text: result.text,
            ...(kind === "artifact_version" ? { export_version_id: id } : {}),
          },
          win,
        );
        if (approval) {
          viewerApprovals.set(viewerWindow.webContents.id, approval);
          viewerWindow.once("closed", () => {
            viewerApprovals.delete(viewerWindow.webContents.id);
          });
          void armApprovalViewer(
            workViewer,
            viewerWindow,
            id,
            approval.requestId,
            approval.detail.readonlyScope !== null,
            approval.detail.destinationFacts,
          );
        }
        return { status: "opened" };
      } catch {
        return { status: "denied" };
      }
    });
    ipcMain.handle(
      "work:accept-local-artifact-version",
      async (event, ...args) => {
        if (!senderAllowed(event) || args.length !== 1)
          return { status: "denied" };
        const request = args[0];
        if (
          !request ||
          typeof request !== "object" ||
          Array.isArray(request) ||
          Object.keys(request).sort().join(",") !==
            "artifactId,contentHash,revision,taskId,versionId"
        ) {
          return { status: "denied" };
        }
        const {
          taskId,
          artifactId,
          versionId,
          contentHash: requestedContentHash,
          revision,
        } = request as Record<string, unknown>;
        // REST artifact versions store the bare digest, while the viewer/driver proof contract
        // uses the canonical sha256: form. Accept the REST read-model shape at this IPC boundary
        // and normalize it before the local body hash check and proof binding.
        const contentHash =
          typeof requestedContentHash === "string" &&
          requestedContentHash.startsWith("sha256:")
            ? requestedContentHash
            : typeof requestedContentHash === "string"
              ? `sha256:${requestedContentHash}`
              : requestedContentHash;
        const uuid =
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
        if (
          typeof taskId !== "string" ||
          !uuid.test(taskId) ||
          typeof artifactId !== "string" ||
          !uuid.test(artifactId) ||
          typeof versionId !== "string" ||
          !uuid.test(versionId) ||
          typeof contentHash !== "string" ||
          !/^(?:sha256:)?[0-9a-f]{64}$/.test(contentHash) ||
          typeof revision !== "number" ||
          !Number.isSafeInteger(revision) ||
          revision < 0
        ) {
          return { status: "denied" };
        }
        if (
          !workDriver ||
          workDriver.currentState !== "running" ||
          !workViewer
        ) {
          return { status: "not_on_this_device" };
        }
        try {
          const content = await workDriver.openLocalContent(
            "artifact_version",
            versionId,
          );
          if (
            content.status !== "available" ||
            content.contentHash !== contentHash
          )
            return { status: "denied" };
          const context: LocalArtifactAcceptanceContext = {
            taskId: taskId as string,
            artifactId: artifactId as string,
            versionId: versionId as string,
            contentHash: contentHash as string,
            revision: revision as number,
          };
          const requestId = randomUUID();
          const viewerWindow = workViewer.openObject(
            { kind: "artifact_version", id: context.versionId },
            { type: "render", format: content.format, text: content.text },
            win,
          );
          const viewerId = viewerWindow.webContents.id;
          viewerAcceptances.set(viewerId, { context, requestId });
          viewerWindow.once("closed", () => viewerAcceptances.delete(viewerId));
          void armArtifactAcceptanceViewer(
            workViewer,
            viewerWindow,
            context,
            requestId,
          );
          return { status: "opened" };
        } catch {
          return { status: "denied" };
        }
      },
    );
    ipcMain.handle("work:grant-workspace", async (event, ...args) => {
      if (!senderAllowed(event) || args.length !== 1) return null;
      const artifactDir = args[0];
      if (
        !Array.isArray(artifactDir) ||
        artifactDir.length > 64 ||
        !artifactDir.every(
          (segment) =>
            typeof segment === "string" &&
            segment.length > 0 &&
            segment.length <= 128 &&
            !segment.includes("/") &&
            !segment.includes("\\") &&
            segment !== "." &&
            segment !== ".." &&
            !segment.includes("\0"),
        )
      ) {
        throw new Error("invalid_work_request");
      }
      if (!workDriver || workDriver.currentState !== "running") {
        throw new Error("work_device_unavailable");
      }
      try {
        const grant = await workDriver.grantWorkspace(artifactDir);
        return grant
          ? {
              grantId: grant.grantId,
              rootIdentityHash: grant.rootIdentityHash,
              artifactDir: [...artifactDir],
            }
          : null;
      } catch (error) {
        if (
          error instanceof WorkApiError &&
          error.code === "work_account_changed"
        ) {
          throw new Error("work_account_changed");
        }
        throw new Error("work_device_unavailable");
      }
    });
    ipcMain.handle("work:list-workspace-grants", async (event, ...args) => {
      if (!senderAllowed(event) || args.length !== 0) return [];
      if (!workDriver || workDriver.currentState !== "running") return [];
      try {
        return await workDriver.listWorkspaceGrants();
      } catch {
        return [];
      }
    });
    ipcMain.handle("work:rebind-run-workspace", async (event, ...args) => {
      if (!senderAllowed(event) || args.length !== 1)
        return { status: "denied" };
      const request = args[0];
      if (
        !request ||
        typeof request !== "object" ||
        Array.isArray(request) ||
        Object.keys(request).sort().join(",") !== "newGrantId,oldGrantId,runId"
      ) {
        return { status: "denied" };
      }
      const { runId, oldGrantId, newGrantId } = request as Record<
        string,
        unknown
      >;
      const uuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      if (
        typeof runId !== "string" ||
        !uuid.test(runId) ||
        typeof oldGrantId !== "string" ||
        !uuid.test(oldGrantId) ||
        typeof newGrantId !== "string" ||
        !uuid.test(newGrantId) ||
        oldGrantId === newGrantId
      ) {
        return { status: "denied" };
      }
      if (!workDriver || workDriver.currentState !== "running") {
        return { status: "not_on_this_device" };
      }
      try {
        const rebound = await workDriver.rebindRunWorkspace(
          runId,
          oldGrantId,
          newGrantId,
        );
        workMainWindow?.webContents.send("work:workspace-rebound", rebound);
        return { status: "accepted", rebound };
      } catch {
        return { status: "denied" };
      }
    });
    if (auth.signedIn) void startWorkDriver();
  }
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
      if (
        app.isPackaged &&
        !app.commandLine.hasSwitch("no-default-protocol-registration")
      )
        app.setAsDefaultProtocolClient("online.we-meet.desktop");
      installViewerProtocol(path.join(__dirname, "viewer"));
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
    void closeRemoteControl("window_closed")
      .then(() => stopWorkDriver())
      .finally(() => app.quit());
  });
}
