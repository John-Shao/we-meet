import { contextBridge, ipcRenderer } from "electron";
import type { ViewerMethod } from "./work/viewer";

const channel = new MessageChannel();
let handshakeNonce = crypto.randomUUID();
let listener: ((body: unknown) => void) | undefined;
const pending: unknown[] = [];
channel.port1.start();
channel.port1.addEventListener("message", (event) => {
  const value = event.data;
  if (
    value &&
    typeof value === "object" &&
    value.type === "handshake" &&
    typeof value.nonce === "string"
  ) {
    handshakeNonce = value.nonce;
    channel.port1.postMessage({
      type: "handshake-ack",
      nonce: handshakeNonce,
    });
    return;
  }
  if (listener) listener(value);
  else pending.push(value);
});

contextBridge.exposeInMainWorld("weMeetViewer", {
  send(method: ViewerMethod, payload: unknown) {
    ipcRenderer.send("work-viewer:message", {
      method,
      payload,
      nonce: handshakeNonce,
    });
  },
  connect(callback: (body: unknown) => void) {
    listener = callback;
    for (const body of pending.splice(0)) callback(body);
  },
});

ipcRenderer.postMessage("work-viewer:port", { nonce: handshakeNonce }, [
  channel.port2,
]);
