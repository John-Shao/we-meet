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
} from "node:fs";
import path from "node:path";
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
      "退出将断开本机会议、屏幕共享和音视频采集。正在录音时，请先回到页面停止并保存；云端任务不会因此停止。",
  });
  closing = false;
  if (result.response === 1) {
    quitting = true;
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
  await win.loadURL(rendererOrigin);
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
      if (app.isPackaged)
        app.setAsDefaultProtocolClient("online.we-meet.desktop");
      await createWindow();
      await receiveCallback(
        process.argv.find((arg) => arg.startsWith(CALLBACK)),
      );
    })
    .catch(() => {
      dialog.showErrorBox(
        "We-Meet 启动失败",
        "请检查安装文件是否完整，重新安装后重试。",
      );
      quitting = true;
      app.quit();
    });
  app.on("window-all-closed", () => {
    quitting = true;
    app.quit();
  });
}
