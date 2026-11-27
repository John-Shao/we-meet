import path from "node:path";
import type {
  BrowserWindowConstructorOptions,
  IpcMainInvokeEvent,
  WebContents,
} from "electron";

export const VIEWER_ORIGIN = "wemeet-local://viewer";
export const VIEWER_METHODS = [
  "decideLocalApproval",
  "prepareUserArtifactVersion",
  "copyLocalArtifactVersion",
  "exportArtifactVersion",
  "pasteLocalArtifactText",
  "confirmLocalWrite",
  "confirmDisclosureDecision",
  "signObjectProof",
  "close",
] as const;

export type ViewerMethod = (typeof VIEWER_METHODS)[number];

export type ViewerObjectKind =
  "approval" | "run_transcript" | "artifact_version" | "artifact_edit";

export interface ViewerObjectBinding {
  kind: ViewerObjectKind;
  id: string;
}

function viewerPayload(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("viewer payload must be an object");
  }
  const payload = value as Record<string, unknown>;
  for (const field of Object.keys(payload)) {
    if (!fields.includes(field))
      throw new Error(`unexpected viewer field: ${field}`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(payload, field)) {
      throw new Error(`missing viewer field: ${field}`);
    }
  }
  return payload;
}

function viewerString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`invalid viewer field: ${field}`);
  }
  return value;
}

function viewerRequest(
  payload: Record<string, unknown>,
  authorized: ReadonlySet<string>,
): void {
  const requestId = viewerString(payload, "request_id");
  if (!authorized.has(requestId))
    throw new Error("viewer request is not authorized");
}

export function validateViewerPayload(
  method: ViewerMethod,
  value: unknown,
  binding: ViewerObjectBinding | undefined,
  authorizedRequests: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (method === "close") {
    if (value == null) return undefined;
    viewerPayload(value, []);
    return undefined;
  }
  if (!binding) throw new Error("viewer has no object binding");
  if (method === "decideLocalApproval") {
    if (binding.kind !== "approval")
      throw new Error("viewer object kind mismatch");
    const payload = viewerPayload(value, [
      "approval_id",
      "request_id",
      "decision",
      "remember_readonly",
    ]);
    if (viewerString(payload, "approval_id") !== binding.id) {
      throw new Error("viewer approval mismatch");
    }
    const decision = viewerString(payload, "decision");
    if (decision !== "approved" && decision !== "rejected") {
      throw new Error("invalid approval decision");
    }
    if (typeof payload.remember_readonly !== "boolean" ||
        (payload.remember_readonly && decision !== "approved")) {
      throw new Error("invalid readonly remembrance");
    }
    viewerRequest(payload, authorizedRequests);
    return payload;
  }
  if (method === "prepareUserArtifactVersion") {
    if (binding.kind !== "artifact_edit")
      throw new Error("viewer object kind mismatch");
    const payload = viewerPayload(value, [
      "artifact_id",
      "base_version_no",
      "base_hash",
      "format",
      "body",
    ]);
    if (viewerString(payload, "artifact_id") !== binding.id) {
      throw new Error("viewer artifact mismatch");
    }
    if (
      !Number.isSafeInteger(payload.base_version_no) ||
      Number(payload.base_version_no) < 1
    ) {
      throw new Error("invalid base version");
    }
    viewerString(payload, "base_hash");
    const format = viewerString(payload, "format");
    if (format !== "text/plain" && format !== "text/markdown") {
      throw new Error("invalid artifact format");
    }
    if (
      typeof payload.body !== "string" ||
      new TextEncoder().encode(payload.body).length > 1024 * 1024
    ) {
      throw new Error("invalid artifact body");
    }
    return payload;
  }
  if (method === "copyLocalArtifactVersion") {
    if (binding.kind !== "artifact_version")
      throw new Error("viewer object kind mismatch");
    const payload = viewerPayload(value, ["text"]);
    if (
      typeof payload.text !== "string" ||
      new TextEncoder().encode(payload.text).length > 1024 * 1024
    ) {
      throw new Error("invalid clipboard text");
    }
    return payload;
  }
  if (method === "exportArtifactVersion") {
    if (binding.kind !== "artifact_version")
      throw new Error("viewer object kind mismatch");
    const payload = viewerPayload(value, ["version_id"]);
    if (viewerString(payload, "version_id") !== binding.id) {
      throw new Error("viewer artifact mismatch");
    }
    return payload;
  }
  if (method === "pasteLocalArtifactText") {
    if (binding.kind !== "artifact_edit")
      throw new Error("viewer object kind mismatch");
    viewerPayload(value, []);
    return {};
  }
  if (method === "confirmLocalWrite") {
    if (binding.kind !== "artifact_edit")
      throw new Error("viewer object kind mismatch");
    const payload = viewerPayload(value, [
      "request_id",
      "action",
      "sealed_hash",
    ]);
    const action = viewerString(payload, "action");
    if (action !== "confirm" && action !== "discard" && action !== "cancel") {
      throw new Error("invalid local write action");
    }
    viewerString(payload, "sealed_hash");
    viewerRequest(payload, authorizedRequests);
    return payload;
  }
  if (method === "confirmDisclosureDecision") {
    throw new Error("viewer method unavailable");
  }
  if (binding.kind !== "artifact_version")
    throw new Error("viewer object kind mismatch");
  const payload = viewerPayload(value, [
    "purpose",
    "artifact_id",
    "version_id",
    "content_hash",
    "request_id",
  ]);
  if (viewerString(payload, "purpose") !== "accept") {
    throw new Error("invalid object proof purpose");
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const artifactID = viewerString(payload, "artifact_id");
  const versionID = viewerString(payload, "version_id");
  if (!uuid.test(artifactID) || !uuid.test(versionID) || versionID !== binding.id) {
    throw new Error("viewer artifact mismatch");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(viewerString(payload, "content_hash"))) {
    throw new Error("invalid artifact hash");
  }
  viewerRequest(payload, authorizedRequests);
  return payload;
}

export function viewerUrl(pathname = "index.html"): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(pathname) || pathname.includes("..")) {
    throw new Error("invalid viewer path");
  }
  return `${VIEWER_ORIGIN}/${pathname.replace(/^\/+/, "")}`;
}

export function viewerWindowOptions(
  viewerPreloadPath: string,
  parent?: BrowserWindowConstructorOptions["parent"],
): BrowserWindowConstructorOptions {
  if (
    path.basename(viewerPreloadPath.replace(/\\/g, "/")) !== "viewer-preload.js"
  ) {
    throw new Error("viewer must use its dedicated preload");
  }
  const options = {
    width: 960,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: "本机内容窗口",
    backgroundColor: "#ffffff",
    ...(parent ? { parent } : {}),
    webPreferences: {
      preload: viewerPreloadPath,
      partition: "",
      cache: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: false,
      spellcheck: false,
      webviewTag: false,
      allowRunningInsecureContent: false,
      backgroundThrottling: false,
    },
  };
  return options as BrowserWindowConstructorOptions;
}

export function allowViewerRequest(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "wemeet-local:" &&
      url.hostname === "viewer" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export function validateViewerMessage(value: unknown): ViewerMethod {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("viewer message must be an object");
  }
  const message = value as Record<string, unknown>;
  const method = message.method;
  if (
    typeof method !== "string" ||
    !VIEWER_METHODS.includes(method as ViewerMethod)
  ) {
    throw new Error("unknown viewer method");
  }
  for (const field of ["command", "path", "url"]) {
    if (Object.hasOwn(message, field))
      throw new Error(`forbidden viewer field: ${field}`);
  }
  return method as ViewerMethod;
}

export function isViewerSender(
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  webContents: WebContents,
): boolean {
  return (
    event.sender === webContents &&
    event.senderFrame !== null &&
    event.senderFrame === webContents.mainFrame &&
    allowViewerRequest(event.senderFrame.url)
  );
}
