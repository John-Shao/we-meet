import { contextBridge, ipcRenderer } from "electron";
import type {
  RemoteControlBridge,
  RemoteDesktopEvent,
} from "./remote-control/bridge";
import type { ScreenPickerBridge } from "./screen-picker/bridge";
import type {
  LocalArtifactAcceptance,
  PublishedLocalArtifact,
  WorkBridge,
  WorkspaceRebindResult,
} from "./work/bridge";

const remoteControl: RemoteControlBridge = {
  capabilities: (value) =>
    ipcRenderer.invoke("remote-control:capabilities", value),
  showRequest: (value) =>
    ipcRenderer.invoke("remote-control:showRequest", value),
  bindPublishedTrack: (value) =>
    ipcRenderer.invoke("remote-control:bindPublishedTrack", value),
  forwardSignedMessage: (value) =>
    ipcRenderer.invoke("remote-control:forwardSignedMessage", value),
  stop: (value) => ipcRenderer.invoke("remote-control:stop", value),
  onState: (listener) => {
    if (typeof listener !== "function")
      throw new TypeError("Expected a listener");
    const handler = (_event: unknown, value: RemoteDesktopEvent) =>
      listener(value);
    ipcRenderer.on("remote-control:state", handler);
    return () => ipcRenderer.removeListener("remote-control:state", handler);
  },
};

const screenPicker: ScreenPickerBridge = {
  ready: () => ipcRenderer.send("screen-picker:ready"),
  get: () => ipcRenderer.invoke("screen-picker:get"),
  choose: (token) => {
    if (typeof token !== "string") throw new TypeError("Expected a token");
    ipcRenderer.send("screen-picker:choose", token);
  },
  cancel: () => ipcRenderer.send("screen-picker:cancel"),
};

// Minimal, safe surface exposed to the renderer via contextBridge. The web app
// can feature-detect desktop via `window.weMeetDesktop?.isDesktop`. This grows
// as desktop features land (native notifications, tray, deep links, screen
// share picker, auto-update status…), but never exposes raw Node/ipc directly.
const work: WorkBridge = {
  stageLocalInput: (text: string) =>
    ipcRenderer.invoke("work:stage-local-input", text),
  submitLocalTask: (input) =>
    ipcRenderer.invoke("work:submit-local-task", input),
  confirmLocalSubmission: (input) =>
    ipcRenderer.invoke("work:confirm-local-submission", input),
  listPendingLocalApprovals: () =>
    ipcRenderer.invoke("work:list-pending-local-approvals"),
  openLocalContent: (kind, id) =>
    ipcRenderer.invoke("work:open-local-content", { kind, id }),
  editLocalArtifact: (context) =>
    ipcRenderer.invoke("work:edit-local-artifact", context),
  listLocalArtifactDrafts: (taskId, artifactId) =>
    ipcRenderer.invoke("work:list-local-artifact-drafts", {
      taskId,
      artifactId,
    }),
  openLocalArtifactDraft: (taskId, artifactId, versionId) =>
    ipcRenderer.invoke("work:open-local-artifact-draft", {
      taskId,
      artifactId,
      versionId,
    }),
  acceptLocalArtifactVersion: (context) =>
    ipcRenderer.invoke("work:accept-local-artifact-version", context),
  grantWorkspace: (artifactDir) =>
    ipcRenderer.invoke("work:grant-workspace", artifactDir),
  rebindRunWorkspace: (runId, oldGrantId, newGrantId) =>
    ipcRenderer.invoke("work:rebind-run-workspace", {
      runId,
      oldGrantId,
      newGrantId,
    }),
  listWorkspaceGrants: () => ipcRenderer.invoke("work:list-workspace-grants"),
  onArtifactPublished: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      published: PublishedLocalArtifact,
    ) => callback(published);
    ipcRenderer.on("work:artifact-published", listener);
    return () =>
      ipcRenderer.removeListener("work:artifact-published", listener);
  },
  onApprovalDecided: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      decided: { approvalId: string; runId: string },
    ) => callback(decided);
    ipcRenderer.on("work:approval-decided", listener);
    return () => ipcRenderer.removeListener("work:approval-decided", listener);
  },
  onArtifactAccepted: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      accepted: LocalArtifactAcceptance,
    ) => callback(accepted);
    ipcRenderer.on("work:artifact-accepted", listener);
    return () => ipcRenderer.removeListener("work:artifact-accepted", listener);
  },
  onWorkspaceRebound: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      rebound: WorkspaceRebindResult,
    ) => callback(rebound);
    ipcRenderer.on("work:workspace-rebound", listener);
    return () => ipcRenderer.removeListener("work:workspace-rebound", listener);
  },
};

contextBridge.exposeInMainWorld("weMeetDesktop", {
  isDesktop: true,
  platform: process.platform,
  remoteControl,
  screenPicker,
  work,
  aiCall: {
    open: () => ipcRenderer.invoke("ai-call:open"),
    reportStatus: (status: unknown) =>
      ipcRenderer.invoke("ai-call:status", status),
    getPinned: () => ipcRenderer.invoke("ai-call:pinned"),
    setPinned: (pinned: boolean) =>
      ipcRenderer.invoke("ai-call:set-pinned", pinned),
    onStatus: (listener: (status: unknown) => void) => {
      if (typeof listener !== "function")
        throw new TypeError("Expected a listener");
      const handler = (_event: unknown, status: unknown) => listener(status);
      ipcRenderer.on("ai-call:status", handler);
      return () => ipcRenderer.removeListener("ai-call:status", handler);
    },
  },
  shell: {
    openMenu: () => ipcRenderer.invoke("desktop:menu"),
    setTheme: (theme: "light" | "dark") =>
      ipcRenderer.invoke("desktop:titlebar-theme", theme),
    getWindowState: () => ipcRenderer.invoke("desktop:window-state"),
    onWindowState: (listener: (state: { fullscreen: boolean }) => void) => {
      if (typeof listener !== "function")
        throw new TypeError("Expected a listener");
      const handler = (_event: unknown, state: { fullscreen: boolean }) =>
        listener(state);
      ipcRenderer.on("desktop:window-state", handler);
      return () => ipcRenderer.removeListener("desktop:window-state", handler);
    },
  },
  getStatus: () => ipcRenderer.invoke("desktop:status"),
  login: () => ipcRenderer.invoke("desktop:login"),
  logout: () => ipcRenderer.invoke("desktop:logout"),
  retry: () => ipcRenderer.invoke("desktop:retry"),
  onStatus: (listener: (status: unknown) => void) => {
    if (typeof listener !== "function")
      throw new TypeError("Expected a listener");
    const handler = (_event: Electron.IpcRendererEvent, status: unknown) =>
      listener(status);
    ipcRenderer.on("desktop:status", handler);
    return () => ipcRenderer.removeListener("desktop:status", handler);
  },
});
