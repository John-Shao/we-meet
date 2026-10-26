import {
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  screen,
  type DesktopCapturerSource,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type Session,
} from "electron";
import { sameOrigin } from "../policy";
import type { ScreenPickerData } from "./bridge";
import { buildPickerEntries } from "./model";

const THUMBNAIL_SIZE = { width: 480, height: 270 };
const TOKEN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const LOAD_TIMEOUT_MS = 20_000;
const REVEAL_FALLBACK_MS = 2_500;

type Active = {
  window: BrowserWindow;
  sources: Map<string, DesktopCapturerSource>;
  resolve: (source: DesktopCapturerSource | undefined) => void;
  cleanup: () => void;
  generation: number;
  showTimer?: NodeJS.Timeout;
};

/**
 * Feishu-style picker shared by meeting and AI-call screen sharing.
 * The renderer only receives titles, thumbnails and short-lived opaque tokens;
 * the matching capture sources never leave the main process.
 */
export class ScreenPicker {
  private active?: Active;

  constructor(
    private readonly options: {
      rendererOrigin: string;
      preload: string;
      session: Session;
    },
  ) {
    ipcMain.handle("screen-picker:get", (event) => this.get(event));
    ipcMain.on("screen-picker:ready", (event) => this.ready(event));
    ipcMain.on("screen-picker:choose", (event, token) => this.choose(event, token));
    ipcMain.on("screen-picker:cancel", (event) => this.cancel(event));
  }

  async open(options: {
    parent: BrowserWindow;
    isCurrent: () => boolean;
  }): Promise<DesktopCapturerSource | undefined> {
    if (this.active) this.finish(this.active);
    const parent = options.parent;
    if (parent.isDestroyed() || !this.isCurrent(options)) return undefined;
    const picker = this.createWindow(parent);
    if (!picker) return undefined;

    return new Promise<DesktopCapturerSource | undefined>((resolve) => {
      let loadTimer: NodeJS.Timeout | undefined;
      let currentTimer: NodeJS.Timeout | undefined;
      const onParentClosed = () => this.finish(active);
      const cleanup = () => {
        if (loadTimer) clearTimeout(loadTimer);
        if (currentTimer) clearInterval(currentTimer);
        if (active.showTimer) clearTimeout(active.showTimer);
        parent.removeListener("closed", onParentClosed);
      };
      const active: Active = {
        window: picker,
        sources: new Map(),
        resolve,
        cleanup,
        generation: 0,
      };
      this.active = active;

      picker.on("closed", () => this.finish(active));
      picker.webContents.on("render-process-gone", () => this.finish(active));
      picker.webContents.on(
        "did-fail-load",
        (_event, code, _description, _url, isMainFrame) => {
          if (isMainFrame && code !== -3) this.finish(active);
        },
      );
      picker.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      picker.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
      picker.webContents.on("will-navigate", (event, url) => {
        if (!sameOrigin(url, this.options.rendererOrigin))
          event.preventDefault();
      });

      // Stay hidden until the renderer has the first source list: enumerating
      // while visible would put the picker itself in the screen thumbnails.
      loadTimer = setTimeout(() => this.finish(active), LOAD_TIMEOUT_MS);
      picker.webContents.once("did-finish-load", () => {
        if (!loadTimer) return;
        clearTimeout(loadTimer);
        loadTimer = undefined;
        active.showTimer = setTimeout(
          () => this.reveal(active),
          REVEAL_FALLBACK_MS,
        );
      });
      currentTimer = setInterval(() => {
        if (!this.isCurrent(options)) this.finish(active);
      }, 500);
      parent.once("closed", onParentClosed);
      void picker
        .loadURL(`${this.options.rendererOrigin}/share-picker`)
        .catch(() => this.finish(active));
    });
  }

  close() {
    if (this.active) this.finish(this.active);
  }

  private isCurrent(options: { parent: BrowserWindow; isCurrent: () => boolean }) {
    try {
      return !options.parent.isDestroyed() && options.isCurrent();
    } catch {
      return false;
    }
  }

  private createWindow(parent: BrowserWindow) {
    try {
      const area = screen.getDisplayMatching(parent.getBounds()).workArea;
      const width = Math.min(1040, Math.max(720, area.width - 80));
      const height = Math.min(700, Math.max(520, area.height - 80));
      return new BrowserWindow({
        width,
        height,
        x: area.x + Math.round((area.width - width) / 2),
        y: area.y + Math.round((area.height - height) / 2),
        minWidth: 640,
        minHeight: 480,
        show: false,
        parent,
        modal: true,
        skipTaskbar: true,
        title: "选择要共享的屏幕或窗口",
        backgroundColor: "#ffffff",
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        autoHideMenuBar: true,
        alwaysOnTop: parent.isAlwaysOnTop(),
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
          preload: this.options.preload,
          session: this.options.session,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          backgroundThrottling: false,
        },
      });
    } catch {
      return undefined;
    }
  }

  private allowed(
    event: IpcMainEvent | IpcMainInvokeEvent,
    active: Active,
  ): boolean {
    if (active.window.isDestroyed()) return false;
    const frame = event.senderFrame;
    return (
      event.sender === active.window.webContents &&
      !!frame &&
      frame === active.window.webContents.mainFrame &&
      sameOrigin(frame.url, this.options.rendererOrigin)
    );
  }

  private ready(event: IpcMainEvent) {
    const active = this.active;
    if (active && this.allowed(event, active)) this.reveal(active);
  }

  private reveal(active: Active) {
    if (active.showTimer) {
      clearTimeout(active.showTimer);
      active.showTimer = undefined;
    }
    if (this.active !== active || active.window.isDestroyed()) return;
    active.window.show();
    active.window.focus();
  }

  private async get(event: IpcMainInvokeEvent): Promise<ScreenPickerData> {
    const active = this.active;
    if (!active || !this.allowed(event, active))
      throw new Error("invalid_screen_picker_request");
    const generation = ++active.generation;
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: THUMBNAIL_SIZE,
      fetchWindowIcons: true,
    });
    // A newer refresh superseded this enumeration; its token map must win so the
    // renderer can never hold tokens that main has already replaced.
    if (generation !== active.generation)
      throw new Error("screen_picker_stale");
    if (this.active !== active || active.window.isDestroyed())
      throw new Error("screen_picker_closed");
    let excludeId: string;
    try {
      excludeId = active.window.getMediaSourceId();
    } catch {
      throw new Error("screen_picker_closed");
    }
    const entries = buildPickerEntries(sources, screen.getAllDisplays(), {
      excludeId,
    });
    active.sources.clear();
    for (const entry of [...entries.screens, ...entries.windows])
      active.sources.set(entry.item.token, entry.source);
    return {
      screens: entries.screens.map((entry) => entry.item),
      windows: entries.windows.map((entry) => entry.item),
    };
  }

  private choose(event: IpcMainEvent, token: unknown) {
    const active = this.active;
    if (
      !active ||
      !this.allowed(event, active) ||
      typeof token !== "string" ||
      !TOKEN.test(token)
    )
      return;
    const source = active.sources.get(token);
    if (source) this.finish(active, source);
  }

  private cancel(event: IpcMainEvent) {
    const active = this.active;
    if (active && this.allowed(event, active)) this.finish(active);
  }

  private finish(active: Active, source?: DesktopCapturerSource) {
    if (this.active !== active) return;
    this.active = undefined;
    active.cleanup();
    active.resolve(source);
    if (!active.window.isDestroyed()) active.window.destroy();
  }
}
