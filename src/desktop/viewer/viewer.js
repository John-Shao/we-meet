(function () {
  "use strict";
  const content = document.getElementById("content");
  const close = document.getElementById("close");
  const approval = document.getElementById("approval");
  const approve = document.getElementById("approve");
  const reject = document.getElementById("reject");
  const rememberReadonly = document.getElementById("remember-readonly");
  const rememberReadonlyLabel = document.getElementById(
    "remember-readonly-label",
  );
  const approvalDestinationWarning = document.getElementById(
    "approval-destination-warning",
  );
  const artifactAccept = document.getElementById("artifact-accept");
  const acceptArtifact = document.getElementById("accept-artifact");
  const editor = document.getElementById("editor");
  const body = document.getElementById("body");
  const prepare = document.getElementById("prepare");
  const confirm = document.getElementById("confirm");
  const discard = document.getElementById("discard");
  const cancel = document.getElementById("cancel");
  const status = document.getElementById("status");
  const api = globalThis.WorkViewer;
  if (!api || !globalThis.weMeetViewer)
    throw new Error("viewer bridge unavailable");
  let edit = null;
  let draft = null;
  let pendingApproval = null;
  let pendingAcceptance = null;
  let busy = false;

  function setBusy(value) {
    busy = value;
    prepare.disabled = value;
    confirm.disabled = value;
    discard.disabled = value;
    cancel.disabled = value;
    approve.disabled = value;
    reject.disabled = value;
    rememberReadonly.disabled = value;
    acceptArtifact.disabled = value;
  }

  function decideApproval(decision) {
    if (!pendingApproval || busy) return;
    setBusy(true);
    status.textContent = "";
    globalThis.weMeetViewer.send("decideLocalApproval", {
      approval_id: pendingApproval.approval_id,
      request_id: pendingApproval.request_id,
      decision: decision,
      remember_readonly: decision === "approved" && rememberReadonly.checked,
    });
  }

  function acceptArtifactVersion() {
    if (!pendingAcceptance || busy) return;
    setBusy(true);
    status.textContent = "";
    globalThis.weMeetViewer.send("signObjectProof", {
      purpose: "accept",
      artifact_id: pendingAcceptance.artifact_id,
      version_id: pendingAcceptance.version_id,
      content_hash: pendingAcceptance.content_hash,
      request_id: pendingAcceptance.request_id,
    });
  }

  function decide(action) {
    if (!draft || busy) return;
    setBusy(true);
    status.textContent = "";
    globalThis.weMeetViewer.send("confirmLocalWrite", {
      request_id: draft.request_id,
      action: action,
      sealed_hash: draft.content_hash,
    });
  }

  globalThis.weMeetViewer.connect(function (value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (value.type === "render") {
      const message = api.parseMessage(value);
      if (!message) return;
      edit = message.edit ?? null;
      draft = message.draft ?? null;
      pendingApproval = null;
      pendingAcceptance = null;
      approval.hidden = true;
      approvalDestinationWarning.hidden = true;
      artifactAccept.hidden = true;
      rememberReadonlyLabel.hidden = true;
      rememberReadonly.checked = false;
      content.textContent = message.text;
      editor.hidden = !edit;
      content.hidden = !!edit;
      if (edit) {
        body.value = message.text;
        body.readOnly = !!draft;
        prepare.hidden = !!draft;
        confirm.hidden = !draft || draft.publish_state === "expired";
        discard.hidden = !draft;
        cancel.hidden = !draft;
        if (draft) {
          const delta =
            Number(draft.byte_count) - Number(draft.base_byte_count);
          const summary = `字节 ${draft.base_byte_count} → ${draft.byte_count}（${delta >= 0 ? "+" : ""}${delta}）。`;
          status.textContent =
            draft.publish_state === "expired"
              ? `本机草稿已过期，只能丢弃或取消。${summary}`
              : `本机草稿已恢复，等待确认。${summary}`;
        } else {
          status.textContent = "";
        }
      } else {
        status.textContent = "";
      }
      setBusy(false);
      return;
    }
    if (value.type === "artifact_accept") {
      const uuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (
        !uuid.test(value.artifact_id) ||
        !uuid.test(value.version_id) ||
        !/^sha256:[0-9a-f]{64}$/.test(value.content_hash) ||
        typeof value.request_id !== "string"
      )
        return;
      pendingAcceptance = {
        artifact_id: value.artifact_id,
        version_id: value.version_id,
        content_hash: value.content_hash,
        request_id: value.request_id,
      };
      artifactAccept.hidden = false;
      status.textContent = "请核对本机正文与版本哈希后确认采纳。";
      setBusy(false);
      return;
    }
    if (value.type === "artifact_accepted") {
      pendingAcceptance = null;
      artifactAccept.hidden = true;
      status.textContent = "已采纳本机成果。";
      setBusy(false);
      return;
    }
    if (value.type === "approval") {
      const uuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const destinations = value.available_destinations;
      if (
        !uuid.test(value.approval_id) ||
        typeof value.request_id !== "string" ||
        typeof value.local_only_taint !== "boolean" ||
        typeof value.current_action_taints !== "boolean" ||
        !Array.isArray(destinations) ||
        destinations.length > 3 ||
        !destinations.every((item) =>
          ["device_local", "org_private", "org_remote"].includes(item),
        ) ||
        new Set(destinations).size !== destinations.length
      )
        return;
      pendingApproval = {
        approval_id: value.approval_id,
        request_id: value.request_id,
      };
      approval.hidden = false;
      approvalDestinationWarning.hidden = !value.local_only_taint;
      approvalDestinationWarning.textContent = value.local_only_taint
        ? value.current_action_taints
          ? `本操作将读取或产生 local_only 内容；批准后设备外目的地不可用。当前可用目的地：${destinations.join("、") || "(无)"}。`
          : `本 Run 已读取 local_only 内容，设备外目的地不可用。当前可用目的地：${destinations.join("、") || "(无)"}。`
        : "";
      rememberReadonlyLabel.hidden = value.can_remember_readonly !== true;
      rememberReadonly.checked = false;
      status.textContent = "请核对本机正文后作出审批决定。";
      setBusy(false);
      return;
    }
    if (value.type === "approval_decided") {
      pendingApproval = null;
      approval.hidden = true;
      approvalDestinationWarning.hidden = true;
      rememberReadonlyLabel.hidden = true;
      rememberReadonly.checked = false;
      status.textContent =
        value.decision === "approved" ? "已批准。" : "已拒绝。";
      setBusy(false);
      return;
    }
    if (value.type === "draft") {
      if (
        !edit ||
        typeof value.request_id !== "string" ||
        typeof value.version_id !== "string" ||
        typeof value.content_hash !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(value.content_hash) ||
        typeof value.byte_count !== "string"
      )
        return;
      draft = {
        request_id: value.request_id,
        version_id: value.version_id,
        content_hash: value.content_hash,
        byte_count: value.byte_count,
        base_byte_count: value.base_byte_count,
      };
      prepare.hidden = true;
      confirm.hidden = false;
      discard.hidden = false;
      cancel.hidden = false;
      const delta = Number(value.byte_count) - Number(value.base_byte_count);
      status.textContent = `本机草稿已封存，等待确认。字节 ${value.base_byte_count} → ${value.byte_count}（${delta >= 0 ? "+" : ""}${delta}）。`;
      setBusy(false);
      return;
    }
    if (value.type === "published") {
      draft = null;
      status.textContent = "本机版本已发布。";
      prepare.hidden = true;
      confirm.hidden = true;
      discard.hidden = true;
      cancel.hidden = true;
      setBusy(false);
      return;
    }
    if (value.type === "status") {
      status.textContent =
        value.status === "discarded" ? "本机草稿已丢弃。" : "";
      setBusy(false);
      if (value.status === "discarded" || value.status === "pending_confirm")
        globalThis.weMeetViewer.send("close");
      return;
    }
    if (value.type === "error") {
      status.textContent = pendingApproval
        ? "审批提交失败，请关闭后重新打开。"
        : "本机操作失败，请重试。";
      if (pendingApproval) {
        pendingApproval = null;
        approval.hidden = true;
        approvalDestinationWarning.hidden = true;
        rememberReadonlyLabel.hidden = true;
        rememberReadonly.checked = false;
      }
      if (pendingAcceptance) {
        pendingAcceptance = null;
        artifactAccept.hidden = true;
      }
      setBusy(false);
    }
  });
  prepare.addEventListener("click", function () {
    if (!edit || busy) return;
    const text = body.value;
    if (!text || new TextEncoder().encode(text).length > api.MAX_TEXT_BYTES) {
      status.textContent = "正文为空或超过 1 MiB。";
      return;
    }
    setBusy(true);
    status.textContent = "";
    globalThis.weMeetViewer.send("prepareUserArtifactVersion", {
      artifact_id: edit.artifact_id,
      base_version_no: edit.base_version_no,
      base_hash: edit.base_hash,
      format: edit.format,
      body: text,
    });
  });
  confirm.addEventListener("click", function () {
    decide("confirm");
  });
  approve.addEventListener("click", function () {
    decideApproval("approved");
  });
  acceptArtifact.addEventListener("click", acceptArtifactVersion);
  reject.addEventListener("click", function () {
    decideApproval("rejected");
  });
  discard.addEventListener("click", function () {
    decide("discard");
  });
  cancel.addEventListener("click", function () {
    decide("cancel");
  });
  close.addEventListener("click", function () {
    globalThis.weMeetViewer.send("close");
  });
  globalThis.weMeetViewerReady = true;
})();
