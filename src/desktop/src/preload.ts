import { contextBridge, ipcRenderer } from "electron";
import type { RemoteControlBridge, RemoteDesktopEvent } from "./remote-control/bridge";

const remoteControl: RemoteControlBridge = {
  capabilities: value => ipcRenderer.invoke("remote-control:capabilities", value),
  showRequest: value => ipcRenderer.invoke("remote-control:showRequest", value),
  bindPublishedTrack: value => ipcRenderer.invoke("remote-control:bindPublishedTrack", value),
  forwardSignedMessage: value => ipcRenderer.invoke("remote-control:forwardSignedMessage", value),
  stop: value => ipcRenderer.invoke("remote-control:stop", value),
  onState: listener => {
    if (typeof listener !== "function") throw new TypeError("Expected a listener");
    const handler = (_event: unknown, value: RemoteDesktopEvent) => listener(value);
    ipcRenderer.on("remote-control:state", handler);
    return () => ipcRenderer.removeListener("remote-control:state", handler);
  },
};

// Minimal, safe surface exposed to the renderer via contextBridge. The web app
// can feature-detect desktop via `window.weMeetDesktop?.isDesktop`. This grows
// as desktop features land (native notifications, tray, deep links, screen
// share picker, auto-update status…), but never exposes raw Node/ipc directly.
contextBridge.exposeInMainWorld("weMeetDesktop", {
  isDesktop: true,
  platform: process.platform,
  remoteControl,
  aiCall: {
    open: () => ipcRenderer.invoke("ai-call:open"),
    reportStatus: (status: unknown) => ipcRenderer.invoke("ai-call:status", status),
    onStatus: (listener: (status: unknown) => void) => {
      if (typeof listener !== "function") throw new TypeError("Expected a listener");
      const handler = (_event: unknown, status: unknown) => listener(status);
      ipcRenderer.on("ai-call:status", handler);
      return () => ipcRenderer.removeListener("ai-call:status", handler);
    },
  },
  shell: {
    openMenu: () => ipcRenderer.invoke("desktop:menu"),
    setTheme: (theme: "light" | "dark") => ipcRenderer.invoke("desktop:titlebar-theme", theme),
    getWindowState: () => ipcRenderer.invoke("desktop:window-state"),
    onWindowState: (listener: (state: { fullscreen: boolean }) => void) => {
      if (typeof listener !== "function") throw new TypeError("Expected a listener");
      const handler = (_event: unknown, state: { fullscreen: boolean }) => listener(state);
      ipcRenderer.on("desktop:window-state", handler);
      return () => ipcRenderer.removeListener("desktop:window-state", handler);
    },
  },
  getStatus: () => ipcRenderer.invoke("desktop:status"),
  login: () => ipcRenderer.invoke("desktop:login"),
  logout: () => ipcRenderer.invoke("desktop:logout"),
  retry: () => ipcRenderer.invoke("desktop:retry"),
  localWork: {
    status: () => ipcRenderer.invoke("work:status"),
    updateRuntime: () => ipcRenderer.invoke("work:update-runtime"),
    rollbackRuntime: () => ipcRenderer.invoke("work:rollback-runtime"),
    configure: (model: string) => ipcRenderer.invoke("work:configure", model),
    pickWorkspace: () => ipcRenderer.invoke("work:pick-workspace"),
    list: () => ipcRenderer.invoke("work:list"),
    registerRemoteWorkspace: (id: string, enabled: boolean) => ipcRenderer.invoke("work:remote-workspace", id, enabled),
    remoteInbox: () => ipcRenderer.invoke("work:remote-inbox"),
    takeRemote: (id: string, workspaceId: string) => ipcRenderer.invoke("work:take-remote", id, workspaceId),
    submit: (body: unknown) => ipcRenderer.invoke("work:submit", body),
    get: (runId: string) => ipcRenderer.invoke("work:get", runId),
    cancel: (runId: string) => ipcRenderer.invoke("work:cancel", runId),
    resume: (runId: string, workspaceId: string) => ipcRenderer.invoke("work:resume", runId, workspaceId),
    syncFiles: (runId: string, names: string[]) => ipcRenderer.invoke("work:sync-files", runId, names),
    reviewApproval: (runId: string, id: string, sha256: string) => ipcRenderer.invoke("work:review-approval", runId, id, sha256),
    openArtifact: (runId: string, name: string) => ipcRenderer.invoke("work:open-artifact", runId, name),
  },
  onStatus: (listener: (status: unknown) => void) => {
    if (typeof listener !== "function")
      throw new TypeError("Expected a listener");
    const handler = (_event: Electron.IpcRendererEvent, status: unknown) =>
      listener(status);
    ipcRenderer.on("desktop:status", handler);
    return () => ipcRenderer.removeListener("desktop:status", handler);
  },
});
