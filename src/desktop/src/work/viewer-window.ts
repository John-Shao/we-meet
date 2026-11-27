import { randomUUID } from "node:crypto";
import { BrowserWindow, ipcMain } from "electron";
import type { MessagePortMain, WebContents } from "electron";
import {
  allowViewerRequest,
  isViewerSender,
  validateViewerMessage,
  viewerUrl,
  viewerWindowOptions,
  validateViewerPayload,
  type ViewerMethod,
  type ViewerObjectBinding,
} from "./viewer";

export type ViewerMessageHandler = (
  webContents: WebContents,
  method: ViewerMethod,
  payload: unknown,
) => void;

export class ViewerManager {
  private readonly windows = new Set<BrowserWindow>();
  private readonly ports = new Map<number, MessagePortMain>();
  private readonly nonces = new Map<number, string>();
  private readonly handshakeAcks = new Map<number, string>();
  private readonly bindings = new Map<number, ViewerObjectBinding>();
  private readonly requests = new Map<number, Set<string>>();
  private readonly pendingBodies = new Map<number, unknown[]>();
  private readonly renderedText = new Map<number, string>();
  private installed = false;

  constructor(
    private readonly viewerPreloadPath: string,
    private readonly onMessage: ViewerMessageHandler,
  ) {}

  install(): void {
    if (this.installed) return;
    this.installed = true;
    ipcMain.on("work-viewer:message", (event, value: unknown) => {
      if (!this.owns(event.sender) || !isViewerSender(event, event.sender))
        return;
      let method: ViewerMethod;
      try {
        method = validateViewerMessage(value);
      } catch {
        return;
      }
      const payload = (value as Record<string, unknown>).payload;
      const id = event.sender.id;
      if (
        (value as Record<string, unknown>).nonce !== this.nonces.get(id) ||
        !this.nonces.has(id)
      ) {
        return;
      }
      if (method === "close") {
        this.windowFor(event.sender)?.destroy();
        return;
      }
      let validated: Record<string, unknown> | undefined;
      try {
        validated = validateViewerPayload(
          method,
          payload,
          this.bindings.get(id),
          this.requests.get(id) ?? new Set(),
        );
      } catch {
        return;
      }
      const requestId = validated?.request_id;
      if (typeof requestId === "string")
        this.requests.get(id)?.delete(requestId);
      this.onMessage(event.sender, method, validated);
    });
    ipcMain.on("work-viewer:port", (event, handshake: unknown) => {
      if (!this.owns(event.sender) || !isViewerSender(event, event.sender)) {
        for (const port of event.ports) port.close();
        return;
      }
      const port = event.ports[0];
      const nonce =
        handshake && typeof handshake === "object"
          ? (handshake as Record<string, unknown>).nonce
          : undefined;
      if (
        !port ||
        typeof nonce !== "string" ||
        this.ports.has(event.sender.id)
      ) {
        port?.close();
        return;
      }
      this.ports.set(event.sender.id, port);
      this.nonces.set(event.sender.id, nonce);
      this.requests.set(event.sender.id, new Set());
      port.start();
      port.on("message", (messageEvent) => {
        const value = messageEvent.data;
        if (
          value &&
          typeof value === "object" &&
          value.type === "handshake-ack" &&
          value.nonce === this.nonces.get(event.sender.id)
        ) {
          this.handshakeAcks.set(event.sender.id, value.nonce);
          this.flush(event.sender);
        }
      });
      this.rotateHandshake(event.sender);
    });
  }

  open(parent?: BrowserWindow, binding?: ViewerObjectBinding): BrowserWindow {
    const win = new BrowserWindow(
      viewerWindowOptions(this.viewerPreloadPath, parent),
    );
    this.windows.add(win);
    if (binding) this.bindings.set(win.webContents.id, binding);
    this.requests.set(win.webContents.id, new Set());
    win.on("focus", () => this.invalidate(win));
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    win.webContents.on("will-navigate", (event, url) => {
      if (!allowViewerRequest(url)) event.preventDefault();
    });
    win.webContents.session.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !allowViewerRequest(details.url) });
    });
    win.on("closed", () => {
      this.windows.delete(win);
      const id = win.webContents.id;
      this.ports.delete(id);
      this.nonces.delete(id);
      this.handshakeAcks.delete(id);
      this.bindings.delete(id);
      this.requests.delete(id);
      this.pendingBodies.delete(id);
      this.renderedText.delete(id);
    });
    void win.loadURL(viewerUrl());
    return win;
  }

  openObject(
    binding: ViewerObjectBinding,
    body: unknown,
    parent?: BrowserWindow,
  ): BrowserWindow {
    const existing = [...this.windows].find((candidate) => {
      if (candidate.isDestroyed()) return false;
      const current = this.bindings.get(candidate.webContents.id);
      return current?.kind === binding.kind && current.id === binding.id;
    });
    const win = existing ?? this.open(parent, binding);
    if (existing) this.bind(win, binding);
    const pending = this.pendingBodies.get(win.webContents.id) ?? [];
    pending.push(body);
    this.pendingBodies.set(win.webContents.id, pending);
    this.flush(win.webContents);
    if (!win.isDestroyed()) {
      win.show();
      win.focus();
    }
    return win;
  }

  send(win: BrowserWindow, body: unknown): boolean {
    const port = this.ports.get(win.webContents.id);
    if (!port || win.isDestroyed()) return false;
    port.postMessage(body);
    return true;
  }

  renderedArtifactVersion(
    webContents: WebContents,
  ): { versionId: string; text: string } | undefined {
    const binding = this.bindings.get(webContents.id);
    const text = this.renderedText.get(webContents.id);
    return binding?.kind === "artifact_version" && text !== undefined
      ? { versionId: binding.id, text }
      : undefined;
  }

  bind(win: BrowserWindow, binding: ViewerObjectBinding): boolean {
    if (!this.owns(win.webContents)) return false;
    this.bindings.set(win.webContents.id, binding);
    this.pendingBodies.delete(win.webContents.id);
    this.renderedText.delete(win.webContents.id);
    this.invalidate(win);
    return true;
  }

  isReady(win: BrowserWindow): boolean {
    if (!this.owns(win.webContents) || win.isDestroyed()) return false;
    const id = win.webContents.id;
    return (
      this.nonces.has(id) && this.handshakeAcks.get(id) === this.nonces.get(id)
    );
  }

  authorizeRequest(win: BrowserWindow, requestId: string): boolean {
    if (
      !this.isReady(win) ||
      !this.bindings.has(win.webContents.id) ||
      typeof requestId !== "string" ||
      requestId.length === 0 ||
      requestId.length > 512
    ) {
      return false;
    }
    this.requests.get(win.webContents.id)?.add(requestId);
    return true;
  }

  private invalidate(win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    this.requests.get(win.webContents.id)?.clear();
    this.rotateHandshake(win.webContents);
  }

  private rotateHandshake(webContents: WebContents): void {
    if (webContents.isDestroyed()) return;
    const port = this.ports.get(webContents.id);
    if (!port || !this.nonces.has(webContents.id)) return;
    const nonce = randomUUID();
    this.nonces.set(webContents.id, nonce);
    this.handshakeAcks.delete(webContents.id);
    port.postMessage({ type: "handshake", nonce });
  }

  closeAll(): void {
    for (const port of this.ports.values()) port.close();
    for (const win of this.windows) win.destroy();
    this.windows.clear();
    this.ports.clear();
    this.nonces.clear();
    this.handshakeAcks.clear();
    this.bindings.clear();
    this.requests.clear();
    this.pendingBodies.clear();
    this.renderedText.clear();
  }

  private flush(webContents: WebContents): void {
    const win = this.windowFor(webContents);
    if (!win || !this.isReady(win)) return;
    const port = this.ports.get(webContents.id);
    const pending = this.pendingBodies.get(webContents.id);
    if (!port || !pending?.length) return;
    for (const body of pending) port.postMessage(body);
    this.pendingBodies.delete(webContents.id);
    const latest = pending.at(-1);
    if (
      latest &&
      typeof latest === "object" &&
      !Array.isArray(latest) &&
      typeof (latest as Record<string, unknown>).text === "string"
    ) {
      this.renderedText.set(
        webContents.id,
        (latest as Record<string, unknown>).text as string,
      );
    }
  }

  windowFor(webContents: WebContents): BrowserWindow | undefined {
    for (const win of this.windows) {
      if (!win.isDestroyed() && win.webContents === webContents) return win;
    }
    return undefined;
  }

  private owns(webContents: WebContents): boolean {
    return this.windowFor(webContents) !== undefined;
  }
}
