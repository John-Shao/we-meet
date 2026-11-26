(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WorkViewer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const MAX_TEXT_BYTES = 1024 * 1024;

  function parseMessage(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    if (value.type !== "render") return null;
    if (value.format !== "text/plain" && value.format !== "text/markdown")
      return null;
    if (typeof value.text !== "string") return null;
    if (new TextEncoder().encode(value.text).length > MAX_TEXT_BYTES)
      return null;
    const message = { format: value.format, text: value.text };
    if (value.edit !== undefined) {
      const edit = value.edit;
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      if (
        !edit || typeof edit !== "object" || Array.isArray(edit) ||
        Object.keys(edit).sort().join(",") !==
          "artifact_id,base_hash,base_version_no,task_id" ||
        !uuid.test(edit.artifact_id) || !uuid.test(edit.task_id) ||
        !Number.isSafeInteger(edit.base_version_no) || edit.base_version_no < 1 ||
        typeof edit.base_hash !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(edit.base_hash)
      ) return null;
      message.edit = {
        format: value.format,
        artifact_id: edit.artifact_id,
        task_id: edit.task_id,
        base_version_no: edit.base_version_no,
        base_hash: edit.base_hash,
      };
    }
    if (value.draft !== undefined) {
      const draft = value.draft;
      if (
        !draft || typeof draft !== "object" || Array.isArray(draft) ||
        Object.keys(draft).sort().join(",") !==
          "base_byte_count,byte_count,content_hash,publish_state,request_id" ||
        typeof draft.request_id !== "string" ||
        typeof draft.content_hash !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(draft.content_hash) ||
        typeof draft.byte_count !== "string" ||
        !/^[0-9]+$/.test(draft.byte_count) ||
        typeof draft.base_byte_count !== "string" ||
        !/^[0-9]+$/.test(draft.base_byte_count) ||
        !["pending_confirm", "pending_publish", "expired"].includes(draft.publish_state)
      ) return null;
      message.draft = {
        request_id: draft.request_id,
        content_hash: draft.content_hash,
        byte_count: draft.byte_count,
        base_byte_count: draft.base_byte_count,
        publish_state: draft.publish_state,
      };
    }
    return message;
  }

  function render(element, text) {
    element.textContent = String(text);
  }

  function connect(port, element) {
    if (
      !port ||
      typeof port.start !== "function" ||
      typeof port.addEventListener !== "function"
    ) {
      throw new Error("viewer port unavailable");
    }
    port.start();
    port.addEventListener("message", function (event) {
      const message = parseMessage(event.data);
      if (message) render(element, message.text);
    });
  }

  return { MAX_TEXT_BYTES, parseMessage, render, connect };
});
