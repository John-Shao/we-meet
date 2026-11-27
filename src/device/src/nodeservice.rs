//! The workspace execution core (execution-face §6.1/§6.2/§6.3, batch 2 ruling 甲). The long-lived
//! Node service thread owns this: the grant registry ([`crate::grant`]), the endpoint binding
//! ([`crate::endpoint`]), the handle-relative executor ([`crate::tool_exec`]) and the device_local
//! proxy ([`crate::modelproxy`]). It resolves a Run's tool calls and model requests, gating each tool
//! on the permit jti registered through the journal-op channel ([`crate::journalop`]) so the journal
//! stays single-owned by the sync core (E4 甲). Node is untrusted: it names a tool from the closed four
//! and supplies args, but every handle-relative execution and permit decision happens here.
//!
//! The root handles are `!Send` (Windows HANDLE), so this core lives on the thread that opens them and
//! never crosses threads; confirmation requests and dispatched commands arrive as owned (Send) data.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::endpoint::EndpointBinding;
use crate::grant::{GrantRegistry, RootConfirmation};
use crate::ipc::nodemsg;
use crate::journalop::{
    ActionPrepareFacts, ActionRowOwned, CheckpointFacts, JournalHandle, JournalOp, JournalReply,
    ReceiptFacts,
};
use crate::listener::{ListenerIdentity, ListenerRequirement};
use crate::modelproxy::{self, ProxyError};
use crate::tool_exec::{self, ExecError};
use crate::tools::{self, ToolError};

/// The per-Run facts the execution core needs (owned, Send — forwarded from the sync core at start).
#[derive(Clone)]
pub struct RunContext {
    pub run_id: String,
    pub org_id: String,
    pub subject_id: String,
    pub session_id: String,
    pub fence: u64,
    pub generation: u64,
    pub profile_id: String,
    pub journal: JournalHandle,
    /// The execute lease acquired at run_start (the action_prepare names it).
    pub lease_id: String,
    /// The seq=0 checkpoint baseline the offer carried (the first action_prepare prepares against it).
    pub baseline_checkpoint_hash: String,
    /// The offer's grant_set (grant_id → grant_revision); the action_prepare names the grant's revision.
    pub grant_set: Vec<crate::frame::offer::GrantRef>,
    pub prepared_actions: SharedPreparedActions,
    pub io_deadline: Arc<Mutex<Option<std::time::Instant>>>,
}

impl RunContext {
    fn allows_io(&self) -> bool {
        self.io_deadline
            .lock()
            .unwrap()
            .is_some_and(|deadline| std::time::Instant::now() < deadline)
    }
}

/// A dispatched command's facts (the sync core verified its permit + registered its jti "hold for
/// dispatch"; the Node tool loop matches a tool_call's logical_key to one of these). Owned/Send.
#[derive(Clone, Debug)]
pub struct DispatchedCommand {
    pub operation_id: String,
    pub logical_key: String,
    pub tool_name: String,
    pub request_hash: String,
    pub permit_jti: String,
    pub fence: u64,
    pub generation: u64,
    /// The server's uuid dispatch_attempt_id (0048:149): the write receipt + action row echo it so
    /// record_device_receipt's attempt_id equality gate passes. Reads/model carry a local placeholder.
    pub dispatch_attempt_id: String,
    /// Monotonic permit expiry captured when the signed permit was verified. Once request bytes
    /// are sent, the Run lease alone governs the in-flight I/O; before that this deadline is final.
    pub permit_deadline: Option<std::time::Instant>,
}

/// The live per-Run command map (A2 write spine, execution-face §6.3 C). The sync core inserts a
/// command the moment `consume_command` verifies + jti-registers it (mid-Run); the executor reads it
/// per tool_call. This is NOT the journal (E4 甲 single-owner holds): it is a dispatch inbox shared
/// across the two threads, so a write command authorized AFTER start still reaches the running loop.
pub type SharedCommands = Arc<Mutex<HashMap<String, DispatchedCommand>>>;

pub type SharedPreparedActions =
    Arc<Mutex<HashMap<String, crate::frame::action::ActionPreparedBody>>>;

pub fn shared_prepared_actions() -> SharedPreparedActions {
    Arc::new(Mutex::new(HashMap::new()))
}

/// A fresh shared command map seeded with the commands consumed before start.
pub fn shared_commands(initial: Vec<DispatchedCommand>) -> SharedCommands {
    Arc::new(Mutex::new(
        initial
            .into_iter()
            .map(|c| (c.logical_key.clone(), c))
            .collect(),
    ))
}

/// An opaque entry reference returned by workspace.list, mapped back to a verified relative path +
/// identity for workspace.read (DD:181 random entry_ref; the path never crosses to Node).
#[derive(Clone, Debug)]
struct EntryRef {
    grant_id: String,
    relative_path: String,
    file_id: u64,
}

/// The workspace execution core. One thread owns it; the registries hold `!Send` root handles.
pub struct WorkspaceExecutor {
    pub grants: GrantRegistry,
    pub endpoints: EndpointBinding,
    /// entry_ref → verified path/identity (populated by list, consumed by read).
    entries: HashMap<String, EntryRef>,
    /// body_ref → sealed body bytes (the Broker-sealed input/artifact bodies Node only references).
    bodies: HashMap<String, Vec<u8>>,
    /// The local_input_refs staged through `stageLocalInput` (§1.1). The first staged body is
    /// base64url-encoded into run_bootstrap so Node receives the Composer text only through the pipe.
    staged_input_refs: Vec<String>,
    /// Pending root confirmations (token → held handle), bound on prepare, registered/dropped on confirm.
    pending_roots: HashMap<String, tool_exec::RootHandle>,
    /// Pending model confirmations (token → probed identity).
    pending_models: HashMap<String, ListenerIdentity>,
    /// Permit jtis this Run already executed. The command downlink registers the jti at dispatch
    /// (DD:123, synccore consume_command); the tool gate proceeds on that registration but must refuse
    /// a second execution of the same dispatched permit within the Run (replay → already_consumed).
    executed_permits: HashSet<String>,
}

impl Default for WorkspaceExecutor {
    fn default() -> Self {
        Self {
            grants: GrantRegistry::new(),
            endpoints: EndpointBinding::new(),
            entries: HashMap::new(),
            bodies: HashMap::new(),
            staged_input_refs: Vec::new(),
            pending_roots: HashMap::new(),
            pending_models: HashMap::new(),
            executed_permits: HashSet::new(),
        }
    }
}

impl WorkspaceExecutor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Seal a body under a ref (the Broker holds the bytes; Node only names the ref).
    pub fn seal_body(&mut self, body_ref: String, bytes: Vec<u8>) {
        self.bodies.insert(body_ref, bytes);
    }

    /// Stage the Composer目标文本 (§1.1 stageLocalInput): seal the UTF-8 bytes under a fresh
    /// local_input_ref the shell exchanges for the text (which it then clears). Returns the ref plus
    /// the content_hash/byte_count metadata the artifact.write args must match (DD:194 sealed-buffer
    /// hash/size verification). The bytes stay here; only the ref + metadata cross back to the shell.
    pub fn stage_input(&mut self, text: &str) -> (String, String, u64) {
        let bytes = text.as_bytes().to_vec();
        let sealed = crate::tools::SealedBuffer::seal(bytes.clone());
        let input_ref = uuid::Uuid::new_v4().to_string();
        self.bodies.insert(input_ref.clone(), bytes);
        self.staged_input_refs.push(input_ref.clone());
        (input_ref, sealed.hash().to_string(), sealed.len())
    }

    pub fn staged_input_hash(&self, input_ref: &str) -> Option<String> {
        if !self
            .staged_input_refs
            .iter()
            .any(|value| value == input_ref)
        {
            return None;
        }
        self.bodies
            .get(input_ref)
            .map(|bytes| crate::sha256_hex(bytes))
    }

    // ---- confirmation flow (device-side half; the dialog UI is the shell's) ----

    /// Bind a root and produce the confirmation request, holding the handle under a token. The shell
    /// shows the dialog; [`confirm_root`] registers on approve or drops on cancel (no grant).
    pub fn prepare_root(
        &mut self,
        selected_path: &str,
    ) -> Result<(String, RootConfirmation, String), ExecError> {
        let (root, confirmation) =
            crate::grant::prepare_root_confirmation(selected_path).map_err(|e| match e {
                crate::grant::GrantError::Root(err) => err,
                _ => ExecError::Io,
            })?;
        let root_identity_hash = crate::grant::root_identity_hash(&root);
        let token = uuid::Uuid::new_v4().to_string();
        self.pending_roots.insert(token.clone(), root);
        Ok((token, confirmation, root_identity_hash))
    }

    /// Register a confirmed root grant (approve) or drop the held handle (cancel). Returns the
    /// root_identity_hash on approve.
    pub fn confirm_root(
        &mut self,
        token: &str,
        grant_id: &str,
        artifact_dir: Vec<String>,
        approved: bool,
    ) -> Option<String> {
        let root = self.pending_roots.remove(token)?;
        if !approved {
            drop(root); // cancel: close the handle, produce no grant
            return None;
        }
        Some(
            self.grants
                .register(grant_id.to_string(), root, artifact_dir),
        )
    }

    pub fn same_root_identity(
        &self,
        old_grant_id: &str,
        new_grant_id: &str,
    ) -> Result<String, ExecError> {
        let old = self.grants.get(old_grant_id).ok_or(ExecError::NotFound)?;
        let new = self.grants.get(new_grant_id).ok_or(ExecError::NotFound)?;
        if old.root_identity_hash != new.root_identity_hash {
            return Err(ExecError::WorkspaceChanged);
        }
        Ok(old
            .root_identity_hash
            .strip_prefix("sha256:")
            .unwrap_or(&old.root_identity_hash)
            .to_string())
    }

    /// Probe a local model endpoint and produce the confirmation request, holding the identity.
    pub fn prepare_model(
        &mut self,
        port: u16,
    ) -> Result<(String, crate::endpoint::ModelConfirmation), crate::listener::IdentityError> {
        let (identity, confirmation) = crate::endpoint::probe_local_model(port)?;
        let token = uuid::Uuid::new_v4().to_string();
        self.pending_models.insert(token.clone(), identity);
        Ok((token, confirmation))
    }

    /// Record a confirmed endpoint binding (approve) or drop the probed identity (cancel).
    pub fn confirm_model(
        &mut self,
        token: &str,
        profile_id: &str,
        port: u16,
        requirement: ListenerRequirement,
        current_user_sid: Vec<u8>,
        approved: bool,
    ) -> Option<Result<String, crate::listener::IdentityError>> {
        let identity = self.pending_models.remove(token)?;
        if !approved {
            return None;
        }
        Some(self.endpoints.confirm(
            profile_id.to_string(),
            port,
            &identity,
            requirement,
            current_user_sid,
        ))
    }

    // ---- model family (B) ----

    /// Invoke the Run's device_local model endpoint through the §5.4 gate. Returns the model_response
    /// frame on success, model_blocked on an identity/permit refusal, model_unknown on an I/O unknown.
    pub fn invoke_model(
        &self,
        ctx: &RunContext,
        request_doc: &Value,
        permit_deadline: Option<std::time::Instant>,
    ) -> Value {
        if !ctx.allows_io() {
            return nodemsg::model_blocked("lease_expired", true);
        }
        if permit_deadline.is_some_and(|deadline| std::time::Instant::now() >= deadline) {
            return nodemsg::model_blocked("permit_expired", true);
        }
        let entry = match self.endpoints.get(&ctx.profile_id) {
            Some(entry) => entry,
            None => return nodemsg::model_blocked("model_binding_missing", true),
        };
        match modelproxy::invoke(
            &entry.endpoint,
            request_doc,
            &ctx.io_deadline,
            permit_deadline,
        ) {
            Ok(reply) => nodemsg::model_response(
                reply.assistant_message,
                &reply.answer_hash,
                reply.answer_bytes,
                reply.usage,
                &reply.provider_request_id,
            ),
            Err(ProxyError::LeaseExpired) => nodemsg::model_blocked("lease_expired", true),
            Err(ProxyError::PermitExpired) => nodemsg::model_blocked("permit_expired", true),
            Err(ProxyError::Identity(_)) => nodemsg::model_blocked("identity_mismatch", true),
            Err(ProxyError::Connect) | Err(ProxyError::RedirectOrStatus) => {
                nodemsg::model_blocked("model_endpoint_refused", true)
            }
            Err(ProxyError::Io) | Err(ProxyError::BadResponse) => {
                nodemsg::model_unknown("model_io_unknown")
            }
        }
    }

    // ---- tool family (C) ----

    /// Execute a tool call: validate args, resolve the grant, gate on the permit jti (journal-op),
    /// then run the handle-relative executor. Returns the tool_result/tool_blocked/tool_unknown frame.
    /// `cmd` is the dispatched command whose permit authorized this logical_key (None → no permit).
    pub fn execute_tool(
        &mut self,
        ctx: &RunContext,
        tool_name: &str,
        args: &Value,
        tool_call_id: &str,
        cmd: Option<&DispatchedCommand>,
    ) -> Value {
        if !ctx.allows_io() {
            return nodemsg::tool_blocked(tool_call_id, "lease_expired", true, true);
        }
        // A logical-key match locates a command but does not bind its approved arguments.
        if let Some(cmd) = cmd {
            if !command_matches_request(ctx, cmd, tool_name, args) {
                return nodemsg::tool_blocked(tool_call_id, "command_binding_mismatch", true, true);
            }
        }
        // 1. Closed-schema validation (additionalProperties=false, bounds).
        let grant_id = match tools::validate_args(tool_name, args) {
            Ok(id) => id,
            Err(err) => return tool_refusal(tool_call_id, err),
        };
        // 2. The grant must be registered (confirmed root).
        if !self.grants.contains(&grant_id) {
            return nodemsg::tool_blocked(tool_call_id, "grant_missing", true, true);
        }
        // 3. Permit gate: a write needs a dispatched command permit; register its jti (DD:123).
        let is_write = tool_name == tools::ARTIFACT_WRITE;
        if is_write {
            let cmd = match cmd {
                Some(c) => c,
                None => {
                    return nodemsg::tool_blocked(tool_call_id, "pending_approval", true, false)
                }
            };
            match self.register_permit(ctx, cmd, args) {
                PermitGate::Proceed => {}
                PermitGate::Consumed => {
                    return nodemsg::tool_blocked(tool_call_id, "already_consumed", true, true);
                }
                PermitGate::Failed => {
                    return nodemsg::tool_blocked(
                        tool_call_id,
                        "permit_register_failed",
                        true,
                        true,
                    );
                }
            }
        }
        // Journal registration can block past the lease deadline.
        if !ctx.allows_io() {
            return nodemsg::tool_blocked(tool_call_id, "lease_expired", true, true);
        }
        // 4. Handle-relative execution.
        let write_body = if is_write {
            args["body_ref"]
                .as_str()
                .and_then(|body_ref| self.bodies.get(body_ref).cloned())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        match self.run_tool(&grant_id, tool_name, args, &|| ctx.allows_io()) {
            Ok(content) => {
                // DD:137 — a successful artifact.write is a sealed deliverable the Broker itself
                // wrote; record its version so the finish names it in deliverable_versions (judged
                // from the Broker's execution facts, never Node's self-reported list).
                if is_write {
                    if let Some(version_id) = content["version_id"].as_str() {
                        // Batch 4: carry the full publication facts (the sync core builds the
                        // local_publish payload from these). content_hash is the sealed buffer's
                        // `sha256:` form stripped to bare hex (0043:218); logical_name derives from
                        // the args' artifact_id (lead ruling 甲); local_ref = run_id:operation_id
                        // matches the completed receipt's local_result_ref (0043:425).
                        let sealed_hash = content["content_hash"].as_str().unwrap_or("");
                        let bare_hash = sealed_hash
                            .strip_prefix("sha256:")
                            .unwrap_or(sealed_hash)
                            .to_string();
                        let byte_count = content["byte_count"]
                            .as_str()
                            .and_then(|s| s.parse::<u64>().ok())
                            .unwrap_or(0);
                        // is_write already required a dispatched command at the permit gate; bind
                        // it again here (the permit-gate binding went out of scope).
                        let Some(cmd) = cmd else {
                            return nodemsg::tool_blocked(
                                tool_call_id,
                                "pending_approval",
                                true,
                                false,
                            );
                        };
                        let facts = crate::journalop::DeliverableFacts {
                            run_id: ctx.run_id.clone(),
                            operation_id: cmd.operation_id.clone(),
                            version_id: version_id.to_string(),
                            logical_name: args["artifact_id"].as_str().unwrap_or("").to_string(),
                            format: args["format"].as_str().unwrap_or("txt").to_string(),
                            content_hash: bare_hash,
                            byte_count,
                            sealed_blob: write_body,
                            grant_id: args["grant_id"].as_str().unwrap_or("").to_string(),
                            root_identity_hash: self
                                .grants
                                .get(args["grant_id"].as_str().unwrap_or(""))
                                .map(|grant| grant.root_identity_hash.clone())
                                .unwrap_or_default(),
                        };
                        let _ = ctx.journal.request(JournalOp::RecordDeliverable {
                            facts: Box::new(facts),
                        });
                    }
                }
                nodemsg::tool_result(
                    tool_call_id,
                    content.clone(),
                    content,
                    json!({}),
                    false,
                    false,
                )
            }
            Err(err) => exec_refusal(tool_call_id, err),
        }
    }

    /// Register the dispatched command's permit jti through the journal-op channel (single owner).
    /// The command downlink already registered this jti at dispatch (DD:123, synccore consume_command),
    /// so the journal insert here is idempotent: `Registered` (this gate is the first registrar, e.g. a
    /// direct dispatch) and `JtiConsumed` (the downlink registered it) both authorize execution. The
    /// in-Run `executed_permits` set is the replay guard — a second execution of the same dispatched
    /// permit is `Consumed` (already_consumed), never a re-execution.
    fn register_permit(
        &mut self,
        ctx: &RunContext,
        cmd: &DispatchedCommand,
        args: &Value,
    ) -> PermitGate {
        if self.executed_permits.contains(&cmd.permit_jti) {
            return PermitGate::Consumed;
        }
        let plaintext = serde_json::to_vec(args).unwrap_or_default();
        let row = ActionRowOwned {
            org_id: ctx.org_id.clone(),
            operation_id: cmd.operation_id.clone(),
            run_id: ctx.run_id.clone(),
            attempt: cmd.dispatch_attempt_id.clone(),
            step_key: cmd.logical_key.clone(),
            logical_key: cmd.logical_key.clone(),
            supersedes: None,
            request_hash: cmd.request_hash.clone(),
            fence: cmd.fence as i64,
            session_id: ctx.session_id.clone(),
            generation: cmd.generation as i64,
            permit_jti: cmd.permit_jti.clone(),
            state: "started".into(),
            result_hash: None,
            result_ref: None,
        };
        let op = JournalOp::RegisterAction {
            org_id: ctx.org_id.clone(),
            subject_id: ctx.subject_id.clone(),
            row: Box::new(row),
            plaintext,
        };
        match ctx.journal.request(op) {
            Some(JournalReply::Registered) | Some(JournalReply::JtiConsumed) => {
                self.executed_permits.insert(cmd.permit_jti.clone());
                PermitGate::Proceed
            }
            _ => PermitGate::Failed,
        }
    }

    fn register_prepared_action(
        &self,
        ctx: &RunContext,
        prepared: &crate::frame::action::ActionPreparedBody,
    ) -> bool {
        let row = ActionRowOwned {
            org_id: ctx.org_id.clone(),
            operation_id: prepared.operation_id.clone(),
            run_id: ctx.run_id.clone(),
            attempt: prepared.attempt_id.clone(),
            step_key: prepared.step_key.clone(),
            logical_key: prepared.logical_key.clone(),
            supersedes: None,
            request_hash: prepared.request_hash.clone(),
            fence: ctx.fence as i64,
            session_id: ctx.session_id.clone(),
            generation: ctx.generation as i64,
            permit_jti: format!("prepared:{}", prepared.operation_id),
            state: prepared.state.clone(),
            result_hash: None,
            result_ref: None,
        };
        let plaintext = serde_json::to_vec(&prepared.to_value()).unwrap_or_default();
        matches!(
            ctx.journal.request(JournalOp::RegisterAction {
                org_id: ctx.org_id.clone(),
                subject_id: ctx.subject_id.clone(),
                row: Box::new(row),
                plaintext,
            }),
            Some(JournalReply::Registered) | Some(JournalReply::JtiConsumed)
        )
    }

    fn record_prepared_approval(
        &self,
        ctx: &RunContext,
        prepared: &crate::frame::action::ActionPreparedBody,
        action_kind: &str,
        request: &Value,
    ) -> bool {
        let Some(approval_id) = prepared.approval_id.as_deref() else {
            return false;
        };
        if !prepared.needs_approval()
            || approval_id.len() > 512
            || request.to_string().len() > 1024 * 1024
        {
            return false;
        }
        let document = json!({
            "approval_id": approval_id,
            "operation_id": prepared.operation_id,
            "logical_key": prepared.logical_key,
            "step_key": prepared.step_key,
            "state": prepared.state,
            "classification": prepared.classification,
            "destination_id": prepared.destination_id,
            "request_hash": prepared.request_hash,
            "action": {
                "kind": action_kind,
                "request": request,
            },
        });
        let Ok(plaintext) = crate::frame::jcs::canonicalize(&document) else {
            return false;
        };
        let row = crate::journal::local_content::DeliverableRow {
            run_id: ctx.run_id.clone(),
            operation_id: prepared.operation_id.clone(),
            version_id: approval_id.to_string(),
            logical_name: action_kind.to_string(),
            format: "json".into(),
            content_hash: format!("sha256:{}", crate::sha256_hex(&plaintext)),
            byte_count: plaintext.len() as u64,
            receipt_seq: None,
            publish_state: "sealed".into(),
        };
        matches!(
            ctx.journal.request(JournalOp::RecordLocalApproval {
                org_id: ctx.org_id.clone(),
                subject_id: ctx.subject_id.clone(),
                approval_id: approval_id.to_string(),
                row: Box::new(row),
                plaintext,
            }),
            Some(JournalReply::Registered)
        )
    }

    fn record_run_transcript(
        &self,
        ctx: &RunContext,
        transcript_final: &Value,
        turn_count: &str,
    ) -> Result<(), String> {
        let document = json!({
            "run_id": ctx.run_id,
            "turn_count": turn_count,
            "messages": transcript_final["messages"],
        });
        let plaintext = crate::frame::jcs::canonicalize(&document)
            .map_err(|_| "transcript canonicalization failed".to_string())?;
        if plaintext.len() > 1024 * 1024 {
            return Err("transcript exceeds local viewer limit".into());
        }
        let row = crate::journal::local_content::DeliverableRow {
            run_id: ctx.run_id.clone(),
            operation_id: String::new(),
            version_id: ctx.run_id.clone(),
            logical_name: "run_transcript".into(),
            format: "json".into(),
            content_hash: format!("sha256:{}", crate::sha256_hex(&plaintext)),
            byte_count: plaintext.len() as u64,
            receipt_seq: None,
            publish_state: "sealed".into(),
        };
        match ctx.journal.request(JournalOp::RecordLocalTranscript {
            org_id: ctx.org_id.clone(),
            subject_id: ctx.subject_id.clone(),
            run_id: ctx.run_id.clone(),
            row: Box::new(row),
            plaintext,
        }) {
            Some(JournalReply::Registered) => Ok(()),
            _ => Err("transcript persistence failed".into()),
        }
    }

    fn write_user_copy(
        &self,
        grant_ref: &str,
        version_id: &str,
        format: &str,
        bytes: &[u8],
        content_hash: &str,
    ) -> Result<(), ExecError> {
        let reference: Value = serde_json::from_str(grant_ref).map_err(|_| ExecError::NotFound)?;
        let grant_id = reference["grant_id"].as_str().ok_or(ExecError::NotFound)?;
        let expected_root = reference["root_identity_hash"]
            .as_str()
            .ok_or(ExecError::NotFound)?;
        let grant = self.grants.get(grant_id).ok_or(ExecError::NotFound)?;
        if grant.root_identity_hash != expected_root {
            return Err(ExecError::WorkspaceChanged);
        }
        let extension = match format {
            "md" => "md",
            "json" => "json",
            _ => "txt",
        };
        let file_name = format!("{version_id}.{extension}");
        let live = || true;
        let directory = tool_exec::walk(&grant.root, &grant.artifact_dir, true, &live)?;
        let body = crate::tools::SealedBuffer::seal(bytes.to_vec());
        let expected_hash = format!(
            "sha256:{}",
            content_hash.strip_prefix("sha256:").unwrap_or(content_hash)
        );
        match tool_exec::write_artifact_new(
            &directory,
            &file_name,
            &body,
            &expected_hash,
            bytes.len() as u64,
            &live,
        ) {
            Ok(_) => Ok(()),
            Err(ExecError::WorkspaceChanged) => {
                let mut segments = grant.artifact_dir.clone();
                segments.push(file_name);
                let existing = tool_exec::walk(&grant.root, &segments, false, &live)?;
                let sealed = tool_exec::read_sealed(&existing, bytes.len() as u64, &live)?;
                sealed
                    .verify(&expected_hash, bytes.len() as u64)
                    .map_err(|_| ExecError::WorkspaceChanged)
            }
            Err(error) => Err(error),
        }
    }

    /// The handle-relative execution of one validated tool against its confirmed grant.
    fn run_tool(
        &mut self,
        grant_id: &str,
        tool_name: &str,
        args: &Value,
        live: tool_exec::LiveGate<'_>,
    ) -> Result<Value, ExecError> {
        let entry = self.grants.get(grant_id).ok_or(ExecError::NotFound)?;
        let obj = args.as_object().ok_or(ExecError::SpecialFile)?;
        match tool_name {
            tools::WORKSPACE_LIST => {
                let dir = obj["relative_dir"].as_str().unwrap_or("");
                let segments = if dir.is_empty() {
                    Vec::new()
                } else {
                    tools::validate_relative_path(dir).map_err(|_| ExecError::SpecialFile)?
                };
                let chain = tool_exec::walk(&entry.root, &segments, true, live)?;
                let listing = tool_exec::list_dir(&chain, live)?;
                let limit = obj
                    .get("limit")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(tools::LIST_MAX_LIMIT) as usize;
                let mut items = Vec::new();
                for e in listing.iter().take(limit) {
                    let entry_ref = uuid::Uuid::new_v4().to_string();
                    let rel = if segments.is_empty() {
                        e.name.clone()
                    } else {
                        format!("{}/{}", segments.join("/"), e.name)
                    };
                    self.entries.insert(
                        entry_ref.clone(),
                        EntryRef {
                            grant_id: grant_id.to_string(),
                            relative_path: rel,
                            file_id: e.file_id,
                        },
                    );
                    items.push(json!({
                        "entry_ref": entry_ref,
                        "name": e.name,
                        "type": if e.is_dir { "dir" } else { "file" },
                        "size": e.size.to_string(),
                        "is_reparse": e.is_reparse,
                    }));
                }
                Ok(json!({ "entries": items, "incomplete": listing.len() > limit }))
            }
            tools::WORKSPACE_READ => {
                let entry_ref = obj["entry_ref"].as_str().unwrap_or("");
                let mapped = self
                    .entries
                    .get(entry_ref)
                    .ok_or(ExecError::NotFound)?
                    .clone();
                let expected_identity = obj["expected_identity"].as_str().unwrap_or("");
                let max_bytes = obj
                    .get("max_bytes")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(tools::READ_MAX_BYTES);
                let grant = self
                    .grants
                    .get(&mapped.grant_id)
                    .ok_or(ExecError::NotFound)?;
                let segments = tools::validate_relative_path(&mapped.relative_path)
                    .map_err(|_| ExecError::SpecialFile)?;
                let chain = tool_exec::walk(&grant.root, &segments, false, live)?;
                // expected_identity binds the file ID Node was given at list time; the opened object
                // must still be that same object (a swap since list is source_changed, never new bytes).
                let listed_id = mapped.file_id.to_string();
                if !expected_identity.is_empty() && expected_identity != listed_id {
                    return Err(ExecError::SourceChanged);
                }
                if chain.identity.file_id != mapped.file_id {
                    return Err(ExecError::SourceChanged);
                }
                let sealed = tool_exec::read_sealed(&chain, max_bytes, live)?;
                let text = String::from_utf8_lossy(sealed.bytes()).into_owned();
                Ok(json!({
                    "content": [{ "type": "text", "text": text }],
                    "content_hash": sealed.hash(),
                    "byte_count": sealed.len().to_string(),
                }))
            }
            tools::WORKSPACE_SEARCH => {
                let dir = obj["relative_dir"].as_str().unwrap_or("");
                let segments = if dir.is_empty() {
                    Vec::new()
                } else {
                    tools::validate_relative_path(dir).map_err(|_| ExecError::SpecialFile)?
                };
                let query = obj["literal_query"].as_str().unwrap_or("");
                let limit = obj
                    .get("limit")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(100);
                let result = tool_exec::search(&entry.root, &segments, query, limit, live)?;
                let hits: Vec<Value> = result
                    .hits
                    .iter()
                    .map(|h| {
                        json!({
                            "relative_path": h.relative_path,
                            "line": h.line.to_string(),
                            "excerpt": h.excerpt,
                            "buffer_hash": h.buffer_hash,
                        })
                    })
                    .collect();
                Ok(json!({
                    "hits": hits,
                    "incomplete": result.incomplete,
                    "reason": result.reason,
                    "files_scanned": result.files_scanned.to_string(),
                    "bytes_scanned": result.bytes_scanned.to_string(),
                }))
            }
            tools::ARTIFACT_WRITE => {
                let body_ref = obj["body_ref"].as_str().unwrap_or("");
                let bytes = self
                    .bodies
                    .get(body_ref)
                    .ok_or(ExecError::NotFound)?
                    .clone();
                let sealed = crate::tools::SealedBuffer::seal(bytes);
                let content_hash = obj["content_hash"].as_str().unwrap_or("");
                let byte_count = obj
                    .get("byte_count")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(0);
                let version_id = obj["version_id"].as_str().unwrap_or("");
                let format = obj["format"].as_str().unwrap_or("txt");
                let file_name = format!("{version_id}.{format}");
                // The artifact dir is the grant's confirmed output directory; verify all ancestors.
                let dir_chain = tool_exec::walk(&entry.root, &entry.artifact_dir, true, live)?;
                let id = tool_exec::write_artifact_new(
                    &dir_chain,
                    &file_name,
                    &sealed,
                    content_hash,
                    byte_count,
                    live,
                )?;
                Ok(json!({
                    "written": true,
                    "version_id": version_id,
                    "content_hash": sealed.hash(),
                    "byte_count": id.size.to_string(),
                }))
            }
            _ => Err(ExecError::SpecialFile),
        }
    }
}

// Match action_prepare's SHA256(JCS(args)); a canonicalization failure cannot bind substitute bytes.
fn tool_request_hash(args: &Value) -> Option<String> {
    crate::frame::jcs::canonicalize(args)
        .ok()
        .map(|bytes| crate::sha256_hex(&bytes))
}

fn command_matches_request(
    ctx: &RunContext,
    cmd: &DispatchedCommand,
    tool_name: &str,
    args: &Value,
) -> bool {
    let tool_schema = match tool_name {
        tools::ARTIFACT_WRITE => "write-v1",
        tools::WORKSPACE_READ => "read-v1",
        tools::WORKSPACE_SEARCH => "search-v1",
        tools::WORKSPACE_LIST => "list-v1",
        _ => return false,
    };
    cmd.tool_name == tool_schema
        && cmd.fence == ctx.fence
        && cmd.generation == ctx.generation
        && tool_request_hash(args).as_deref() == Some(cmd.request_hash.as_str())
}

enum PermitGate {
    Proceed,
    Consumed,
    Failed,
}

fn tool_refusal(tool_call_id: &str, err: ToolError) -> Value {
    let reason = match err {
        ToolError::Schema => "schema",
        ToolError::BadPath => "bad_path",
        ToolError::Bound => "bound_exceeded",
        ToolError::BadFormat => "bad_format",
    };
    nodemsg::tool_blocked(tool_call_id, reason, false, true)
}

fn exec_refusal(tool_call_id: &str, err: ExecError) -> Value {
    let (reason, is_error) = match err {
        ExecError::SourceChanged => ("source_changed", true),
        ExecError::WorkspaceChanged => ("workspace_changed", true),
        ExecError::Hardlink => ("hardlink_refused", true),
        ExecError::Reparse => ("reparse_refused", true),
        ExecError::VolumeMismatch => ("volume_mismatch", true),
        ExecError::Bound => ("bound_exceeded", true),
        ExecError::NotFound => ("not_found", true),
        ExecError::SpecialFile => ("special_file", true),
        // One cause, one string: the pre-execution gate above and a chunk-boundary expiry share it.
        ExecError::LeaseExpired => ("lease_expired", true),
        _ => ("io_unknown", true),
    };
    nodemsg::tool_blocked(tool_call_id, reason, false, is_error)
}

type RootPreparation = Result<(String, RootConfirmation, String, String, String), String>;

/// A request to the long-lived Node service thread. Confirmations and body sealing carry owned (Send)
/// data; the `!Send` root handles stay on the thread. `StartRun` brings up one Run's pipe loop.
pub enum NodeRequest {
    PrepareRoot {
        selected_path: String,
        reply: tokio::sync::oneshot::Sender<RootPreparation>,
    },
    ConfirmRoot {
        token: String,
        grant_id: String,
        artifact_dir: Vec<String>,
        approved: bool,
        reply: tokio::sync::oneshot::Sender<Option<String>>,
    },
    PrepareModel {
        port: u16,
        reply: tokio::sync::oneshot::Sender<
            Result<(String, crate::endpoint::ModelConfirmation), String>,
        >,
    },
    ConfirmModel {
        token: String,
        profile_id: String,
        port: u16,
        requirement: ListenerRequirement,
        current_user_sid: Vec<u8>,
        approved: bool,
        reply: tokio::sync::oneshot::Sender<Option<Result<String, String>>>,
    },
    /// Return the common bare-hex root identity for a same-root grant succession.
    GrantRootIdentity {
        old_grant_id: String,
        new_grant_id: String,
        reply: tokio::sync::oneshot::Sender<Result<(String, String), String>>,
    },
    ListWorkspaceGrants {
        reply: tokio::sync::oneshot::Sender<Vec<Value>>,
    },
    SealBody {
        body_ref: String,
        bytes: Vec<u8>,
    },
    /// §1.1 stageLocalInput: seal the Composer text, return (local_input_ref, content_hash, byte_count).
    StageInput {
        text: String,
        reply: tokio::sync::oneshot::Sender<(String, String, u64)>,
    },
    ValidateLocalSubmission {
        input_ref: String,
        input_hash: String,
        selected_grant_ids: Vec<String>,
        reply: tokio::sync::oneshot::Sender<Result<(String, String, String, String), String>>,
    },
    /// Install the sync core's single-owner journal handle for viewer reads between Runs.
    SetJournal {
        journal: crate::journalop::JournalHandle,
        org_id: String,
        subject_id: String,
        device_id: String,
    },
    SetLocalSession {
        session_id: String,
    },
    OpenLocalContent {
        kind: String,
        id: String,
        reply:
            tokio::sync::oneshot::Sender<Option<crate::journal::local_content::LocalContentBody>>,
    },
    PrepareLocalApprovalDecision {
        input: Box<crate::approvaldecision::ApprovalDecisionInput>,
        reply: tokio::sync::oneshot::Sender<Option<Value>>,
    },
    PrepareLocalAcceptance {
        input: Box<crate::possession::PossessionInput>,
        reply: tokio::sync::oneshot::Sender<Option<Value>>,
    },
    PrepareLocalDraft {
        row: crate::journal::local_content::LocalDraftRow,
        body: String,
        reply: tokio::sync::oneshot::Sender<
            Result<crate::journal::local_content::LocalDraftRow, String>,
        >,
    },
    ListLocalDrafts {
        artifact_id: String,
        task_id: String,
        reply: tokio::sync::oneshot::Sender<Vec<crate::journalop::LocalDraftRow>>,
    },
    DecideLocalDraft {
        request_id: String,
        sealed_hash: String,
        action: String,
        reply: tokio::sync::oneshot::Sender<Option<crate::journal::local_content::LocalDraftRow>>,
    },
    ConfirmLocalDraft {
        request_id: String,
        sealed_hash: String,
        reply: tokio::sync::oneshot::Sender<
            Option<crate::journal::local_content::LocalDraftConfirmation>,
        >,
    },
    CompleteLocalDraft {
        request_id: String,
        sealed_hash: String,
        publish_ack: String,
        reply: tokio::sync::oneshot::Sender<bool>,
    },
    StartRun {
        ctx: RunContext,
        bootstrap: Box<crate::ipc::nodepipe::RunBootstrap>,
        pipe_handle: isize,
        container_sid: Vec<u8>,
        sidecar_pid: u32,
        commands: SharedCommands,
        reply: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    Shutdown,
}

/// Spawn the long-lived Node service thread (execution-face §6.1 ruling 甲). It owns the workspace
/// execution core (registries + executor + proxy) for the device's lifetime, processes confirmation
/// requests between Runs, and runs each Run's Node pipe loop to completion. The journal stays owned by
/// the sync core; journal ops go through the per-Run [`JournalHandle`]. Returns the request sender.
pub fn spawn_node_service() -> tokio::sync::mpsc::Sender<NodeRequest> {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<NodeRequest>(64);
    std::thread::spawn(move || {
        let mut exec = WorkspaceExecutor::new();
        let mut journal: Option<(
            crate::journalop::JournalHandle,
            String,
            String,
            String,
            Option<String>,
        )> = None;
        while let Some(req) = rx.blocking_recv() {
            match req {
                NodeRequest::PrepareRoot {
                    selected_path,
                    reply,
                } => {
                    let r = exec
                        .prepare_root(&selected_path)
                        .map_err(|e| format!("{e:?}"));
                    let r = r.and_then(|(token, confirmation, root_identity_hash)| {
                        let (_, _, _, device_id, session_id) =
                            journal.as_ref().ok_or_else(|| "no_session".to_string())?;
                        let session_id =
                            session_id.clone().ok_or_else(|| "no_session".to_string())?;
                        Ok((
                            token,
                            confirmation,
                            root_identity_hash,
                            device_id.clone(),
                            session_id,
                        ))
                    });
                    let _ = reply.send(r);
                }
                NodeRequest::ConfirmRoot {
                    token,
                    grant_id,
                    artifact_dir,
                    approved,
                    reply,
                } => {
                    let r = exec.confirm_root(&token, &grant_id, artifact_dir, approved);
                    let _ = reply.send(r);
                }
                NodeRequest::PrepareModel { port, reply } => {
                    let r = exec.prepare_model(port).map_err(|e| format!("{e:?}"));
                    let _ = reply.send(r);
                }
                NodeRequest::ConfirmModel {
                    token,
                    profile_id,
                    port,
                    requirement,
                    current_user_sid,
                    approved,
                    reply,
                } => {
                    let r = exec
                        .confirm_model(
                            &token,
                            &profile_id,
                            port,
                            requirement,
                            current_user_sid,
                            approved,
                        )
                        .map(|res| res.map_err(|e| format!("{e:?}")));
                    let _ = reply.send(r);
                }
                NodeRequest::GrantRootIdentity {
                    old_grant_id,
                    new_grant_id,
                    reply,
                } => {
                    let r = match journal
                        .as_ref()
                        .and_then(|(_, _, _, _, session)| session.clone())
                    {
                        Some(session_id) => exec
                            .same_root_identity(&old_grant_id, &new_grant_id)
                            .map(|root| (root, session_id))
                            .map_err(|e| format!("{e:?}")),
                        None => Err("no_session".to_string()),
                    };
                    let _ = reply.send(r);
                }
                NodeRequest::ListWorkspaceGrants { reply } => {
                    let grants = exec
                        .grants
                        .list()
                        .into_iter()
                        .map(|(grant_id, root_identity_hash, artifact_dir)| {
                            serde_json::json!({
                                "grant_id": grant_id,
                                "root_identity_hash": root_identity_hash,
                                "artifact_dir": artifact_dir,
                            })
                        })
                        .collect();
                    let _ = reply.send(grants);
                }
                NodeRequest::SealBody { body_ref, bytes } => exec.seal_body(body_ref, bytes),
                NodeRequest::StageInput { text, reply } => {
                    let _ = reply.send(exec.stage_input(&text));
                }
                NodeRequest::ValidateLocalSubmission {
                    input_ref,
                    input_hash,
                    selected_grant_ids,
                    reply,
                } => {
                    let result = match &journal {
                        Some((_, org_id, subject_id, device_id, Some(session_id))) => {
                            if exec.staged_input_hash(&input_ref).as_deref() != Some(&input_hash) {
                                Err("input_mismatch".to_string())
                            } else if !selected_grant_ids
                                .iter()
                                .all(|grant_id| exec.grants.contains(grant_id))
                            {
                                Err("grant_unavailable".to_string())
                            } else {
                                Ok((
                                    org_id.clone(),
                                    subject_id.clone(),
                                    device_id.clone(),
                                    session_id.clone(),
                                ))
                            }
                        }
                        _ => Err("no_session".to_string()),
                    };
                    let _ = reply.send(result);
                }
                NodeRequest::SetJournal {
                    journal: handle,
                    org_id,
                    subject_id,
                    device_id,
                } => journal = Some((handle, org_id, subject_id, device_id, None)),
                NodeRequest::SetLocalSession { session_id } => {
                    if let Some((_, _, _, _, session)) = &mut journal {
                        *session = Some(session_id);
                    }
                }
                NodeRequest::OpenLocalContent { kind, id, reply } => {
                    let content = match (&journal, kind.as_str()) {
                        (Some((handle, org_id, subject_id, _, _)), "artifact_version") => {
                            match handle.request(crate::journalop::JournalOp::ReadLocalContent {
                                org_id: org_id.clone(),
                                subject_id: subject_id.clone(),
                                version_id: id,
                            }) {
                                Some(crate::journalop::JournalReply::LocalContent(Ok(body))) => {
                                    body
                                }
                                _ => None,
                            }
                        }
                        (Some((handle, org_id, subject_id, _, _)), "approval") => {
                            match handle.request(crate::journalop::JournalOp::ReadLocalApproval {
                                org_id: org_id.clone(),
                                subject_id: subject_id.clone(),
                                approval_id: id,
                            }) {
                                Some(crate::journalop::JournalReply::LocalApproval(Ok(body))) => {
                                    body
                                }
                                _ => None,
                            }
                        }
                        (Some((handle, org_id, subject_id, _, _)), "run_transcript") => {
                            match handle.request(crate::journalop::JournalOp::ReadLocalTranscript {
                                org_id: org_id.clone(),
                                subject_id: subject_id.clone(),
                                run_id: id,
                            }) {
                                Some(crate::journalop::JournalReply::LocalTranscript(Ok(body))) => {
                                    body
                                }
                                _ => None,
                            }
                        }
                        (Some((handle, org_id, subject_id, _, _)), "artifact_edit") => {
                            match handle.request(crate::journalop::JournalOp::ReadLocalDraft {
                                org_id: org_id.clone(),
                                subject_id: subject_id.clone(),
                                version_id: id,
                            }) {
                                Some(crate::journalop::JournalReply::LocalDraft(Ok(body))) => body
                                    .map(|body| crate::journal::local_content::LocalContentBody {
                                        row: crate::journal::local_content::DeliverableRow {
                                            run_id: String::new(),
                                            operation_id: String::new(),
                                            version_id: body.row.version_id,
                                            logical_name: body.row.artifact_id,
                                            format: body.row.format,
                                            content_hash: body.row.content_hash,
                                            byte_count: body.row.byte_count,
                                            receipt_seq: None,
                                            publish_state: body.row.publish_state,
                                        },
                                        bytes: body.bytes,
                                    }),
                                _ => None,
                            }
                        }
                        _ => None,
                    };
                    let _ = reply.send(content);
                }
                NodeRequest::PrepareLocalApprovalDecision { input, reply } => {
                    let proof = match &journal {
                        Some((handle, org_id, subject_id, device_id, Some(session_id))) => {
                            match handle.request(
                                crate::journalop::JournalOp::PrepareLocalApprovalDecision {
                                    org_id: org_id.clone(),
                                    subject_id: subject_id.clone(),
                                    device_id: device_id.clone(),
                                    session_id: session_id.clone(),
                                    input,
                                },
                            ) {
                                Some(crate::journalop::JournalReply::LocalApprovalDecision(
                                    Ok(proof),
                                )) => proof,
                                _ => None,
                            }
                        }
                        _ => None,
                    };
                    let _ = reply.send(proof);
                }
                NodeRequest::PrepareLocalAcceptance { input, reply } => {
                    let proof = match &journal {
                        Some((handle, org_id, subject_id, device_id, Some(session_id))) => {
                            match handle.request(
                                crate::journalop::JournalOp::PrepareLocalAcceptance {
                                    org_id: org_id.clone(),
                                    subject_id: subject_id.clone(),
                                    device_id: device_id.clone(),
                                    session_id: session_id.clone(),
                                    input,
                                },
                            ) {
                                Some(crate::journalop::JournalReply::LocalAcceptance(Ok(
                                    proof,
                                ))) => proof,
                                _ => None,
                            }
                        }
                        _ => None,
                    };
                    let _ = reply.send(proof);
                }
                NodeRequest::PrepareLocalDraft { row, body, reply } => {
                    let result = match &journal {
                        Some((handle, org_id, subject_id, _, _)) => {
                            match handle.request(crate::journalop::JournalOp::PrepareLocalDraft {
                                org_id: org_id.clone(),
                                subject_id: subject_id.clone(),
                                row: Box::new(row),
                                plaintext: body.into_bytes(),
                            }) {
                                Some(crate::journalop::JournalReply::LocalDraftPrepared(Ok(
                                    body,
                                ))) => Ok(body.row),
                                Some(crate::journalop::JournalReply::LocalDraftPrepared(Err(
                                    _,
                                ))) => Err("invalid_work_request".into()),
                                _ => Err("work_device_unavailable".into()),
                            }
                        }
                        None => Err("work_device_unavailable".into()),
                    };
                    let _ = reply.send(result);
                }
                NodeRequest::ListLocalDrafts {
                    artifact_id,
                    task_id,
                    reply,
                } => {
                    let drafts = match &journal {
                        Some((handle, org_id, subject_id, _, _)) => {
                            match handle.request(crate::journalop::JournalOp::ListLocalDrafts {
                                org_id: org_id.clone(),
                                subject_id: subject_id.clone(),
                                artifact_id,
                                task_id,
                            }) {
                                Some(crate::journalop::JournalReply::LocalDrafts(Ok(drafts))) => {
                                    drafts
                                }
                                _ => Vec::new(),
                            }
                        }
                        None => Vec::new(),
                    };
                    let _ = reply.send(drafts);
                }
                NodeRequest::DecideLocalDraft {
                    request_id,
                    sealed_hash,
                    action,
                    reply,
                } => {
                    let result = match &journal {
                        Some((handle, org_id, subject_id, _, _)) => {
                            match handle.request(crate::journalop::JournalOp::DecideLocalDraft {
                                org_id: org_id.clone(),
                                subject_id: subject_id.clone(),
                                request_id,
                                sealed_hash,
                                action,
                            }) {
                                Some(crate::journalop::JournalReply::LocalDraftDecided(Ok(
                                    row,
                                ))) => row,
                                _ => None,
                            }
                        }
                        None => None,
                    };
                    let _ = reply.send(result);
                }
                NodeRequest::ConfirmLocalDraft {
                    request_id,
                    sealed_hash,
                    reply,
                } => {
                    let result = match &journal {
                        Some((handle, org_id, subject_id, device_id, Some(session_id))) => {
                            match handle.request(crate::journalop::JournalOp::ConfirmLocalDraft {
                                org_id: org_id.clone(),
                                subject_id: subject_id.clone(),
                                request_id,
                                sealed_hash,
                                device_id: device_id.clone(),
                                session_id: session_id.clone(),
                            }) {
                                Some(crate::journalop::JournalReply::LocalDraftConfirmed(Ok(
                                    confirmed,
                                ))) => confirmed,
                                _ => None,
                            }
                        }
                        _ => None,
                    };
                    let _ = reply.send(result);
                }
                NodeRequest::CompleteLocalDraft {
                    request_id,
                    sealed_hash,
                    publish_ack,
                    reply,
                } => {
                    let mut result = false;
                    if let Some((handle, org_id, subject_id, _, _)) = &journal {
                        if let Some(crate::journalop::JournalReply::LocalDraftCompleted(Ok(
                            Some(copy),
                        ))) = handle.request(crate::journalop::JournalOp::CompleteLocalDraft {
                            org_id: org_id.clone(),
                            subject_id: subject_id.clone(),
                            request_id: request_id.clone(),
                            sealed_hash: sealed_hash.clone(),
                            publish_ack,
                        }) {
                            let state = if copy.grant_ref.as_ref().is_some_and(|grant_ref| {
                                exec.write_user_copy(
                                    grant_ref,
                                    &copy.body.row.version_id,
                                    &copy.body.row.format,
                                    &copy.body.bytes,
                                    &copy.body.row.content_hash,
                                )
                                .is_ok()
                            }) {
                                "written"
                            } else {
                                "pending"
                            };
                            let _ = handle.request(
                                crate::journalop::JournalOp::SetLocalDraftCopyState {
                                    org_id: org_id.clone(),
                                    subject_id: subject_id.clone(),
                                    request_id,
                                    sealed_hash,
                                    state: state.to_string(),
                                },
                            );
                            result = true;
                        }
                    }
                    let _ = reply.send(result);
                }
                NodeRequest::StartRun {
                    ctx,
                    bootstrap,
                    pipe_handle,
                    container_sid,
                    sidecar_pid,
                    commands,
                    reply,
                } => {
                    if let Some((_, _, _, _, session)) = &mut journal {
                        *session = Some(ctx.session_id.clone());
                    }
                    // Carry the staged Composer body through the ACL'd Node pipe as bounded base64url.
                    // Node never receives a path, journal handle or direct memory reference (DD:194).
                    let mut bootstrap = bootstrap;
                    bootstrap.sealed_input_b64 = exec
                        .staged_input_refs
                        .first()
                        .and_then(|input_ref| exec.bodies.get(input_ref))
                        .map(|bytes| crate::b64::encode(bytes));
                    let r = serve_run(
                        &mut exec,
                        &ctx,
                        &bootstrap,
                        pipe_handle,
                        &container_sid,
                        sidecar_pid,
                        &commands,
                    );
                    if let Err(err) = &r {
                        eprintln!("work-device: serve_run failed: {err}");
                    }
                    let _ = reply.send(r);
                }
                NodeRequest::Shutdown => break,
            }
        }
    });
    tx
}

/// Run one Run's Node↔Broker pipe loop: create the ACL'd pipe, accept the spawned sidecar (PID/SID/
/// session predicates), handshake, send bootstrap, then dispatch model_request→proxy, tool_call→permit
/// gate→executor, until loop_end. Every Node frame is validated against the closed message set first.
fn serve_run(
    exec: &mut WorkspaceExecutor,
    ctx: &RunContext,
    bootstrap: &crate::ipc::nodepipe::RunBootstrap,
    pipe_handle: isize,
    container_sid: &[u8],
    sidecar_pid: u32,
    commands: &SharedCommands,
) -> Result<(), String> {
    use crate::ipc::nodepipe::NodePipeServer;
    // The pipe was created by the spawn while the sidecar was suspended; rebuild the server around
    // that handle (ownership transfers here; its Drop closes the handle at Run end).
    let server = unsafe {
        NodePipeServer::from_raw_handle(
            windows::Win32::Foundation::HANDLE(pipe_handle as *mut std::ffi::c_void),
            container_sid,
            sidecar_pid,
        )
    }
    .map_err(|e| format!("node pipe rebuild: {e:?}"))?;
    // Production verifies the sidecar's PID/AppContainer-SID/login-session; the lib test drives an
    // in-process mock client through the identity seam (the gate is proven by the interop + nodepipe).
    #[cfg(not(test))]
    let conn = server
        .accept()
        .map_err(|e| format!("node pipe accept: {e:?}"))?;
    #[cfg(test)]
    let conn = server
        .accept_unverified()
        .map_err(|e| format!("node pipe accept: {e:?}"))?;
    conn.handshake_node()
        .map_err(|e| format!("node handshake: {e:?}"))?;
    conn.send_bootstrap(bootstrap)
        .map_err(|e| format!("bootstrap: {e:?}"))?;

    // A3 uplink production (E5 甲): the Run-local checkpoint sequence advances once per recorded
    // operation. The live owner is THIS loop — each model turn / tool call produces a signed receipt
    // (+ checkpoint) through the journal-op channel, so the sync core stays the sole journal owner.
    // The latest checkpoint hash is retained so a write action_prepare names the current baseline
    // (0054 compares checkpoint_seq/hash against the server's latest device_checkpoint).
    let mut checkpoint_seq: i64 = 0;
    let mut latest_checkpoint_hash = ctx.baseline_checkpoint_hash.clone();
    loop {
        let raw = conn.read_frame().map_err(|e| format!("node read: {e:?}"))?;
        if !ctx.allows_io() {
            return Err("node lease expired".into());
        }
        let value: Value =
            serde_json::from_slice(&raw).map_err(|e| format!("node frame json: {e}"))?;
        let ty = value["type"].as_str().ok_or("node frame missing type")?;
        let body = &value["body"];
        nodemsg::validate_body(ty, body).map_err(|e| format!("node body {ty}: {e:?}"))?;
        let reply = match ty {
            nodemsg::MODEL_REQUEST => {
                let logical_key = body["logical_key"].as_str().unwrap_or("");
                let command = propose_and_await_model_command(
                    ctx,
                    bootstrap,
                    exec,
                    &body["request"],
                    logical_key,
                    checkpoint_seq,
                    &latest_checkpoint_hash,
                    commands,
                );
                let reply = if let Some(cmd) = command.as_ref() {
                    match exec.register_permit(ctx, cmd, &body["request"]) {
                        PermitGate::Proceed => {
                            let reply =
                                exec.invoke_model(ctx, &body["request"], cmd.permit_deadline);
                            if !produce_model_receipt(
                                ctx,
                                bootstrap,
                                &body["request"],
                                Some(cmd),
                                logical_key,
                                &reply,
                                &mut checkpoint_seq,
                                &mut latest_checkpoint_hash,
                            ) {
                                return Err("model_result persistence failed".into());
                            }
                            reply
                        }
                        PermitGate::Consumed => nodemsg::model_blocked("already_consumed", true),
                        PermitGate::Failed => nodemsg::model_blocked("permit_unavailable", true),
                    }
                } else {
                    let reply = nodemsg::model_blocked("permit_pending", true);
                    produce_model_receipt(
                        ctx,
                        bootstrap,
                        &body["request"],
                        None,
                        logical_key,
                        &reply,
                        &mut checkpoint_seq,
                        &mut latest_checkpoint_hash,
                    );
                    reply
                };
                reply
            }
            nodemsg::TOOL_CALL => {
                let tool_name = body["tool_name"].as_str().unwrap_or("");
                let tool_call_id = body["tool_call_id"].as_str().unwrap_or("");
                let logical_key = body["logical_key"].as_str().unwrap_or("");
                let args = &body["args"];
                // The live command map carries commands consumed before start AND mid-Run. A write
                // tool_call's server logical_key is the sidecar step_key + "#0" (0054 forces the
                // supersede suffix); reads need no command.
                let server_key = format!("{logical_key}#0");
                let mut cmd = commands.lock().unwrap().get(&server_key).cloned();
                if cmd.is_none() && tool_name == tools::ARTIFACT_WRITE {
                    // A2 write spine (§6.3 C): propose the action, then await the server's command
                    // downlink (consume_command feeds the live map). A timeout / pending approval
                    // leaves cmd=None → execute_tool returns tool_blocked pending_approval.
                    cmd = propose_and_await_command(
                        ctx,
                        bootstrap,
                        exec,
                        tool_name,
                        args,
                        logical_key,
                        &server_key,
                        checkpoint_seq,
                        &latest_checkpoint_hash,
                        commands,
                        COMMAND_WAIT,
                    );
                }
                let reply = exec.execute_tool(ctx, tool_name, args, tool_call_id, cmd.as_ref());
                produce_tool_receipt(
                    ctx,
                    bootstrap,
                    cmd.as_ref(),
                    tool_name,
                    args,
                    logical_key,
                    &reply,
                    &mut checkpoint_seq,
                    &mut latest_checkpoint_hash,
                );
                reply
            }
            nodemsg::LOOP_END => {
                exec.record_run_transcript(
                    ctx,
                    &body["transcript_final"],
                    body["turn_count"].as_str().unwrap_or(""),
                )?;
                break;
            }
            // capability_refresh is Broker→Node; any other Node→Broker type is a protocol violation.
            other => return Err(format!("unexpected Node frame type {other}")),
        };
        let bytes = serde_json::to_vec(&reply).map_err(|e| format!("reply encode: {e}"))?;
        conn.write_frame(&bytes)
            .map_err(|e| format!("node write: {e:?}"))?;
    }
    Ok(())
}

/// How long the executor waits for a command downlink after proposing action_prepare. The server
/// parks an ask_each action (write or model) for approval; the shell decides it through the REST
/// face and the next heartbeat claim dispatches the command. The Approval's pending TTL is the
/// policy's 10-minute window (control-design §1.4/§7.2; 0082 mints
/// LEAST(now()+10min, grant.expires_at)), and a decision may land at the last second, so the wait
/// spans the whole window plus one 10s heartbeat cadence and a margin. A shorter wait would end
/// the batch while the Operation is still pending, and the command minted after the decision would
/// reach a sidecar that no longer reads it (no resume path re-drives an ended batch).
const COMMAND_WAIT: std::time::Duration = std::time::Duration::from_secs(660);

/// A2 write spine (execution-face §6.3 C): propose one action_prepare through the sync core (which
/// holds the key + uplink), then await the matching command in the live per-Run map. The server's
/// prepare→permit→command round-trip feeds the map via `consume_command`. Returns the dispatched
/// command on success, or None on a refusal/timeout (the caller maps None to pending_approval).
#[allow(clippy::too_many_arguments)]
fn propose_and_await_command(
    ctx: &RunContext,
    bootstrap: &crate::ipc::nodepipe::RunBootstrap,
    exec: &WorkspaceExecutor,
    tool_name: &str,
    args: &Value,
    step_key: &str,
    server_key: &str,
    checkpoint_seq: i64,
    latest_checkpoint_hash: &str,
    commands: &SharedCommands,
    wait: std::time::Duration,
) -> Option<DispatchedCommand> {
    if !ctx.allows_io() {
        return None;
    }
    let grant_id = match tools::validate_args(tool_name, args) {
        Ok(g) => g,
        Err(err) => {
            eprintln!("work-device: propose validate_args refused {tool_name}: {err:?}");
            return None;
        }
    };
    if !exec.grants.contains(&grant_id) {
        eprintln!("work-device: propose grant {grant_id} not in registry");
        return None;
    }
    let grant_revision = ctx
        .grant_set
        .iter()
        .find(|g| g.grant_id == grant_id)
        .map(|g| g.grant_revision)
        .unwrap_or(1);
    // The device proposes the request/resource hashes from the validated args (bare sha256-hex, the
    // command request_hash shape); the server stores them verbatim on the ask_each write path.
    let args_hash = tool_request_hash(args)?;
    let tool_schema = match tool_name {
        tools::ARTIFACT_WRITE => "write-v1",
        tools::WORKSPACE_READ => "read-v1",
        tools::WORKSPACE_SEARCH => "search-v1",
        _ => "list-v1",
    };
    let facts = ActionPrepareFacts {
        run_id: ctx.run_id.clone(),
        lease_id: ctx.lease_id.clone(),
        fence: ctx.fence,
        step_key: step_key.to_string(),
        logical_key: server_key.to_string(),
        checkpoint_seq: checkpoint_seq.max(0) as u64,
        checkpoint_hash: latest_checkpoint_hash.to_string(),
        request_hash: args_hash.clone(),
        action_kind: tool_name.to_string(),
        tool_schema: tool_schema.to_string(),
        local_payload_ref: format!("local/{step_key}"),
        grant_id,
        grant_revision,
        resource_selector_hash: args_hash.clone(),
        // The strictest claim always satisfies the grant classification floor (0054); the server
        // stores the grant's own classification as the authority.
        classification: "local_only".to_string(),
        destination_id: None,
        byte_upper_bound: bootstrap.max_bytes,
        token_upper_bound: bootstrap.max_tokens,
    };
    let op = JournalOp::ProposeAction {
        org_id: ctx.org_id.clone(),
        subject_id: ctx.subject_id.clone(),
        facts: Box::new(facts),
    };
    if !matches!(ctx.journal.request(op), Some(JournalReply::Proposed)) {
        eprintln!("work-device: action_prepare proposal failed for {server_key}");
        return None;
    }
    let deadline = std::time::Instant::now() + wait;
    let mut approval_recorded = false;
    while std::time::Instant::now() < deadline && ctx.allows_io() {
        if !approval_recorded {
            if let Some(prepared) = ctx
                .prepared_actions
                .lock()
                .unwrap()
                .get(server_key)
                .cloned()
            {
                if prepared.logical_key == server_key && prepared.request_hash == args_hash {
                    let _ = exec.register_prepared_action(ctx, &prepared);
                    approval_recorded = exec.record_prepared_approval(
                        ctx,
                        &prepared,
                        tool_name,
                        &json!({ "args": args }),
                    );
                }
            }
        }
        if let Some(cmd) = commands.lock().unwrap().get(server_key).cloned() {
            return Some(cmd);
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn propose_and_await_model_command(
    ctx: &RunContext,
    bootstrap: &crate::ipc::nodepipe::RunBootstrap,
    exec: &WorkspaceExecutor,
    request_doc: &Value,
    logical_key: &str,
    checkpoint_seq: i64,
    latest_checkpoint_hash: &str,
    commands: &SharedCommands,
) -> Option<DispatchedCommand> {
    if !ctx.allows_io() {
        return None;
    }
    let grant = ctx.grant_set.first()?;
    if bootstrap.probe.is_none() && !exec.grants.contains(&grant.grant_id) {
        return None;
    }
    let request_hash = model_request_hash_for_bootstrap(request_doc, bootstrap);
    let server_key = format!("{logical_key}#0");
    let facts = ActionPrepareFacts {
        run_id: ctx.run_id.clone(),
        lease_id: ctx.lease_id.clone(),
        fence: ctx.fence,
        step_key: logical_key.to_string(),
        logical_key: server_key.clone(),
        checkpoint_seq: checkpoint_seq.max(0) as u64,
        checkpoint_hash: latest_checkpoint_hash.to_string(),
        request_hash: request_hash.clone(),
        action_kind: "model.send_device_local".into(),
        tool_schema: "model-v1".into(),
        local_payload_ref: format!("local/{logical_key}"),
        grant_id: grant.grant_id.clone(),
        grant_revision: grant.grant_revision,
        resource_selector_hash: request_hash.clone(),
        classification: "local_only".into(),
        destination_id: Some("device_local".into()),
        byte_upper_bound: bootstrap.max_bytes,
        token_upper_bound: bootstrap.max_tokens,
    };
    if !matches!(
        ctx.journal.request(JournalOp::ProposeAction {
            org_id: ctx.org_id.clone(),
            subject_id: ctx.subject_id.clone(),
            facts: Box::new(facts),
        }),
        Some(JournalReply::Proposed)
    ) {
        return None;
    }
    let deadline = std::time::Instant::now() + COMMAND_WAIT;
    let mut approval_recorded = false;
    while std::time::Instant::now() < deadline && ctx.allows_io() {
        if !approval_recorded {
            if let Some(prepared) = ctx
                .prepared_actions
                .lock()
                .unwrap()
                .get(&server_key)
                .cloned()
            {
                if prepared.logical_key == server_key && prepared.request_hash == request_hash {
                    let _ = exec.register_prepared_action(ctx, &prepared);
                    approval_recorded = exec.record_prepared_approval(
                        ctx,
                        &prepared,
                        "model.send_device_local",
                        request_doc,
                    );
                }
            }
        }
        if let Some(cmd) = commands.lock().unwrap().get(&server_key).cloned() {
            if cmd.logical_key == server_key
                && cmd.tool_name == "model-v1"
                && cmd.request_hash == request_hash
            {
                return Some(cmd);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    None
}

/// The independent signing kind for the `local_model_request` v1 canonical hash (§5.1, DD:239). The
/// covered bytes are `kind|JCS(doc)` (the pairing/renewal covered-string precedent), so the model
/// request hash never shares a domain with the R0a `model_request` or the pair/renew domains.
const MODEL_REQUEST_KIND: &str = "work-device-local-model-request-v1";

/// `sha256:hex` over the JCS-canonical document (the answer/result hash form, §5.2).
fn canonical_hash(value: &Value) -> String {
    let bytes = crate::frame::jcs::canonicalize(value).unwrap_or_default();
    format!("sha256:{}", crate::sha256_hex(&bytes))
}

fn model_request_hash_for_bootstrap(
    doc: &Value,
    bootstrap: &crate::ipc::nodepipe::RunBootstrap,
) -> String {
    if let Some(probe) = &bootstrap.probe {
        return probe.preview_hash.clone();
    }
    model_request_hash(doc)
        .strip_prefix("sha256:")
        .unwrap_or_default()
        .to_string()
}

fn model_request_hash(doc: &Value) -> String {
    let canonical = crate::frame::jcs::canonicalize(doc).unwrap_or_default();
    let mut covered = MODEL_REQUEST_KIND.as_bytes().to_vec();
    covered.push(b'|');
    covered.extend_from_slice(&canonical);
    format!("sha256:{}", crate::sha256_hex(&covered))
}

/// Record one operation: produce its signed receipt through the journal-op channel, then a checkpoint
/// covering it (DD:133 the checkpoint precedes prepare/finish). The sync core allocates the receipt
/// seq, signs and uplinks; this loop only supplies the execution facts. A failed production is logged
/// and skips the checkpoint (the receipt is the durable uplink fact; the checkpoint follows it).
fn record_operation(
    ctx: &RunContext,
    bootstrap: &crate::ipc::nodepipe::RunBootstrap,
    facts: ReceiptFacts,
    logical_key: &str,
    checkpoint_seq: &mut i64,
    latest_checkpoint_hash: &mut String,
) {
    let operation_id = facts.operation_id.clone();
    let state = facts.state.clone();
    let op = JournalOp::AppendReceipt {
        org_id: ctx.org_id.clone(),
        subject_id: ctx.subject_id.clone(),
        facts: Box::new(facts),
    };
    let receipt_seq = match ctx.journal.request(op) {
        Some(JournalReply::ReceiptProduced { seq, .. }) => seq,
        other => {
            eprintln!("work-device: receipt production failed for {operation_id}: {other:?}");
            return;
        }
    };
    *checkpoint_seq += 1;
    let snapshot = json!({
        "run_id": ctx.run_id,
        "checkpoint_seq": *checkpoint_seq,
        "operation_id": operation_id,
        "logical_key": logical_key,
        "state": state,
    });
    let plaintext = crate::frame::jcs::canonicalize(&snapshot).unwrap_or_default();
    // The server's checkpoint_hash / action_prepare checkpoint_hash gates require BARE 64-hex
    // (0050:144, 0054), unlike the sealed-buffer content_hash which carries the sha256: prefix.
    let checkpoint_hash = crate::sha256_hex(&plaintext);
    *latest_checkpoint_hash = checkpoint_hash.clone();
    let pending_set = json!([operation_id]);
    // pending_operation_set_hash is also a bare-hex server gate (0050:148), not the sha256: form.
    let pending_operation_set_hash =
        crate::sha256_hex(&crate::frame::jcs::canonicalize(&pending_set).unwrap_or_default());
    let cp = JournalOp::PersistCheckpoint {
        org_id: ctx.org_id.clone(),
        subject_id: ctx.subject_id.clone(),
        facts: Box::new(CheckpointFacts {
            run_id: ctx.run_id.clone(),
            checkpoint_seq: *checkpoint_seq,
            schema_version: crate::journal::schema::SCHEMA_VERSION,
            runtime_digest: bootstrap.runtime_digest.clone(),
            checkpoint_hash,
            pending_operation_set_hash,
            prior_receipt_ref: Some(receipt_seq.to_string()),
            binding_revision: bootstrap.binding_revision,
            fence: ctx.fence,
            local_checkpoint_ref: format!("{}:{}", ctx.run_id, *checkpoint_seq),
        }),
        plaintext,
    };
    if !matches!(
        ctx.journal.request(cp),
        Some(JournalReply::CheckpointProduced)
    ) {
        eprintln!("work-device: checkpoint production failed for {operation_id}");
    }
}

/// Record a device_local model turn as a LOCAL journal fact (批2-7 主签单选乙; DD:264「无 gateway
/// receipt」). The turn's outcome + `device_adapter` usage are sealed into the run checkpoint
/// plaintext (local-only); the uplinked commit carries only hashes. It does NOT allocate a gateway
/// receipt seq nor uplink `record_device_receipt`: the server's `device_adapter` metering is deferred
/// to I5 (0042:296 / 0021:58, which widen operation_usage_fact + operation_resolution together), so a
/// model receipt sent to the action-receipt gate (0048) is refused `invalid_request` and would burn
/// the contiguous seq window the tool write receipt needs (`receipt_seq_out_of_window`). The gateway
/// receipt seq window therefore carries ACTION receipts only; the model turn still advances the run
/// checkpoint (DD:133 checkpoint precedes prepare) at the current gateway receipt watermark.
fn record_model_turn(
    ctx: &RunContext,
    bootstrap: &crate::ipc::nodepipe::RunBootstrap,
    facts: ReceiptFacts,
    logical_key: &str,
    checkpoint_seq: &mut i64,
    latest_checkpoint_hash: &mut String,
) {
    *checkpoint_seq += 1;
    let snapshot = json!({
        "run_id": ctx.run_id,
        "checkpoint_seq": *checkpoint_seq,
        "operation_id": facts.operation_id,
        "logical_key": logical_key,
        "state": facts.state,
        "outcome": facts.outcome,
        "result_hash": facts.result_hash,
        "request_hash": facts.request_hash,
        "usage": facts.usage,
        "usage_source": facts.usage_source,
        "error_code": facts.error_code,
    });
    let plaintext = crate::frame::jcs::canonicalize(&snapshot).unwrap_or_default();
    // The server checkpoint gate requires BARE 64-hex (0050:144/148), not the sha256: form.
    let checkpoint_hash = crate::sha256_hex(&plaintext);
    *latest_checkpoint_hash = checkpoint_hash.clone();
    let pending_set = json!([facts.operation_id]);
    let pending_operation_set_hash =
        crate::sha256_hex(&crate::frame::jcs::canonicalize(&pending_set).unwrap_or_default());
    let cp = JournalOp::PersistCheckpoint {
        org_id: ctx.org_id.clone(),
        subject_id: ctx.subject_id.clone(),
        facts: Box::new(CheckpointFacts {
            run_id: ctx.run_id.clone(),
            checkpoint_seq: *checkpoint_seq,
            schema_version: crate::journal::schema::SCHEMA_VERSION,
            runtime_digest: bootstrap.runtime_digest.clone(),
            checkpoint_hash,
            pending_operation_set_hash,
            prior_receipt_ref: None,
            binding_revision: bootstrap.binding_revision,
            fence: ctx.fence,
            local_checkpoint_ref: format!("{}:{}", ctx.run_id, *checkpoint_seq),
        }),
        plaintext,
    };
    if !matches!(
        ctx.journal.request(cp),
        Some(JournalReply::CheckpointProduced)
    ) {
        eprintln!("work-device: model turn checkpoint production failed for {logical_key}");
    }
}

fn model_usage(value: Option<&Value>, max_tokens: u64) -> crate::frame::model_result::ModelUsage {
    let value = value.unwrap_or(&Value::Null);
    let token = |keys: &[&str]| {
        keys.iter().find_map(|key| {
            value.get(*key).and_then(Value::as_u64).or_else(|| {
                value
                    .get(*key)
                    .and_then(Value::as_str)
                    .and_then(|v| v.parse().ok())
            })
        })
    };
    let input = token(&["input_tokens", "prompt_tokens"]);
    let output = token(&["output_tokens", "completion_tokens"]);
    let cached = token(&["cached_input_tokens", "cached_tokens"]);
    let total = token(&["total_tokens"]);
    let input_tokens = input.unwrap_or(0);
    let output_tokens = output
        .or_else(|| total.map(|total| total.saturating_sub(input_tokens)))
        .unwrap_or(max_tokens);
    let cached_input_tokens = cached.unwrap_or(0).min(input_tokens);
    let derived = input.is_none()
        || output.is_none()
        || cached.is_none()
        || cached.is_some_and(|cached| cached > input.unwrap_or(0))
        || (output.is_none() && total.is_some());
    let estimated = value
        .get("estimated")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || derived;
    crate::frame::model_result::ModelUsage {
        input_tokens,
        output_tokens,
        cached_input_tokens,
        estimated,
    }
}

/// Produce the model-turn receipt (§6.3 B). device_local usage is stamped `usage_source='device_adapter'`
/// with no egress fields (DD:264). success→completed/succeeded; an I/O unknown→unknown (awaits
/// operation_resolution, §5.3); an identity/binding refusal→completed/rejected_not_executed (no byte
/// sent, §5.4 step 4); an endpoint refusal→completed/failed (the model produced no answer).
#[allow(clippy::too_many_arguments)]
fn produce_model_receipt(
    ctx: &RunContext,
    bootstrap: &crate::ipc::nodepipe::RunBootstrap,
    request_doc: &Value,
    command: Option<&DispatchedCommand>,
    logical_key: &str,
    reply: &Value,
    checkpoint_seq: &mut i64,
    latest_checkpoint_hash: &mut String,
) -> bool {
    let ty = reply["type"].as_str().unwrap_or("");
    let body = &reply["body"];
    let request_hash = if bootstrap.probe.is_some() {
        model_request_hash_for_bootstrap(request_doc, bootstrap)
    } else {
        model_request_hash(request_doc)
    };
    let operation_id = command
        .map(|c| c.operation_id.clone())
        .unwrap_or_else(|| logical_key.to_string());
    let attempt = command
        .map(|c| c.dispatch_attempt_id.clone())
        .unwrap_or_else(|| logical_key.to_string());
    let request_hash = command
        .map(|c| c.request_hash.clone())
        .unwrap_or(request_hash);
    let local_ref = format!("{}:{}", ctx.run_id, operation_id);
    let facts = match ty {
        nodemsg::MODEL_RESPONSE => ReceiptFacts {
            operation_id: operation_id.clone(),
            run_id: ctx.run_id.clone(),
            session_id: ctx.session_id.clone(),
            generation: ctx.generation,
            attempt: attempt.clone(),
            fence: ctx.fence,
            request_hash: request_hash.clone(),
            state: "completed".into(),
            outcome: Some("succeeded".into()),
            result_hash: body["answer_hash"].as_str().unwrap_or("").to_string(),
            local_result_ref: local_ref,
            model_delivery: None,
            usage: Some(body["usage"].clone()),
            usage_source: Some("device_adapter".into()),
            error_code: String::new(),
        },
        nodemsg::MODEL_UNKNOWN => ReceiptFacts {
            operation_id: operation_id.clone(),
            run_id: ctx.run_id.clone(),
            session_id: ctx.session_id.clone(),
            generation: ctx.generation,
            attempt: attempt.clone(),
            fence: ctx.fence,
            request_hash: request_hash.clone(),
            state: "unknown".into(),
            outcome: None,
            result_hash: String::new(),
            local_result_ref: String::new(),
            model_delivery: None,
            usage: None,
            usage_source: None,
            error_code: body["reason"]
                .as_str()
                .unwrap_or("model_io_unknown")
                .to_string(),
        },
        nodemsg::MODEL_BLOCKED => {
            let reason = body["reason"].as_str().unwrap_or("model_blocked");
            let outcome = if reason == "identity_mismatch" || reason == "model_binding_missing" {
                "rejected_not_executed"
            } else {
                "failed"
            };
            ReceiptFacts {
                operation_id: operation_id.clone(),
                run_id: ctx.run_id.clone(),
                session_id: ctx.session_id.clone(),
                generation: ctx.generation,
                attempt: attempt.clone(),
                fence: ctx.fence,
                request_hash: request_hash.clone(),
                state: "completed".into(),
                outcome: Some(outcome.into()),
                result_hash: String::new(),
                local_result_ref: String::new(),
                model_delivery: None,
                usage: None,
                usage_source: None,
                error_code: reason.to_string(),
            }
        }
        _ => return false,
    };
    if let Some(command) = command {
        let usage = if ty == nodemsg::MODEL_RESPONSE {
            Some(model_usage(body.get("usage"), bootstrap.max_tokens))
        } else {
            None
        };
        let model_facts = crate::journalop::ModelResultFacts {
            run_id: ctx.run_id.clone(),
            operation_id: command.operation_id.clone(),
            attempt_id: command.dispatch_attempt_id.clone(),
            session_id: ctx.session_id.clone(),
            request_hash: facts
                .request_hash
                .strip_prefix("sha256:")
                .unwrap_or(&facts.request_hash)
                .to_string(),
            state: facts.state.clone(),
            outcome: if facts.state == "completed" {
                Some(if facts.outcome.as_deref() == Some("succeeded") {
                    "succeeded".into()
                } else {
                    "failed".into()
                })
            } else {
                None
            },
            result_hash: (!facts.result_hash.is_empty()).then(|| {
                facts
                    .result_hash
                    .strip_prefix("sha256:")
                    .unwrap_or(&facts.result_hash)
                    .to_string()
            }),
            provider_request_id: body["provider_request_id"].as_str().map(str::to_string),
            model: bootstrap.model_name.clone(),
            usage,
            error_code: (!facts.error_code.is_empty()).then(|| facts.error_code.clone()),
            probe: bootstrap
                .probe
                .as_ref()
                .map(|probe| crate::journalop::ProbeResultMetadata {
                    binding_id: probe.binding_id.clone(),
                    probe_id: probe.probe_id.clone(),
                    preview_hash: probe.preview_hash.clone(),
                }),
        };
        let op = JournalOp::AppendModelResult {
            org_id: ctx.org_id.clone(),
            subject_id: ctx.subject_id.clone(),
            facts: Box::new(model_facts),
        };
        match ctx.journal.request(op) {
            Some(JournalReply::ModelResultProduced { .. }) => {}
            other => {
                eprintln!("work-device: model_result production failed: {other:?}");
                return false;
            }
        }
    }
    record_model_turn(
        ctx,
        bootstrap,
        facts,
        logical_key,
        checkpoint_seq,
        latest_checkpoint_hash,
    );
    true
}

/// Produce the tool-call receipt (§6.3 C). A write binds the dispatched command's operation_id +
/// request_hash; a read uses the Run-unique logical_key + the canonical args hash. success→completed/
/// succeeded; an isError result→completed/failed; a side-effect unknown (io_unknown/tool_unknown)→
/// unknown (replay:'never', awaits resolution DD:104); pending_approval records NOTHING (the action
/// awaits a future command, no execution decision yet). A command binding mismatch also records
/// NOTHING: the call does not represent that operation. Other refusals→completed/rejected_not_executed.
#[allow(clippy::too_many_arguments)]
fn produce_tool_receipt(
    ctx: &RunContext,
    bootstrap: &crate::ipc::nodepipe::RunBootstrap,
    cmd: Option<&DispatchedCommand>,
    tool_name: &str,
    args: &Value,
    logical_key: &str,
    reply: &Value,
    checkpoint_seq: &mut i64,
    latest_checkpoint_hash: &mut String,
) {
    // A tampered call is not an execution decision on the authorized operation. In particular,
    // never turn its tool_blocked into a rejected receipt that could poison the legitimate retry.
    if let Some(cmd) = cmd {
        if !command_matches_request(ctx, cmd, tool_name, args) {
            return;
        }
    }
    let ty = reply["type"].as_str().unwrap_or("");
    let body = &reply["body"];
    let operation_id = cmd
        .map(|c| c.operation_id.clone())
        .unwrap_or_else(|| logical_key.to_string());
    let request_hash = cmd
        .map(|c| c.request_hash.clone())
        .unwrap_or_else(|| canonical_hash(args));
    // A write echoes the command's uuid dispatch_attempt_id (the server receipt gate binds to it);
    // a read has no dispatched operation, so it carries the Run-unique logical_key as a local marker.
    let attempt = cmd
        .map(|c| c.dispatch_attempt_id.clone())
        .unwrap_or_else(|| logical_key.to_string());
    let local_ref = format!("{}:{}", ctx.run_id, operation_id);
    let base = |state: &str,
                outcome: Option<String>,
                result_hash: String,
                error_code: String,
                local_result_ref: String|
     -> ReceiptFacts {
        ReceiptFacts {
            operation_id: operation_id.clone(),
            run_id: ctx.run_id.clone(),
            session_id: ctx.session_id.clone(),
            generation: ctx.generation,
            attempt: attempt.clone(),
            fence: ctx.fence,
            request_hash: request_hash.clone(),
            state: state.into(),
            outcome,
            result_hash,
            local_result_ref,
            model_delivery: None,
            usage: None,
            usage_source: None,
            error_code,
        }
    };
    let facts = match ty {
        nodemsg::TOOL_RESULT => {
            let is_error = body["is_error"].as_bool().unwrap_or(false);
            // The server device_receipt.result_hash column requires BARE 64-hex (0042:331), like the
            // request_hash/checkpoint_hash gates — not the sha256:-prefixed sealed-buffer content form.
            let result_hash = crate::sha256_hex(
                &crate::frame::jcs::canonicalize(&body["content"]).unwrap_or_default(),
            );
            if is_error {
                base(
                    "completed",
                    Some("failed".into()),
                    result_hash,
                    "tool_error".into(),
                    local_ref,
                )
            } else {
                base(
                    "completed",
                    Some("succeeded".into()),
                    result_hash,
                    String::new(),
                    local_ref,
                )
            }
        }
        nodemsg::TOOL_UNKNOWN => base(
            "unknown",
            None,
            String::new(),
            body["reason"]
                .as_str()
                .unwrap_or("tool_unknown")
                .to_string(),
            String::new(),
        ),
        nodemsg::TOOL_BLOCKED => {
            let reason = body["reason"].as_str().unwrap_or("tool_blocked");
            if reason == "pending_approval" {
                // No execution decision yet: the loop pauses awaiting a dispatched command.
                return;
            }
            if reason == "io_unknown" {
                base(
                    "unknown",
                    None,
                    String::new(),
                    reason.to_string(),
                    String::new(),
                )
            } else {
                base(
                    "completed",
                    Some("rejected_not_executed".into()),
                    String::new(),
                    reason.to_string(),
                    String::new(),
                )
            }
        }
        _ => return,
    };
    record_operation(
        ctx,
        bootstrap,
        facts,
        logical_key,
        checkpoint_seq,
        latest_checkpoint_hash,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::{dek, Journal};

    struct TempDir(String);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("work-nodesvc-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir.to_string_lossy().into_owned())
        }
        fn path(&self) -> &str {
            &self.0
        }
        fn join(&self, rel: &str) -> String {
            format!("{}\\{}", self.0, rel.replace('/', "\\"))
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A stand-in sync core: the journal is created AND owned inside this thread (Journal is !Send),
    /// serving journal-op requests until the handle drops. Exactly the production ownership shape.
    fn journal_server() -> (JournalHandle, std::thread::JoinHandle<()>) {
        let (handle, _up_rx, server) = journal_server_with_uplinks();
        (handle, server)
    }

    /// The same stand-in sync core, but its produced uplink frames are captured for the test to read
    /// (the production path signs + uplinks on this thread; the receiver stands in for the link).
    fn journal_server_with_uplinks() -> (
        JournalHandle,
        tokio::sync::mpsc::Receiver<crate::transport::UplinkFrame>,
        std::thread::JoinHandle<()>,
    ) {
        let (handle, up_rx, server, _count) = journal_server_counted();
        (handle, up_rx, server)
    }

    /// Count every journal operation, not just uplinks: binding refusals must not register jtis,
    /// record receipts, or advance checkpoints (and a later legitimate request must still work).
    fn journal_server_counted() -> (
        JournalHandle,
        tokio::sync::mpsc::Receiver<crate::transport::UplinkFrame>,
        std::thread::JoinHandle<()>,
        Arc<std::sync::atomic::AtomicUsize>,
    ) {
        journal_server_counted_delayed(std::time::Duration::ZERO)
    }

    fn journal_server_counted_delayed(
        register_delay: std::time::Duration,
    ) -> (
        JournalHandle,
        tokio::sync::mpsc::Receiver<crate::transport::UplinkFrame>,
        std::thread::JoinHandle<()>,
        Arc<std::sync::atomic::AtomicUsize>,
    ) {
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let server_count = count.clone();
        let (handle, mut rx) = crate::journalop::channel();
        let (up_tx, up_rx) = tokio::sync::mpsc::channel(64);
        let path = std::env::temp_dir().join(format!("work-nodesvc-j-{}.db", uuid::Uuid::new_v4()));
        let server = std::thread::spawn(move || {
            let journal = Journal::create(&path, "dev", &dek::TestWrap).unwrap();
            let key = crate::key::SoftwareKey::random();
            let instance = crate::journalop::InstanceFacts {
                agent_instance_id: "agent".into(),
                boot_id: "boot".into(),
            };
            let producer = crate::journalop::Producer {
                key: &key,
                uplinks: &up_tx,
                instance: &instance,
            };
            while let Some((op, reply)) = rx.blocking_recv() {
                server_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if !register_delay.is_zero()
                    && matches!(op, crate::journalop::JournalOp::RegisterAction { .. })
                {
                    std::thread::sleep(register_delay);
                }
                let r = crate::journalop::execute(&journal, &producer, op);
                let _ = reply.send(r);
            }
            drop(journal);
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_file(path.with_extension("db-wal"));
            let _ = std::fs::remove_file(path.with_extension("db-shm"));
        });
        (handle, up_rx, server, count)
    }

    fn ctx(handle: JournalHandle) -> RunContext {
        RunContext {
            run_id: "run".into(),
            org_id: "org".into(),
            subject_id: "sub".into(),
            session_id: "sess".into(),
            fence: 2,
            generation: 1,
            profile_id: "profile-dev-fixture-v1".into(),
            journal: handle,
            lease_id: "lease".into(),
            baseline_checkpoint_hash: String::new(),
            grant_set: vec![],
            prepared_actions: shared_prepared_actions(),
            io_deadline: Arc::new(Mutex::new(Some(
                std::time::Instant::now() + std::time::Duration::from_secs(300),
            ))),
        }
    }

    fn executor_with_grant(tmp: &TempDir) -> WorkspaceExecutor {
        let mut exec = WorkspaceExecutor::new();
        let (token, _conf, _root_hash) = exec.prepare_root(tmp.path()).unwrap();
        exec.confirm_root(&token, "g1", vec!["out".into()], true)
            .unwrap();
        exec
    }

    #[test]
    fn user_edit_copy_is_create_new_verified_and_idempotent() {
        let tmp = TempDir::new("user-copy");
        std::fs::create_dir_all(tmp.join("WeMeet成果")).unwrap();
        let mut exec = WorkspaceExecutor::new();
        let (token, _conf, _root_hash) = exec.prepare_root(tmp.path()).unwrap();
        let root_hash = exec
            .confirm_root(&token, "g1", vec!["WeMeet成果".into()], true)
            .unwrap();
        let grant_ref = json!({
            "grant_id": "g1",
            "root_identity_hash": root_hash,
        })
        .to_string();
        let version_id = "11111111-1111-4111-8111-111111111111";
        let bytes = b"visible user edit";
        let content_hash = crate::sha256_hex(bytes);
        exec.write_user_copy(&grant_ref, version_id, "md", bytes, &content_hash)
            .unwrap();
        let path = tmp.join(&format!("WeMeet成果/{version_id}.md"));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        exec.write_user_copy(&grant_ref, version_id, "md", bytes, &content_hash)
            .unwrap();
        std::fs::write(&path, b"tampered").unwrap();
        assert!(exec
            .write_user_copy(&grant_ref, version_id, "md", bytes, &content_hash)
            .is_err());
        let wrong_root = json!({
            "grant_id": "g1",
            "root_identity_hash": "sha256:wrong",
        })
        .to_string();
        assert!(exec
            .write_user_copy(&wrong_root, version_id, "md", bytes, &content_hash)
            .is_err());
    }

    #[test]
    fn same_root_identity_returns_bare_hex_and_refuses_a_different_root() {
        let first = TempDir::new("root-a");
        let second = TempDir::new("root-b");
        let mut exec = executor_with_grant(&first);
        let (token, _conf, _root_hash) = exec.prepare_root(first.path()).unwrap();
        exec.confirm_root(&token, "g2", vec!["out".into()], true)
            .unwrap();
        let identity = exec.same_root_identity("g1", "g2").unwrap();
        assert_eq!(identity.len(), 64);
        assert!(!identity.starts_with("sha256:"));

        let (token, _conf, _root_hash) = exec.prepare_root(second.path()).unwrap();
        exec.confirm_root(&token, "g3", vec!["out".into()], true)
            .unwrap();
        assert!(matches!(
            exec.same_root_identity("g1", "g3"),
            Err(ExecError::WorkspaceChanged)
        ));
    }

    #[test]
    fn expired_model_permit_blocks_before_endpoint_lookup() {
        let exec = WorkspaceExecutor::new();
        let (handle, _uplinks, server, count) = journal_server_counted();
        let ctx = ctx(handle);
        let reply = exec.invoke_model(
            &ctx,
            &json!({ "v": 1 }),
            Some(std::time::Instant::now() - std::time::Duration::from_secs(1)),
        );
        assert_eq!(reply["body"]["reason"], "permit_expired");
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 0);
        drop(ctx);
        server.join().unwrap();
    }

    #[test]
    fn delayed_journal_registration_cannot_extend_the_model_permit() {
        let mut exec = WorkspaceExecutor::new();
        let (handle, _uplinks, server, count) =
            journal_server_counted_delayed(std::time::Duration::from_millis(200));
        let ctx = ctx(handle);
        let permit_deadline = std::time::Instant::now() + std::time::Duration::from_millis(50);
        let cmd = DispatchedCommand {
            operation_id: "op-model".into(),
            logical_key: "model:local:1#0".into(),
            tool_name: "model.send_device_local".into(),
            request_hash: "hash".into(),
            permit_jti: "jti-model".into(),
            fence: 2,
            generation: 1,
            dispatch_attempt_id: "attempt-model".into(),
            permit_deadline: Some(permit_deadline),
        };
        assert!(matches!(
            exec.register_permit(&ctx, &cmd, &json!({ "v": 1 })),
            PermitGate::Proceed
        ));
        assert!(std::time::Instant::now() >= permit_deadline);
        let reply = exec.invoke_model(&ctx, &json!({ "v": 1 }), cmd.permit_deadline);
        assert_eq!(reply["body"]["reason"], "permit_expired");
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 1);
        drop(ctx);
        server.join().unwrap();
    }

    #[test]
    fn expired_or_revoked_run_cannot_start_broker_io() {
        let tmp = TempDir::new("expired-io");
        std::fs::create_dir_all(tmp.join("docs")).unwrap();
        let mut exec = executor_with_grant(&tmp);
        let (handle, _uplinks, server, count) = journal_server_counted();
        let ctx = ctx(handle);
        let args = json!({"grant_id":"g1", "relative_dir":"docs", "limit":"1"});
        for deadline in [Some(std::time::Instant::now()), None] {
            *ctx.io_deadline.lock().unwrap() = deadline;
            let reply = exec.execute_tool(&ctx, tools::WORKSPACE_LIST, &args, "tc", None);
            assert_eq!(reply["body"]["reason"], "lease_expired");
            assert_eq!(
                exec.invoke_model(&ctx, &json!({}), None)["body"]["reason"],
                "lease_expired"
            );
            assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 0);
        }
        drop(ctx);
        drop(exec);
        server.join().unwrap();
    }

    #[test]
    fn a_chunk_boundary_expiry_reuses_the_pre_execution_gate_reason() {
        let reply = exec_refusal("tc-1", ExecError::LeaseExpired);
        assert_eq!(reply["body"]["reason"], "lease_expired");
        assert_eq!(reply["body"]["is_error"], true);
        assert_eq!(reply["body"]["terminate"], false);
        // The catch-all still owns genuine unexpected I/O failures.
        assert_eq!(
            exec_refusal("tc-2", ExecError::Io)["body"]["reason"],
            "io_unknown"
        );
    }

    #[test]
    fn list_then_read_round_trips_with_file_identity() {
        let tmp = TempDir::new("read");
        std::fs::create_dir_all(tmp.join("docs")).unwrap();
        std::fs::write(tmp.join("docs/a.txt"), b"hello world").unwrap();
        let mut exec = executor_with_grant(&tmp);
        let (handle, server) = journal_server();
        let ctx = ctx(handle);

        let list_args = json!({ "grant_id": "g1", "relative_dir": "docs", "limit": "50" });
        let list_reply = exec.execute_tool(&ctx, "workspace.list", &list_args, "tc-1", None);
        assert_eq!(list_reply["type"], "tool_result");
        let entries = list_reply["body"]["content"]["entries"].as_array().unwrap();
        let entry = entries.iter().find(|e| e["name"] == "a.txt").unwrap();
        let entry_ref = entry["entry_ref"].as_str().unwrap().to_string();
        // The list response carries no path — only the random entry_ref + name.
        assert!(entry.get("relative_path").is_none());

        // Read by entry_ref; expected_identity is the file_id the list gave (here we read it back).
        let read_args = json!({
            "grant_id": "g1", "entry_ref": entry_ref, "expected_identity": "", "max_bytes": "262144"
        });
        let read_reply = exec.execute_tool(&ctx, "workspace.read", &read_args, "tc-2", None);
        assert_eq!(read_reply["type"], "tool_result");
        assert_eq!(
            read_reply["body"]["content"]["content"][0]["text"],
            "hello world"
        );

        drop(ctx);
        drop(exec);
        server.join().unwrap();
    }

    #[test]
    fn search_returns_sealed_hits() {
        let tmp = TempDir::new("search");
        std::fs::create_dir_all(tmp.join("docs")).unwrap();
        std::fs::write(tmp.join("docs/a.txt"), b"a needle line").unwrap();
        let mut exec = executor_with_grant(&tmp);
        let (handle, server) = journal_server();
        let ctx = ctx(handle);
        let args = json!({ "grant_id": "g1", "relative_dir": "docs", "literal_query": "needle", "limit": "10" });
        let reply = exec.execute_tool(&ctx, "workspace.search", &args, "tc-1", None);
        assert_eq!(reply["type"], "tool_result");
        let hits = reply["body"]["content"]["hits"].as_array().unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0]["buffer_hash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));
        drop(ctx);
        drop(exec);
        server.join().unwrap();
    }

    #[test]
    fn write_without_a_dispatched_permit_is_blocked() {
        let tmp = TempDir::new("nopermit");
        std::fs::create_dir_all(tmp.join("out")).unwrap();
        let mut exec = executor_with_grant(&tmp);
        exec.seal_body("body-1".into(), b"artifact".to_vec());
        let (handle, server) = journal_server();
        let ctx = ctx(handle);
        let sealed = crate::tools::SealedBuffer::seal(b"artifact".to_vec());
        let args = json!({
            "grant_id": "g1", "artifact_id": "a", "version_id": "v1", "format": "md",
            "body_ref": "body-1", "content_hash": sealed.hash(), "byte_count": "8"
        });
        let reply = exec.execute_tool(&ctx, "artifact.write", &args, "tc-1", None);
        assert_eq!(reply["type"], "tool_blocked");
        assert_eq!(reply["body"]["reason"], "pending_approval");
        assert!(!std::path::Path::new(&tmp.join("out/v1.md")).exists());
        drop(ctx);
        drop(exec);
        server.join().unwrap();
    }

    #[test]
    fn write_with_a_permit_registers_the_jti_and_creates_the_artifact() {
        let tmp = TempDir::new("write");
        std::fs::create_dir_all(tmp.join("out")).unwrap();
        let mut exec = executor_with_grant(&tmp);
        let body = b"artifact body".to_vec();
        exec.seal_body("body-1".into(), body.clone());
        let sealed = crate::tools::SealedBuffer::seal(body);
        let args = json!({
            "grant_id": "g1", "artifact_id": "a", "version_id": "v1", "format": "md",
            "body_ref": "body-1", "content_hash": sealed.hash(), "byte_count": "13"
        });
        let (handle, server) = journal_server();
        let ctx = ctx(handle);
        let cmd = DispatchedCommand {
            operation_id: "op-1".into(),
            logical_key: "tool:0:0".into(),
            tool_name: "write-v1".into(),
            request_hash: tool_request_hash(&args).unwrap(),
            permit_jti: "jti-1".into(),
            fence: 2,
            generation: 1,
            dispatch_attempt_id: "attempt-1".into(),
            permit_deadline: None,
        };
        let reply = exec.execute_tool(&ctx, "artifact.write", &args, "tc-1", Some(&cmd));
        assert_eq!(reply["type"], "tool_result", "{reply}");
        assert_eq!(reply["body"]["content"]["written"], true);
        assert_eq!(
            std::fs::read(tmp.join("out/v1.md")).unwrap(),
            b"artifact body"
        );

        // A second write with the SAME jti is consumed → blocked, never re-executed (DD:123).
        let again = exec.execute_tool(&ctx, "artifact.write", &args, "tc-2", Some(&cmd));
        assert_eq!(again["type"], "tool_blocked");
        assert_eq!(again["body"]["reason"], "already_consumed");

        drop(ctx);
        drop(exec);
        server.join().unwrap();
    }

    #[test]
    fn tampered_command_binding_has_no_journal_or_io_and_original_request_still_succeeds() {
        let tmp = TempDir::new("binding");
        let other = TempDir::new("binding-other");
        std::fs::create_dir_all(tmp.join("out")).unwrap();
        std::fs::create_dir_all(other.join("out")).unwrap();
        let mut exec = executor_with_grant(&tmp);
        let (token, _, _) = exec.prepare_root(other.path()).unwrap();
        exec.confirm_root(&token, "g2", vec!["out".into()], true)
            .unwrap();
        let (body_ref, content_hash, byte_count) = exec.stage_input("approved body");
        let (other_ref, other_hash, other_size) = exec.stage_input("changed body");
        let args = json!({
            "grant_id": "g1", "artifact_id": "a", "version_id": "v1", "format": "md",
            "body_ref": body_ref, "content_hash": content_hash, "byte_count": byte_count.to_string()
        });
        let (handle, mut up_rx, server, count) = journal_server_counted();
        let ctx = ctx(handle);
        let cmd = DispatchedCommand {
            operation_id: "op-1".into(),
            logical_key: "tool:0:0#0".into(),
            tool_name: "write-v1".into(),
            request_hash: tool_request_hash(&args).unwrap(),
            permit_jti: "jti-1".into(),
            fence: ctx.fence,
            generation: ctx.generation,
            dispatch_attempt_id: "attempt-1".into(),
            permit_deadline: None,
        };
        let bootstrap = bootstrap();
        let mut cp = 0;
        let mut latest = "baseline".to_string();
        for change in [
            "body",
            "version",
            "grant",
            "tool",
            "fence",
            "generation",
            "read_tool",
        ] {
            let mut tampered_args = args.clone();
            let mut tampered_cmd = cmd.clone();
            let mut tool_name = tools::ARTIFACT_WRITE;
            match change {
                "body" => {
                    // A different sealed body with internally consistent hash/size is still NOT approved.
                    tampered_args["body_ref"] = json!(other_ref);
                    tampered_args["content_hash"] = json!(other_hash);
                    tampered_args["byte_count"] = json!(other_size.to_string());
                }
                "version" => tampered_args["version_id"] = json!("v2"),
                "grant" => tampered_args["grant_id"] = json!("g2"),
                "tool" => tampered_cmd.tool_name = "list-v1".into(),
                "fence" => tampered_cmd.fence += 1,
                "generation" => tampered_cmd.generation += 1,
                "read_tool" => {
                    tool_name = tools::WORKSPACE_LIST;
                    tampered_args =
                        json!({ "grant_id": "g1", "relative_dir": "out", "limit": "1" });
                }
                _ => unreachable!(),
            }
            let reply =
                exec.execute_tool(&ctx, tool_name, &tampered_args, "tc", Some(&tampered_cmd));
            assert_eq!(reply["type"], "tool_blocked", "{change}: {reply}");
            assert_eq!(
                reply["body"]["reason"], "command_binding_mismatch",
                "{change}"
            );
            // Exercise the same receipt producer used by serve_run, including its operation binding.
            produce_tool_receipt(
                &ctx,
                &bootstrap,
                Some(&tampered_cmd),
                tool_name,
                &tampered_args,
                "tool:0:0",
                &reply,
                &mut cp,
                &mut latest,
            );
            assert_eq!(
                count.load(std::sync::atomic::Ordering::SeqCst),
                0,
                "{change}"
            );
            assert!(up_rx.try_recv().is_err());
            assert_eq!(cp, 0);
            assert_eq!(latest, "baseline");
            assert!(exec.executed_permits.is_empty());
            assert_eq!(std::fs::read_dir(tmp.join("out")).unwrap().count(), 0);
            assert_eq!(std::fs::read_dir(other.join("out")).unwrap().count(), 0);
        }
        // Refusals did not consume the approved command or poison it with a terminal receipt.
        let reply = exec.execute_tool(&ctx, tools::ARTIFACT_WRITE, &args, "original", Some(&cmd));
        assert_eq!(reply["type"], "tool_result", "{reply}");
        assert_eq!(
            std::fs::read(tmp.join("out/v1.md")).unwrap(),
            b"approved body"
        );
        produce_tool_receipt(
            &ctx,
            &bootstrap,
            Some(&cmd),
            tools::ARTIFACT_WRITE,
            &args,
            "tool:0:0",
            &reply,
            &mut cp,
            &mut latest,
        );
        assert_eq!(cp, 1);
        let receipt = up_rx.blocking_recv().unwrap();
        assert_eq!(receipt.body["outcome"], "succeeded");
        assert_eq!(receipt.body["request_hash"], cmd.request_hash);
        let _checkpoint = up_rx.blocking_recv().unwrap();
        let before_replay = count.load(std::sync::atomic::Ordering::SeqCst);
        let again = exec.execute_tool(&ctx, tools::ARTIFACT_WRITE, &args, "replay", Some(&cmd));
        assert_eq!(again["body"]["reason"], "already_consumed");
        assert_eq!(
            count.load(std::sync::atomic::Ordering::SeqCst),
            before_replay
        );
        assert_eq!(
            std::fs::read(tmp.join("out/v1.md")).unwrap(),
            b"approved body"
        );
        assert_eq!(std::fs::read_dir(other.join("out")).unwrap().count(), 0);
        drop(ctx);
        drop(exec);
        server.join().unwrap();
    }

    #[test]
    fn unsafe_artifact_versions_are_rejected_before_permit_registration_or_io() {
        let tmp = TempDir::new("unsafe-version");
        std::fs::create_dir_all(tmp.join("out/sub")).unwrap();
        let mut exec = executor_with_grant(&tmp);
        let (body_ref, hash, size) = exec.stage_input("body");
        let (handle, _up_rx, server, count) = journal_server_counted();
        let ctx = ctx(handle);
        for version in [
            "sub/evil",
            "sub\\evil",
            "../evil",
            "..\\evil",
            "C:evil",
            "v:ads",
            "v\0tail",
            ".",
            "..",
            "CON",
            "NUL.txt",
            "LPT9",
            "v.",
            "v ",
        ] {
            let args = json!({
                "grant_id": "g1", "artifact_id": "a", "version_id": version, "format": "md",
                "body_ref": body_ref, "content_hash": hash, "byte_count": size.to_string()
            });
            // Even an exactly bound command cannot turn a version identifier into a path.
            let cmd = DispatchedCommand {
                operation_id: "op-1".into(),
                logical_key: "tool:0:0#0".into(),
                tool_name: "write-v1".into(),
                request_hash: tool_request_hash(&args).unwrap(),
                permit_jti: "jti-1".into(),
                fence: ctx.fence,
                generation: ctx.generation,
                dispatch_attempt_id: "attempt-1".into(),
                permit_deadline: None,
            };
            let reply = exec.execute_tool(&ctx, tools::ARTIFACT_WRITE, &args, "tc", Some(&cmd));
            assert_eq!(reply["body"]["reason"], "bad_path", "{version:?}: {reply}");
        }
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert!(exec.executed_permits.is_empty());
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 1);
        assert_eq!(std::fs::read_dir(tmp.join("out")).unwrap().count(), 1);
        assert_eq!(std::fs::read_dir(tmp.join("out/sub")).unwrap().count(), 0);
        drop(ctx);
        drop(exec);
        server.join().unwrap();
    }

    fn bootstrap() -> crate::ipc::nodepipe::RunBootstrap {
        crate::ipc::nodepipe::RunBootstrap {
            run_id: "run".into(),
            binding_revision: 1,
            start_nonce: "nonce".into(),
            profile_id: "profile-dev-fixture-v1".into(),
            compat_profile_version: 1,
            tool_manifest_hash: "tmh".into(),
            runtime_digest: "rd".into(),
            model_provider: "device-local".into(),
            model_name: "fixture-model".into(),
            model_config_revision: 1,
            sealed_input_b64: Some(crate::b64::encode(b"staged composer text")),
            max_turns: 8,
            max_tokens: 4096,
            max_bytes: 1048576,
            deadline: "2026-11-19T01:00:00Z".into(),
            probe: None,
        }
    }

    fn write_args() -> Value {
        json!({
            "grant_id": "g1", "artifact_id": "a", "version_id": "v1", "format": "md",
            "body_ref": "body-1", "content_hash": "sha256:body", "byte_count": "8"
        })
    }

    #[test]
    fn propose_and_await_returns_a_prefed_command_and_uplinks_action_prepare() {
        let tmp = TempDir::new("propose-fed");
        std::fs::create_dir_all(tmp.join("out")).unwrap();
        let exec = executor_with_grant(&tmp);
        let (handle, mut up_rx, server) = journal_server_with_uplinks();
        let mut ctx = ctx(handle);
        ctx.grant_set = vec![crate::frame::offer::GrantRef {
            grant_id: "g1".into(),
            grant_revision: 1,
        }];
        let cmd = DispatchedCommand {
            operation_id: "op-1".into(),
            logical_key: "tool:0:0#0".into(),
            tool_name: "write-v1".into(),
            request_hash: tool_request_hash(&write_args()).unwrap(),
            permit_jti: "jti-1".into(),
            fence: 2,
            generation: 1,
            dispatch_attempt_id: "attempt-1".into(),
            permit_deadline: None,
        };
        let commands = shared_commands(vec![cmd.clone()]);
        let got = propose_and_await_command(
            &ctx,
            &bootstrap(),
            &exec,
            "artifact.write",
            &write_args(),
            "tool:0:0",
            "tool:0:0#0",
            0,
            "sha256:baseline",
            &commands,
            std::time::Duration::from_secs(2),
        )
        .expect("a pre-fed command must be returned");
        assert_eq!(got.operation_id, "op-1");
        assert_eq!(got.logical_key, "tool:0:0#0");

        // The proposal uplinked a closed action_prepare (server-keyed) before awaiting the command.
        let frame = up_rx.blocking_recv().expect("an action_prepare uplink");
        assert_eq!(
            frame.frame_type,
            crate::frame::action::ACTION_PREPARE_FRAME_TYPE
        );
        assert_eq!(frame.body["logical_key"], "tool:0:0#0");
        assert_eq!(frame.body["step_key"], "tool:0:0");
        assert_eq!(frame.body["grant_id"], "g1");
        assert_eq!(frame.body["grant_revision"], "1");
        assert_eq!(frame.body["action_kind"], "artifact.write");
        assert_eq!(frame.body["tool_schema"], "write-v1");
        assert_eq!(frame.body["classification"], "local_only");
        assert_eq!(frame.body["lease_id"], "lease");
        assert_eq!(frame.body["fence"], "2");
        assert_eq!(frame.body["checkpoint_hash"], "sha256:baseline");
        let body: crate::frame::action::ActionPrepareBody =
            serde_json::from_value(frame.body).unwrap();
        assert!(body.shape_consistent());

        drop(ctx);
        drop(exec);
        server.join().unwrap();
    }

    #[test]
    fn propose_and_await_times_out_to_none_when_no_command_arrives() {
        let tmp = TempDir::new("propose-timeout");
        std::fs::create_dir_all(tmp.join("out")).unwrap();
        let exec = executor_with_grant(&tmp);
        let (handle, _up_rx, server) = journal_server_with_uplinks();
        let ctx = ctx(handle);
        let commands = shared_commands(vec![]);
        let got = propose_and_await_command(
            &ctx,
            &bootstrap(),
            &exec,
            "artifact.write",
            &write_args(),
            "tool:0:0",
            "tool:0:0#0",
            0,
            "sha256:baseline",
            &commands,
            std::time::Duration::from_millis(120),
        );
        assert!(
            got.is_none(),
            "an unanswered proposal maps to pending_approval"
        );
        drop(ctx);
        drop(exec);
        server.join().unwrap();
    }

    #[test]
    fn propose_and_await_refuses_an_unregistered_grant_without_uplinking() {
        let exec = WorkspaceExecutor::new();
        let (handle, mut up_rx, server) = journal_server_with_uplinks();
        let ctx = ctx(handle);
        let commands = shared_commands(vec![]);
        let got = propose_and_await_command(
            &ctx,
            &bootstrap(),
            &exec,
            "artifact.write",
            &write_args(),
            "tool:0:0",
            "tool:0:0#0",
            0,
            "sha256:baseline",
            &commands,
            std::time::Duration::from_millis(120),
        );
        assert!(got.is_none(), "an unregistered grant is refused fast");
        assert!(
            up_rx.try_recv().is_err(),
            "a grant refusal must not uplink an action_prepare"
        );
        drop(ctx);
        drop(exec);
        server.join().unwrap();
    }

    #[test]
    fn staged_input_feeds_an_artifact_write_with_matching_hash_and_size() {
        let tmp = TempDir::new("staged-write");
        std::fs::create_dir_all(tmp.join("out")).unwrap();
        let mut exec = executor_with_grant(&tmp);
        // §1.1 stageLocalInput seals the Composer text; the write references the returned ref.
        let (input_ref, content_hash, byte_count) = exec.stage_input("artifact body");
        assert!(content_hash.starts_with("sha256:"));
        assert_eq!(byte_count, 13);
        let args = json!({
            "grant_id": "g1", "artifact_id": "a", "version_id": "v1", "format": "md",
            "body_ref": input_ref, "content_hash": content_hash, "byte_count": byte_count.to_string()
        });
        let (handle, server) = journal_server();
        let ctx = ctx(handle);
        let cmd = DispatchedCommand {
            operation_id: "op-1".into(),
            logical_key: "tool:0:0".into(),
            tool_name: "write-v1".into(),
            request_hash: tool_request_hash(&args).unwrap(),
            permit_jti: "jti-1".into(),
            fence: 2,
            generation: 1,
            dispatch_attempt_id: "attempt-1".into(),
            permit_deadline: None,
        };
        let reply = exec.execute_tool(&ctx, "artifact.write", &args, "tc-1", Some(&cmd));
        assert_eq!(reply["type"], "tool_result", "{reply}");
        assert_eq!(reply["body"]["content"]["written"], true);
        assert_eq!(
            std::fs::read(tmp.join("out/v1.md")).unwrap(),
            b"artifact body"
        );
        drop(ctx);
        drop(exec);
        server.join().unwrap();
    }

    #[test]
    fn an_unregistered_grant_is_refused() {
        let _tmp = TempDir::new("nogrant");
        let mut exec = WorkspaceExecutor::new();
        let (handle, server) = journal_server();
        let ctx = ctx(handle);
        let args = json!({ "grant_id": "missing", "relative_dir": "docs", "limit": "10" });
        let reply = exec.execute_tool(&ctx, "workspace.list", &args, "tc-1", None);
        assert_eq!(reply["type"], "tool_blocked");
        assert_eq!(reply["body"]["reason"], "grant_missing");
        drop(ctx);
        drop(exec);
        server.join().unwrap();
    }

    #[test]
    fn invoke_model_through_a_confirmed_fixture_binding() {
        use std::net::{TcpListener, TcpStream};
        use std::process::{Command, Stdio};
        let probe = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let fixture = format!(
            "{}/../work/node/device-bundle/fixture-server.mjs",
            env!("CARGO_MANIFEST_DIR")
        );
        let mut child = Command::new("node")
            .arg(&fixture)
            .arg(port.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn fixture");
        let mut ready = false;
        for _ in 0..100 {
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                ready = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(ready, "fixture did not listen");

        let mut exec = WorkspaceExecutor::new();
        let (token, _conf) = exec.prepare_model(port).unwrap();
        let sid = crate::listener::current_user_sid().unwrap();
        let requirement = ListenerRequirement {
            allowed_signers: vec![],
            allow_user_pinned_hash: true,
            allowed_service_sids: vec![],
        };
        exec.confirm_model(
            &token,
            "profile-dev-fixture-v1",
            port,
            requirement,
            sid,
            true,
        )
        .unwrap()
        .unwrap();
        let (handle, server) = journal_server();
        let ctx = ctx(handle);
        let reply = exec.invoke_model(&ctx, &json!({ "v": 1, "messages": [] }), None);
        assert_eq!(reply["type"], "model_response", "{reply}");
        assert_eq!(
            reply["body"]["assistant_message"]["tool_calls"][0]["function"]["name"],
            "artifact.write"
        );
        drop(ctx);
        drop(exec);
        server.join().unwrap();
        let _ = child.kill();
        let _ = child.wait();
    }

    /// The Broker side of the pipe loop end-to-end: a mock Node client speaks the real protocol over
    /// the ACL'd pipe (handshake → bootstrap → tool_call → tool_result → loop_end), proving serve_run
    /// dispatches through the executor and exits on loop_end. (The Node bundle side is proven by
    /// device-bundle/test/bundle.test.mjs against pi-agent-core.)
    #[test]
    fn pipe_loop_dispatches_a_tool_call_and_exits_on_loop_end() {
        use crate::ipc::frame;
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE};
        use windows::Win32::Storage::FileSystem::{
            CreateFileW, ReadFile, WriteFile, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_NONE,
            OPEN_EXISTING,
        };
        use windows::Win32::System::Threading::GetCurrentProcessId;

        let tmp = TempDir::new("pipe");
        std::fs::create_dir_all(tmp.join("docs")).unwrap();
        std::fs::write(tmp.join("docs/a.txt"), b"hi").unwrap();

        let service = spawn_node_service();
        let (handle, mut up_rx, server) = journal_server_with_uplinks();
        service
            .blocking_send(NodeRequest::SetJournal {
                journal: handle.clone(),
                org_id: "org".into(),
                subject_id: "subject".into(),
                device_id: "11111111-1111-4111-8111-111111111111".into(),
            })
            .unwrap();
        service
            .blocking_send(NodeRequest::SetLocalSession {
                session_id: "22222222-2222-4222-8222-222222222222".into(),
            })
            .unwrap();
        // Provision a confirmed grant through the thread (the confirmation flow).
        let (rtx, rrx) = tokio::sync::oneshot::channel();
        service
            .blocking_send(NodeRequest::PrepareRoot {
                selected_path: tmp.path().to_string(),
                reply: rtx,
            })
            .unwrap();
        let (token, _conf, _root_hash, _device_id, _session_id) =
            rrx.blocking_recv().unwrap().unwrap();
        let (ctx_tx, ctx_rx) = tokio::sync::oneshot::channel();
        service
            .blocking_send(NodeRequest::ConfirmRoot {
                token,
                grant_id: "g1".into(),
                artifact_dir: vec!["out".into()],
                approved: true,
                reply: ctx_tx,
            })
            .unwrap();
        assert!(ctx_rx.blocking_recv().unwrap().is_some());

        let run_ctx = ctx(handle);
        let journal_handle = run_ctx.journal.clone();
        let transcript_messages = json!([
            { "role": "user", "content": "local transcript sentinel" },
            { "role": "assistant", "content": [{ "type": "text", "text": "done" }] }
        ]);
        let client_messages = transcript_messages.clone();
        let pipe_name = format!("\\\\.\\pipe\\work-nodesvc-test-{}", uuid::Uuid::new_v4());
        let sid = crate::listener::current_user_sid().unwrap();
        let pid = unsafe { GetCurrentProcessId() };
        // The spawn creates the pipe before the sidecar connects; here the test creates it and hands
        // the raw handle to StartRun (serve_run rebuilds the server around it). The in-process mock
        // client below then connects to the same pipe name.
        let node_pipe =
            crate::ipc::nodepipe::NodePipeServer::create(&pipe_name, &sid, pid).expect("node pipe");
        let pipe_handle = node_pipe.into_raw_handle().0 as isize;

        // The mock Node client: handshake, read bootstrap, send a workspace.list tool_call, read the
        // tool_result, send loop_end. Returns the tool_result frame.
        let client_name = pipe_name.clone();
        let client = std::thread::spawn(move || -> Value {
            let name_w: Vec<u16> = client_name
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            unsafe {
                let h = CreateFileW(
                    PCWSTR(name_w.as_ptr()),
                    GENERIC_READ.0 | GENERIC_WRITE.0,
                    FILE_SHARE_NONE,
                    None,
                    OPEN_EXISTING,
                    FILE_FLAGS_AND_ATTRIBUTES(0),
                    None,
                )
                .expect("mock node connect");
                let read_frame = |h: windows::Win32::Foundation::HANDLE| -> Value {
                    let mut buf = vec![0u8; frame::MAX_FRAME_BYTES + frame::LENGTH_PREFIX];
                    let mut read = 0u32;
                    ReadFile(h, Some(buf.as_mut_slice()), Some(&mut read), None).unwrap();
                    buf.truncate(read as usize);
                    serde_json::from_slice(frame::decode(&buf).unwrap()).unwrap()
                };
                let write_frame = |h: windows::Win32::Foundation::HANDLE, v: &Value| {
                    let bytes = frame::encode(&serde_json::to_vec(v).unwrap()).unwrap();
                    let mut written = 0u32;
                    WriteFile(h, Some(bytes.as_slice()), Some(&mut written), None).unwrap();
                };
                let server_hello = read_frame(h);
                let client_hello = json!({
                    "nonce": server_hello["nonce"],
                    "protocol_major": server_hello["protocol_major"],
                    "client_kind": "node",
                });
                write_frame(h, &client_hello);
                let bootstrap = read_frame(h);
                assert_eq!(bootstrap["type"], "run_bootstrap");
                let tool_call = json!({
                    "type": "tool_call",
                    "body": {
                        "tool_call_id": "tc-1",
                        "tool_name": "workspace.list",
                        "args": { "grant_id": "g1", "relative_dir": "docs", "limit": "50" },
                        "logical_key": "tool:0:0",
                    }
                });
                write_frame(h, &tool_call);
                let result = read_frame(h);
                let loop_end = json!({
                    "type": "loop_end",
                    "body": { "transcript_final": { "messages": client_messages }, "turn_count": "1" }
                });
                write_frame(h, &loop_end);
                let _ = CloseHandle(h);
                result
            }
        });

        let bootstrap = crate::ipc::nodepipe::RunBootstrap {
            run_id: "run".into(),
            binding_revision: 1,
            start_nonce: "nonce".into(),
            profile_id: "profile-dev-fixture-v1".into(),
            compat_profile_version: 1,
            tool_manifest_hash: "tmh".into(),
            runtime_digest: "rd".into(),
            model_provider: "device-local".into(),
            model_name: "fixture-model".into(),
            model_config_revision: 1,
            sealed_input_b64: None,
            max_turns: 8,
            max_tokens: 4096,
            max_bytes: 1048576,
            deadline: "2026-11-19T01:00:00Z".into(),
            probe: None,
        };
        let (start_tx, start_rx) = tokio::sync::oneshot::channel();
        service
            .blocking_send(NodeRequest::StartRun {
                ctx: run_ctx,
                bootstrap: Box::new(bootstrap),
                pipe_handle,
                container_sid: sid,
                sidecar_pid: pid,
                commands: shared_commands(vec![]),
                reply: start_tx,
            })
            .unwrap();
        let result = client.join().unwrap();
        assert_eq!(result["type"], "tool_result", "{result}");
        let entries = result["body"]["content"]["entries"].as_array().unwrap();
        assert!(entries.iter().any(|e| e["name"] == "a.txt"));
        assert!(start_rx.blocking_recv().unwrap().is_ok());
        match journal_handle.request(JournalOp::ReadLocalTranscript {
            org_id: "org".into(),
            subject_id: "sub".into(),
            run_id: "run".into(),
        }) {
            Some(JournalReply::LocalTranscript(Ok(Some(body)))) => {
                let document: Value = serde_json::from_slice(&body.bytes).unwrap();
                assert_eq!(document["run_id"], "run");
                assert_eq!(document["turn_count"], "1");
                assert_eq!(document["messages"], transcript_messages);
            }
            other => panic!("loop_end transcript was not persisted: {other:?}"),
        }
        drop(journal_handle);

        // A3 live-owner evidence (E5 甲): the read drove a signed receipt + a checkpoint commit uplink
        // through the journal-op channel. org/subject come from the verified-session RunContext, the
        // operation is the Run-unique logical_key (no dispatched command for a read), and the
        // checkpoint covers receipt seq 1.
        let receipt = up_rx.blocking_recv().unwrap();
        assert_eq!(receipt.frame_type, "receipt");
        assert_eq!(receipt.body["state"], "completed");
        assert_eq!(receipt.body["outcome"], "succeeded");
        assert_eq!(receipt.body["original_execution"]["operation"], "tool:0:0");
        assert_eq!(receipt.body["original_execution"]["org"], "org");
        assert_eq!(receipt.body["original_execution"]["subject"], "sub");
        assert_eq!(receipt.body["original_execution"]["session"], "sess");
        assert!(receipt.body["request_hash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));
        assert!(receipt.body["signature"].as_str().is_some());
        let commit = up_rx.blocking_recv().unwrap();
        assert_eq!(commit.frame_type, "checkpoint_commit");
        assert_eq!(commit.body["checkpoint_seq"], "1");
        assert_eq!(commit.body["receipt_through_seq"], "1");
        assert_eq!(commit.body["run_id"], "run");
        assert!(commit.body["signature"].as_str().is_some());

        let _ = service.blocking_send(NodeRequest::Shutdown);
        server.join().unwrap();
    }

    fn test_bootstrap() -> crate::ipc::nodepipe::RunBootstrap {
        crate::ipc::nodepipe::RunBootstrap {
            run_id: "run".into(),
            binding_revision: 1,
            start_nonce: "nonce".into(),
            profile_id: "profile-dev-fixture-v1".into(),
            compat_profile_version: 1,
            tool_manifest_hash: "tmh".into(),
            runtime_digest: "rd".into(),
            model_provider: "device-local".into(),
            model_name: "fixture-model".into(),
            model_config_revision: 1,
            sealed_input_b64: None,
            max_turns: 8,
            max_tokens: 4096,
            max_bytes: 1048576,
            deadline: "2026-11-19T01:00:00Z".into(),
            probe: None,
        }
    }

    #[test]
    fn model_success_records_a_local_device_adapter_turn_and_checkpoint_no_gateway_receipt() {
        let (handle, mut up_rx, server) = journal_server_with_uplinks();
        let ctx = ctx(handle);
        let bootstrap = test_bootstrap();
        let reply = nodemsg::model_response(
            json!({ "role": "assistant", "content": "hi" }),
            "sha256:answer",
            10,
            json!({ "total_tokens": 15 }),
            "req-1",
        );
        let mut cp = 0;
        produce_model_receipt(
            &ctx,
            &bootstrap,
            &json!({ "v": 1 }),
            None,
            "model:0",
            &reply,
            &mut cp,
            &mut String::new(),
        );
        assert_eq!(cp, 1);
        // 乙: the model turn uplinks ONLY a checkpoint_commit (no gateway receipt) at watermark 0 — it
        // consumes no gateway receipt seq, so the tool write receipt that follows is seq 1.
        let commit = up_rx.blocking_recv().unwrap();
        assert_eq!(commit.frame_type, "checkpoint_commit");
        assert_eq!(commit.body["checkpoint_seq"], "1");
        assert_eq!(commit.body["receipt_through_seq"], "0");
        assert!(
            up_rx.try_recv().is_err(),
            "a device_local model turn uplinks no gateway receipt"
        );
        // The device_adapter usage + outcome are sealed into the LOCAL checkpoint plaintext.
        let body = match ctx.journal.request(JournalOp::ReadCheckpoint {
            org_id: "org".into(),
            subject_id: "sub".into(),
            run_id: "run".into(),
            checkpoint_seq: 1,
        }) {
            Some(JournalReply::CheckpointBody(Ok(bytes))) => bytes,
            other => panic!("expected the sealed model turn checkpoint, got {other:?}"),
        };
        let snapshot: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(snapshot["usage_source"], "device_adapter");
        assert_eq!(snapshot["usage"]["total_tokens"], 15);
        assert_eq!(snapshot["result_hash"], "sha256:answer");
        assert_eq!(snapshot["operation_id"], "model:0");
        assert_eq!(
            snapshot["request_hash"],
            model_request_hash(&json!({ "v": 1 }))
        );
        assert_eq!(snapshot["state"], "completed");
        assert_eq!(snapshot["outcome"], "succeeded");
        drop(ctx);
        server.join().unwrap();
    }

    #[test]
    fn model_usage_normalizes_aliases_and_marks_missing_counts_estimated() {
        let usage = model_usage(
            Some(&json!({ "prompt_tokens": 11, "total_tokens": 18 })),
            64,
        );
        assert_eq!(usage.input_tokens, 11);
        assert_eq!(usage.output_tokens, 7);
        assert!(usage.estimated);
        let usage = model_usage(Some(&json!({ "prompt_tokens": 11 })), 64);
        assert_eq!(usage.input_tokens, 11);
        assert_eq!(usage.output_tokens, 64);
        assert!(usage.estimated);
        let usage = model_usage(
            Some(&json!({ "input_tokens": 10, "output_tokens": 5, "cached_input_tokens": 20 })),
            64,
        );
        assert_eq!(usage.cached_input_tokens, 10);
        assert!(usage.estimated);
        let usage = model_usage(None, 64);
        assert_eq!(usage.input_tokens, 0);
        assert_eq!(usage.output_tokens, 64);
        assert!(usage.estimated);
    }

    #[test]
    fn model_permit_is_single_use_like_tool_permits() {
        let (handle, server) = journal_server();
        let ctx = ctx(handle);
        let mut exec = WorkspaceExecutor::new();
        let cmd = DispatchedCommand {
            operation_id: "11111111-1111-1111-1111-111111111111".into(),
            logical_key: "model:0#0".into(),
            tool_name: "model-v1".into(),
            request_hash: "a".repeat(64),
            permit_jti: "jti-model".into(),
            fence: ctx.fence,
            generation: ctx.generation,
            dispatch_attempt_id: "22222222-2222-2222-2222-222222222222".into(),
            permit_deadline: None,
        };
        assert!(matches!(
            exec.register_permit(&ctx, &cmd, &json!({ "v": 1 })),
            PermitGate::Proceed
        ));
        assert!(matches!(
            exec.register_permit(&ctx, &cmd, &json!({ "v": 1 })),
            PermitGate::Consumed
        ));
        drop(ctx);
        server.join().unwrap();
    }

    #[test]
    fn prepared_model_action_is_journaled_before_permit_for_finish_hash_parity() {
        let (handle, server) = journal_server();
        let ctx = ctx(handle);
        let exec = WorkspaceExecutor::new();
        let prepared: crate::frame::action::ActionPreparedBody = serde_json::from_value(json!({
            "operation_id": "11111111-1111-1111-1111-111111111111",
            "logical_key": "model:0#0",
            "step_key": "model:0",
            "supersede_no": "0",
            "state": "waiting_approval",
            "revision": "1",
            "approval_id": "22222222-2222-2222-2222-222222222222",
            "auto_approved": false,
            "request_hash": "a".repeat(64),
            "attempt_id": "33333333-3333-3333-3333-333333333333",
            "checkpoint_seq": "0",
            "classification": "local_only",
            "destination_id": "device_local"
        }))
        .unwrap();
        assert!(exec.register_prepared_action(&ctx, &prepared));
        let row = ctx.journal.request(JournalOp::ReadAction {
            org_id: "org".into(),
            subject_id: "sub".into(),
            operation_id: prepared.operation_id.clone(),
        });
        assert!(matches!(row, Some(JournalReply::Action(Ok(_)))));
        let request = json!({ "args": { "goal": "local-only" } });
        assert!(exec.record_prepared_approval(
            &ctx,
            &prepared,
            "model.send_device_local",
            &request
        ));
        match ctx.journal.request(JournalOp::ReadLocalApproval {
            org_id: "org".into(),
            subject_id: "sub".into(),
            approval_id: prepared.approval_id.clone().unwrap(),
        }) {
            Some(JournalReply::LocalApproval(Ok(Some(body)))) => {
                let document: Value = serde_json::from_slice(&body.bytes).unwrap();
                assert_eq!(document["action"]["request"], request);
                assert_eq!(document["request_hash"], "a".repeat(64));
            }
            other => panic!("approval body was not persisted: {other:?}"),
        }
        drop(ctx);
        server.join().unwrap();
    }

    #[test]
    fn dispatched_model_turn_emits_independent_model_result_then_checkpoint() {
        let (handle, mut up_rx, server) = journal_server_with_uplinks();
        let mut ctx = ctx(handle);
        ctx.run_id = "33333333-3333-3333-3333-333333333333".into();
        let bootstrap = test_bootstrap();
        let request = json!({ "v": 1, "max_tokens": 64 });
        let command = DispatchedCommand {
            operation_id: "11111111-1111-1111-1111-111111111111".into(),
            logical_key: "model:0#0".into(),
            tool_name: "model-v1".into(),
            request_hash: model_request_hash(&request)
                .strip_prefix("sha256:")
                .unwrap()
                .to_string(),
            permit_jti: "jti-model".into(),
            fence: ctx.fence,
            generation: ctx.generation,
            dispatch_attempt_id: "22222222-2222-2222-2222-222222222222".into(),
            permit_deadline: None,
        };
        let reply = nodemsg::model_response(
            json!({ "role": "assistant", "content": "hi" }),
            &"a".repeat(64),
            10,
            json!({
                "prompt_tokens": 11,
                "completion_tokens": 7,
                "cached_tokens": 3
            }),
            "req-1",
        );
        let mut cp = 0;
        produce_model_receipt(
            &ctx,
            &bootstrap,
            &request,
            Some(&command),
            "model:0",
            &reply,
            &mut cp,
            &mut String::new(),
        );
        let result = up_rx.blocking_recv().unwrap();
        assert_eq!(result.frame_type, "model_result");
        assert_eq!(
            result.body["operation_id"],
            "11111111-1111-1111-1111-111111111111"
        );
        assert_eq!(
            result.body["attempt_id"],
            "22222222-2222-2222-2222-222222222222"
        );
        assert_eq!(result.body["request_hash"], command.request_hash);
        assert_eq!(result.body["result_hash"], "a".repeat(64));
        assert_eq!(result.body["model"], "fixture-model");
        assert_eq!(result.body["usage"]["input_tokens"], "11");
        assert_eq!(result.body["usage"]["output_tokens"], "7");
        assert_eq!(result.body["usage"]["cached_input_tokens"], "3");
        assert_eq!(result.body["usage"]["estimated"], false);
        assert!(result.body["signature"].is_string());
        let commit = up_rx.blocking_recv().unwrap();
        assert_eq!(commit.frame_type, "checkpoint_commit");
        assert_eq!(commit.body["receipt_through_seq"], "0");
        assert!(up_rx.try_recv().is_err());
        drop(ctx);
        server.join().unwrap();
    }

    #[test]
    fn model_result_persist_failure_is_fail_closed_and_does_not_checkpoint() {
        let (handle, mut up_rx, server) = journal_server_with_uplinks();
        let mut ctx = ctx(handle);
        ctx.run_id = "33333333-3333-3333-3333-333333333333".into();
        let bootstrap = test_bootstrap();
        let request = json!({ "v": 1 });
        let command = DispatchedCommand {
            operation_id: "11111111-1111-1111-1111-111111111111".into(),
            logical_key: "model:0#0".into(),
            tool_name: "model-v1".into(),
            request_hash: model_request_hash(&request)
                .strip_prefix("sha256:")
                .unwrap()
                .to_string(),
            permit_jti: "jti-model".into(),
            fence: ctx.fence,
            generation: ctx.generation,
            dispatch_attempt_id: "22222222-2222-2222-2222-222222222222".into(),
            permit_deadline: None,
        };
        let reply = nodemsg::model_response(
            json!({ "role": "assistant", "content": "hi" }),
            "not-a-valid-result-hash",
            10,
            json!({ "prompt_tokens": 11, "completion_tokens": 7 }),
            "req-1",
        );
        let mut cp = 0;
        assert!(!produce_model_receipt(
            &ctx,
            &bootstrap,
            &request,
            Some(&command),
            "model:0",
            &reply,
            &mut cp,
            &mut String::new(),
        ));
        assert_eq!(cp, 0);
        assert!(up_rx.try_recv().is_err());
        drop(ctx);
        server.join().unwrap();
    }

    #[test]
    fn model_cancellation_records_a_local_unknown_turn_awaiting_resolution() {
        use std::io::{Read, Write};
        use std::time::Duration;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut exec = WorkspaceExecutor::new();
        let (token, _) = exec.prepare_model(port).unwrap();
        let (probe, _) = listener.accept().unwrap();
        drop(probe);
        exec.confirm_model(
            &token,
            "profile-dev-fixture-v1",
            port,
            ListenerRequirement {
                allowed_signers: vec![],
                allow_user_pinned_hash: true,
                allowed_service_sids: vec![],
            },
            crate::listener::current_user_sid().unwrap(),
            true,
        )
        .unwrap()
        .unwrap();
        let (handle, mut up_rx, server) = journal_server_with_uplinks();
        let ctx = ctx(handle);
        let lease = ctx.io_deadline.clone();
        let endpoint = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                header.push(byte[0]);
                assert!(header.len() < 4096);
            }
            let mut body = [0; 7];
            stream.read_exact(&mut body).unwrap();
            assert_eq!(&body, b"{\"v\":1}");
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n")
                .unwrap();
            *lease.lock().unwrap() = None;
            let mut byte = [0];
            match stream.read(&mut byte) {
                Ok(0) => {}
                Err(err) if err.kind() == std::io::ErrorKind::ConnectionReset => {}
                other => panic!("expected the canceled connection to close, got {other:?}"),
            }
            listener.set_nonblocking(true).unwrap();
            assert_eq!(
                listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
        });
        let bootstrap = test_bootstrap();
        let reply = exec.invoke_model(&ctx, &json!({ "v": 1 }), None);
        assert_eq!(reply["type"], "model_unknown", "{reply}");
        assert_eq!(reply["body"]["reason"], "model_io_unknown");
        endpoint.join().unwrap();
        let mut cp = 0;
        produce_model_receipt(
            &ctx,
            &bootstrap,
            &json!({ "v": 1 }),
            None,
            "model:0",
            &reply,
            &mut cp,
            &mut String::new(),
        );
        let commit = up_rx.blocking_recv().unwrap();
        assert_eq!(commit.frame_type, "checkpoint_commit");
        assert!(
            up_rx.try_recv().is_err(),
            "no gateway receipt for a model turn"
        );
        let body = match ctx.journal.request(JournalOp::ReadCheckpoint {
            org_id: "org".into(),
            subject_id: "sub".into(),
            run_id: "run".into(),
            checkpoint_seq: 1,
        }) {
            Some(JournalReply::CheckpointBody(Ok(bytes))) => bytes,
            other => panic!("expected the sealed model turn checkpoint, got {other:?}"),
        };
        let snapshot: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(snapshot["state"], "unknown");
        assert!(snapshot["outcome"].is_null());
        assert_eq!(snapshot["error_code"], "model_io_unknown");
        drop(ctx);
        server.join().unwrap();
    }

    #[test]
    fn model_identity_refusal_is_rejected_not_executed() {
        let (handle, mut up_rx, server) = journal_server_with_uplinks();
        let ctx = ctx(handle);
        let bootstrap = test_bootstrap();
        let reply = nodemsg::model_blocked("identity_mismatch", true);
        let mut cp = 0;
        produce_model_receipt(
            &ctx,
            &bootstrap,
            &json!({ "v": 1 }),
            None,
            "model:0",
            &reply,
            &mut cp,
            &mut String::new(),
        );
        let commit = up_rx.blocking_recv().unwrap();
        assert_eq!(commit.frame_type, "checkpoint_commit");
        assert!(
            up_rx.try_recv().is_err(),
            "no gateway receipt for a model turn"
        );
        let body = match ctx.journal.request(JournalOp::ReadCheckpoint {
            org_id: "org".into(),
            subject_id: "sub".into(),
            run_id: "run".into(),
            checkpoint_seq: 1,
        }) {
            Some(JournalReply::CheckpointBody(Ok(bytes))) => bytes,
            other => panic!("expected the sealed model turn checkpoint, got {other:?}"),
        };
        let snapshot: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(snapshot["state"], "completed");
        assert_eq!(snapshot["outcome"], "rejected_not_executed");
        assert_eq!(snapshot["error_code"], "identity_mismatch");
        drop(ctx);
        server.join().unwrap();
    }

    #[test]
    fn tool_write_binds_the_command_and_pending_approval_records_nothing() {
        let (handle, mut up_rx, server) = journal_server_with_uplinks();
        let ctx = ctx(handle);
        let bootstrap = test_bootstrap();
        let args = write_args();
        let cmd = DispatchedCommand {
            operation_id: "op-w".into(),
            logical_key: "tool:0:0".into(),
            tool_name: "write-v1".into(),
            request_hash: tool_request_hash(&args).unwrap(),
            permit_jti: "jti".into(),
            fence: 2,
            generation: 1,
            dispatch_attempt_id: "attempt-1".into(),
            permit_deadline: None,
        };
        let ok = nodemsg::tool_result(
            "tc",
            json!({ "written": true }),
            json!({}),
            json!({}),
            false,
            false,
        );
        let mut cp = 0;
        produce_tool_receipt(
            &ctx,
            &bootstrap,
            Some(&cmd),
            tools::ARTIFACT_WRITE,
            &args,
            "tool:0:0",
            &ok,
            &mut cp,
            &mut String::new(),
        );
        assert_eq!(cp, 1);
        let receipt = up_rx.blocking_recv().unwrap();
        assert_eq!(receipt.body["original_execution"]["operation"], "op-w");
        assert_eq!(receipt.body["request_hash"], cmd.request_hash);
        assert_eq!(receipt.body["outcome"], "succeeded");
        let _commit = up_rx.blocking_recv().unwrap();
        // pending_approval pauses the loop: NO receipt, NO checkpoint, the sequence does not advance.
        let pending = nodemsg::tool_blocked("tc", "pending_approval", true, false);
        produce_tool_receipt(
            &ctx,
            &bootstrap,
            Some(&cmd),
            tools::ARTIFACT_WRITE,
            &args,
            "tool:0:1",
            &pending,
            &mut cp,
            &mut String::new(),
        );
        assert_eq!(cp, 1);
        assert!(up_rx.try_recv().is_err());
        drop(ctx);
        server.join().unwrap();
    }

    #[test]
    fn probe_model_hash_uses_the_signed_preview_and_normal_hash_is_bare() {
        let doc = json!({ "v": 1, "messages": ["private user body"] });
        let mut bootstrap = test_bootstrap();
        assert_eq!(
            model_request_hash_for_bootstrap(&doc, &bootstrap),
            model_request_hash(&doc).strip_prefix("sha256:").unwrap()
        );
        bootstrap.probe = Some(crate::ipc::nodepipe::ProbeBootstrap {
            binding_id: "33333333-3333-4333-8333-333333333333".into(),
            probe_id: "44444444-4444-4444-8444-444444444444".into(),
            preview_hash: "a".repeat(64),
            template_hash: crate::sha256_hex(b"device-model-probe-v1"),
        });
        assert_eq!(
            model_request_hash_for_bootstrap(&doc, &bootstrap),
            "a".repeat(64)
        );
    }

    #[test]
    fn model_request_hash_is_an_independent_kind_and_stable_across_key_order() {
        let doc = json!({ "v": 1, "binding": { "run": "run", "logical_key": "model:0" } });
        let reordered = json!({ "binding": { "logical_key": "model:0", "run": "run" }, "v": 1 });
        let h = model_request_hash(&doc);
        assert!(h.starts_with("sha256:"));
        assert_eq!(h, model_request_hash(&reordered));
        // The independent kind separates it from the bare canonical document hash (§5.1, DD:57).
        assert_ne!(h, canonical_hash(&doc));
    }
}
