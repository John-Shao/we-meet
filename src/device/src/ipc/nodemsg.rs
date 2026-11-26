//! The Node↔Broker closed message set (execution-face design §6.3, families A–D). The shell→Broker
//! channel ([`crate::ipc::schema`]) and this Node channel are two distinct ACL/message sets (DD:20).
//! `run_bootstrap` (family A) lives in [`crate::ipc::nodepipe`]; this module pins the model (B), tool
//! (C) and finish (D) families plus `capability_refresh`. Every body is a CLOSED key set: an extra or
//! missing key is refused, never guessed (DD:20 same discipline as the shell set). Opaque payloads
//! (the canonical `local_model_request` doc, the assistant message, tool args/result content) cross as
//! JSON values; the Broker canonicalizes/hashes them, Node never sees an endpoint URL or a path.
//!
//! Node is untrusted: it names a tool from the four-tool closed set and supplies validated args, but
//! the Broker does every handle-relative execution and permit gate (§6.2/§6.3). The wire convention
//! for u64 members is decimal strings (the rest of the device face).

use serde_json::{json, Value};

/// Family A (Broker→Node, one-time). `run_bootstrap` is in [`crate::ipc::nodepipe`].
pub const CAPABILITY_REFRESH: &str = "capability_refresh";
/// Family B (model, one per turn).
pub const MODEL_REQUEST: &str = "model_request";
pub const MODEL_RESPONSE: &str = "model_response";
pub const MODEL_BLOCKED: &str = "model_blocked";
pub const MODEL_UNKNOWN: &str = "model_unknown";
/// Family C (tool, one per call, sequential).
pub const TOOL_CALL: &str = "tool_call";
pub const TOOL_PERMIT_GATE: &str = "tool_permit_gate";
pub const TOOL_RESULT: &str = "tool_result";
pub const TOOL_BLOCKED: &str = "tool_blocked";
pub const TOOL_UNKNOWN: &str = "tool_unknown";
/// Family D (finish candidate).
pub const LOOP_END: &str = "loop_end";

/// The four tools (DD:179-184). Node may only name these; the Broker executes them handle-relative.
pub const TOOL_NAMES: [&str; 4] = [
    "workspace.list",
    "workspace.read",
    "workspace.search",
    "artifact.write",
];

/// A closed-message refusal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MsgError {
    /// The frame type is not in the Node closed set.
    UnknownType,
    /// The body is not a JSON object.
    NotObject,
    /// A required key is absent.
    MissingKey,
    /// A key outside the closed set is present.
    ExtraKey,
    /// A tool name outside the four-tool closed set.
    UnknownTool,
    /// An enum member outside its closed vocabulary.
    BadEnum,
}

/// The closed top-level key set for each Node message type. `run_bootstrap` is validated in
/// [`crate::ipc::nodepipe`] (its body is built there); every other type is pinned here.
fn closed_keys(frame_type: &str) -> Option<&'static [&'static str]> {
    match frame_type {
        CAPABILITY_REFRESH => Some(&["credential", "generation"]),
        MODEL_REQUEST => Some(&["request", "logical_key"]),
        MODEL_RESPONSE => Some(&[
            "outcome",
            "assistant_message",
            "answer_hash",
            "answer_bytes",
            "usage",
            "provider_request_id",
        ]),
        MODEL_BLOCKED => Some(&["reason", "terminate"]),
        MODEL_UNKNOWN => Some(&["outcome", "reason"]),
        TOOL_CALL => Some(&["tool_call_id", "tool_name", "args", "logical_key"]),
        TOOL_PERMIT_GATE => Some(&["tool_call_id", "decision", "reason", "terminate"]),
        TOOL_RESULT => Some(&[
            "tool_call_id",
            "content",
            "structured_content",
            "details",
            "is_error",
            "terminate",
        ]),
        TOOL_BLOCKED => Some(&["tool_call_id", "reason", "terminate", "is_error"]),
        TOOL_UNKNOWN => Some(&["tool_call_id", "reason"]),
        LOOP_END => Some(&["transcript_final", "turn_count"]),
        _ => None,
    }
}

/// Validate a Node frame body against its closed key set (and the tool/enum vocabularies). This is
/// the shared contract both the Rust service loop and the Node bundle obey; it never coerces a shape.
pub fn validate_body(frame_type: &str, body: &Value) -> Result<(), MsgError> {
    let keys = closed_keys(frame_type).ok_or(MsgError::UnknownType)?;
    let obj = body.as_object().ok_or(MsgError::NotObject)?;
    for key in keys {
        if !obj.contains_key(*key) {
            return Err(MsgError::MissingKey);
        }
    }
    for key in obj.keys() {
        if !keys.contains(&key.as_str()) {
            return Err(MsgError::ExtraKey);
        }
    }
    match frame_type {
        TOOL_CALL => {
            let name = obj["tool_name"].as_str().ok_or(MsgError::UnknownTool)?;
            if !TOOL_NAMES.contains(&name) {
                return Err(MsgError::UnknownTool);
            }
        }
        MODEL_RESPONSE | MODEL_UNKNOWN => {
            let outcome = obj["outcome"].as_str().ok_or(MsgError::BadEnum)?;
            let allowed: &[&str] = if frame_type == MODEL_RESPONSE {
                &["success", "unknown"]
            } else {
                &["unknown"]
            };
            if !allowed.contains(&outcome) {
                return Err(MsgError::BadEnum);
            }
        }
        TOOL_PERMIT_GATE => {
            let decision = obj["decision"].as_str().ok_or(MsgError::BadEnum)?;
            if !["proceed", "blocked"].contains(&decision) {
                return Err(MsgError::BadEnum);
            }
        }
        LOOP_END => {
            let messages = obj["transcript_final"]
                .get("messages")
                .and_then(Value::as_array)
                .ok_or(MsgError::MissingKey)?;
            let turn_count = obj["turn_count"].as_str().ok_or(MsgError::BadEnum)?;
            if turn_count.is_empty()
                || !turn_count.bytes().all(|byte| byte.is_ascii_digit())
                || !messages
                    .iter()
                    .all(|message| message.get("role").and_then(Value::as_str).is_some())
            {
                return Err(MsgError::BadEnum);
            }
        }
        _ => {}
    }
    Ok(())
}

/// Wrap a body into the Node frame envelope `{type, body}` (the same shape `run_bootstrap` uses).
pub fn frame(frame_type: &str, body: Value) -> Value {
    json!({ "type": frame_type, "body": body })
}

/// `model_response` (Broker→Node, §6.3 B). The Broker has already verified `answer_hash`, written the
/// journal completed receipt (usage_source='device_adapter') and checkpoint; Node only adapts the
/// assistant message (content + tool_calls) into pi-agent-core's AssistantMessage.
pub fn model_response(
    assistant_message: Value,
    answer_hash: &str,
    answer_bytes: u64,
    usage: Value,
    provider_request_id: &str,
) -> Value {
    frame(
        MODEL_RESPONSE,
        json!({
            "outcome": "success",
            "assistant_message": assistant_message,
            "answer_hash": answer_hash,
            "answer_bytes": answer_bytes.to_string(),
            "usage": usage,
            "provider_request_id": provider_request_id,
        }),
    )
}

/// `model_unknown` (Broker→Node): the model call's effect is unknown; Node encodes stopReason='error'
/// and the Broker writes an unknown receipt awaiting operation_resolution (§5.3).
pub fn model_unknown(reason: &str) -> Value {
    frame(
        MODEL_UNKNOWN,
        json!({ "outcome": "unknown", "reason": reason }),
    )
}

/// `model_blocked` (Broker→Node): permit CAS failure / pending approval / lease invalidation pauses
/// the loop (beforeToolCall terminate same discipline, DD:43).
pub fn model_blocked(reason: &str, terminate: bool) -> Value {
    frame(
        MODEL_BLOCKED,
        json!({ "reason": reason, "terminate": terminate }),
    )
}

/// `tool_permit_gate` (Broker→Node, §6.3 C): the Broker ran action_prepare→consume_device_permit CAS→
/// journal jti registration (DD:123). `proceed` continues; `blocked` (pending approval) terminates the
/// whole remaining batch (DD:43).
pub fn tool_permit_gate(
    tool_call_id: &str,
    decision: &str,
    reason: Option<&str>,
    terminate: bool,
) -> Value {
    frame(
        TOOL_PERMIT_GATE,
        json!({
            "tool_call_id": tool_call_id,
            "decision": decision,
            "reason": reason,
            "terminate": terminate,
        }),
    )
}

/// `tool_result` (Broker→Node): the AgentToolResult shape (types.d.ts:370) after handle-relative
/// execution + sealed-buffer hash/size verification (DD:190-197/194).
pub fn tool_result(
    tool_call_id: &str,
    content: Value,
    structured_content: Value,
    details: Value,
    is_error: bool,
    terminate: bool,
) -> Value {
    frame(
        TOOL_RESULT,
        json!({
            "tool_call_id": tool_call_id,
            "content": content,
            "structured_content": structured_content,
            "details": details,
            "is_error": is_error,
            "terminate": terminate,
        }),
    )
}

/// `tool_blocked` (Broker→Node): pending_approval / source_changed (DD:186) / workspace_changed
/// (DD:195). The latter two are isError + re-preview, never read new content under an old approval.
pub fn tool_blocked(tool_call_id: &str, reason: &str, terminate: bool, is_error: bool) -> Value {
    frame(
        TOOL_BLOCKED,
        json!({
            "tool_call_id": tool_call_id,
            "reason": reason,
            "terminate": terminate,
            "is_error": is_error,
        }),
    )
}

/// `tool_unknown` (Broker→Node): the tool's side-effect outcome is unknown; Node does not retry
/// (replay:'never'), the Broker writes an unknown receipt awaiting resolution (DD:104).
pub fn tool_unknown(tool_call_id: &str, reason: &str) -> Value {
    frame(
        TOOL_UNKNOWN,
        json!({ "tool_call_id": tool_call_id, "reason": reason }),
    )
}

/// `capability_refresh` (Broker→Node, §6.3 A optional): the device_local endpoint credential swapped
/// as one immutable value; an in-flight call keeps the credential it started with (child-pi.mjs:14-17).
pub fn capability_refresh(credential: Value, generation: u64) -> Value {
    frame(
        CAPABILITY_REFRESH,
        json!({ "credential": credential, "generation": generation.to_string() }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_builder_emits_a_closed_valid_body() {
        let frames = [
            model_response(
                json!({ "content": [], "tool_calls": [] }),
                "sha256:abc",
                12,
                json!({ "input": 0, "output": 0 }),
                "req-1",
            ),
            model_unknown("provider_timeout"),
            model_blocked("pending_approval", true),
            tool_permit_gate("tc-1", "proceed", None, false),
            tool_result(
                "tc-1",
                json!([{ "type": "text", "text": "ok" }]),
                json!({ "written": true }),
                json!({}),
                false,
                false,
            ),
            tool_blocked("tc-1", "source_changed", false, true),
            tool_unknown("tc-1", "io_unknown"),
            capability_refresh(json!({ "token": "t" }), 2),
        ];
        for f in frames {
            let ty = f["type"].as_str().unwrap();
            assert_eq!(validate_body(ty, &f["body"]), Ok(()), "{ty}");
        }
    }

    #[test]
    fn an_extra_key_is_refused() {
        let mut body = model_unknown("x")["body"].clone();
        body["endpoint"] = json!("http://evil");
        assert_eq!(validate_body(MODEL_UNKNOWN, &body), Err(MsgError::ExtraKey));
    }

    #[test]
    fn a_missing_key_is_refused() {
        let mut body =
            tool_result("tc", json!([]), json!({}), json!({}), false, false)["body"].clone();
        body.as_object_mut().unwrap().remove("is_error");
        assert_eq!(validate_body(TOOL_RESULT, &body), Err(MsgError::MissingKey));
    }

    #[test]
    fn a_tool_outside_the_four_closed_set_is_refused() {
        let body = json!({
            "tool_call_id": "tc",
            "tool_name": "shell.exec",
            "args": {},
            "logical_key": "tool:0:0",
        });
        assert_eq!(validate_body(TOOL_CALL, &body), Err(MsgError::UnknownTool));
        for name in TOOL_NAMES {
            let ok = json!({
                "tool_call_id": "tc",
                "tool_name": name,
                "args": {},
                "logical_key": "tool:0:0",
            });
            assert_eq!(validate_body(TOOL_CALL, &ok), Ok(()), "{name}");
        }
    }

    #[test]
    fn an_unknown_frame_type_and_bad_enum_are_refused() {
        assert_eq!(
            validate_body("command", &json!({})),
            Err(MsgError::UnknownType)
        );
        assert_eq!(
            validate_body(MODEL_REQUEST, &json!([])),
            Err(MsgError::NotObject)
        );
        let body = json!({ "outcome": "success", "reason": "x" });
        // model_unknown only admits outcome=unknown.
        assert_eq!(validate_body(MODEL_UNKNOWN, &body), Err(MsgError::BadEnum));
        let gate = json!({ "tool_call_id": "tc", "decision": "maybe", "reason": null, "terminate": false });
        assert_eq!(
            validate_body(TOOL_PERMIT_GATE, &gate),
            Err(MsgError::BadEnum)
        );
    }

    #[test]
    fn model_request_and_loop_end_bodies_are_closed() {
        let req = json!({ "request": { "v": 1 }, "logical_key": "step#0" });
        assert_eq!(validate_body(MODEL_REQUEST, &req), Ok(()));
        let end = json!({ "transcript_final": { "messages": [] }, "turn_count": "3" });
        assert_eq!(validate_body(LOOP_END, &end), Ok(()));
    }
}
