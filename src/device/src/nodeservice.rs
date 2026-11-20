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
}

/// The live per-Run command map (A2 write spine, execution-face §6.3 C). The sync core inserts a
/// command the moment `consume_command` verifies + jti-registers it (mid-Run); the executor reads it
/// per tool_call. This is NOT the journal (E4 甲 single-owner holds): it is a dispatch inbox shared
/// across the two threads, so a write command authorized AFTER start still reaches the running loop.
pub type SharedCommands = Arc<Mutex<HashMap<String, DispatchedCommand>>>;

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
    /// The local_input_refs staged through `stageLocalInput` (§1.1), carried into run_bootstrap's
    /// sealed_input_refs so Node reads the input正文 only through the pipe (DD:194).
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

    // ---- confirmation flow (device-side half; the dialog UI is the shell's) ----

    /// Bind a root and produce the confirmation request, holding the handle under a token. The shell
    /// shows the dialog; [`confirm_root`] registers on approve or drops on cancel (no grant).
    pub fn prepare_root(
        &mut self,
        selected_path: &str,
    ) -> Result<(String, RootConfirmation), ExecError> {
        let (root, confirmation) =
            crate::grant::prepare_root_confirmation(selected_path).map_err(|e| match e {
                crate::grant::GrantError::Root(err) => err,
                _ => ExecError::Io,
            })?;
        let token = uuid::Uuid::new_v4().to_string();
        self.pending_roots.insert(token.clone(), root);
        Ok((token, confirmation))
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
    pub fn invoke_model(&self, ctx: &RunContext, request_doc: &Value) -> Value {
        let entry = match self.endpoints.get(&ctx.profile_id) {
            Some(entry) => entry,
            None => return nodemsg::model_blocked("model_binding_missing", true),
        };
        match modelproxy::invoke(&entry.endpoint, request_doc) {
            Ok(reply) => nodemsg::model_response(
                reply.assistant_message,
                &reply.answer_hash,
                reply.answer_bytes,
                reply.usage,
                &reply.provider_request_id,
            ),
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
        // 4. Handle-relative execution.
        match self.run_tool(&grant_id, tool_name, args) {
            Ok(content) => nodemsg::tool_result(
                tool_call_id,
                content.clone(),
                content,
                json!({}),
                false,
                false,
            ),
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

    /// The handle-relative execution of one validated tool against its confirmed grant.
    fn run_tool(
        &mut self,
        grant_id: &str,
        tool_name: &str,
        args: &Value,
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
                let chain = tool_exec::walk(&entry.root, &segments, true)?;
                let listing = tool_exec::list_dir(&chain)?;
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
                let chain = tool_exec::walk(&grant.root, &segments, false)?;
                // expected_identity binds the file ID Node was given at list time; the opened object
                // must still be that same object (a swap since list is source_changed, never new bytes).
                let listed_id = mapped.file_id.to_string();
                if !expected_identity.is_empty() && expected_identity != listed_id {
                    return Err(ExecError::SourceChanged);
                }
                if chain.identity.file_id != mapped.file_id {
                    return Err(ExecError::SourceChanged);
                }
                let sealed = tool_exec::read_sealed(&chain, max_bytes)?;
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
                let result = tool_exec::search(&entry.root, &segments, query, limit)?;
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
                let dir_chain = tool_exec::walk(&entry.root, &entry.artifact_dir, true)?;
                let id = tool_exec::write_artifact_new(
                    &dir_chain,
                    &file_name,
                    &sealed,
                    content_hash,
                    byte_count,
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
        _ => ("io_unknown", true),
    };
    nodemsg::tool_blocked(tool_call_id, reason, false, is_error)
}

/// A request to the long-lived Node service thread. Confirmations and body sealing carry owned (Send)
/// data; the `!Send` root handles stay on the thread. `StartRun` brings up one Run's pipe loop.
pub enum NodeRequest {
    PrepareRoot {
        selected_path: String,
        reply: tokio::sync::oneshot::Sender<Result<(String, RootConfirmation), String>>,
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
    SealBody {
        body_ref: String,
        bytes: Vec<u8>,
    },
    /// §1.1 stageLocalInput: seal the Composer text, return (local_input_ref, content_hash, byte_count).
    StageInput {
        text: String,
        reply: tokio::sync::oneshot::Sender<(String, String, u64)>,
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
        while let Some(req) = rx.blocking_recv() {
            match req {
                NodeRequest::PrepareRoot {
                    selected_path,
                    reply,
                } => {
                    let r = exec
                        .prepare_root(&selected_path)
                        .map_err(|e| format!("{e:?}"));
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
                NodeRequest::SealBody { body_ref, bytes } => exec.seal_body(body_ref, bytes),
                NodeRequest::StageInput { text, reply } => {
                    let _ = reply.send(exec.stage_input(&text));
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
                    // The staged input refs are owned here (the executor sealed them); carry them into
                    // the bootstrap so Node reads the input正文 only through the pipe (§6.3/DD:194).
                    let mut bootstrap = bootstrap;
                    bootstrap.sealed_input_refs = exec.staged_input_refs.clone();
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
        let value: Value =
            serde_json::from_slice(&raw).map_err(|e| format!("node frame json: {e}"))?;
        let ty = value["type"].as_str().ok_or("node frame missing type")?;
        let body = &value["body"];
        nodemsg::validate_body(ty, body).map_err(|e| format!("node body {ty}: {e:?}"))?;
        let reply = match ty {
            nodemsg::MODEL_REQUEST => {
                let logical_key = body["logical_key"].as_str().unwrap_or("");
                let reply = exec.invoke_model(ctx, &body["request"]);
                produce_model_receipt(
                    ctx,
                    bootstrap,
                    &body["request"],
                    logical_key,
                    &reply,
                    &mut checkpoint_seq,
                    &mut latest_checkpoint_hash,
                );
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
                    args,
                    logical_key,
                    &reply,
                    &mut checkpoint_seq,
                    &mut latest_checkpoint_hash,
                );
                reply
            }
            nodemsg::LOOP_END => break,
            // capability_refresh is Broker→Node; any other Node→Broker type is a protocol violation.
            other => return Err(format!("unexpected Node frame type {other}")),
        };
        let bytes = serde_json::to_vec(&reply).map_err(|e| format!("reply encode: {e}"))?;
        conn.write_frame(&bytes)
            .map_err(|e| format!("node write: {e:?}"))?;
    }
    Ok(())
}

/// How long the executor waits for a write command downlink after proposing action_prepare. The
/// server parks an ask_each write for approval; the shell decides it through the REST face and the
/// next heartbeat claim dispatches the command. The wait bounds the loop so a never-decided approval
/// terminates the batch (pending_approval) rather than hanging the sidecar.
const COMMAND_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

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
    let args_hash = crate::sha256_hex(&crate::frame::jcs::canonicalize(args).unwrap_or_default());
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
        resource_selector_hash: args_hash,
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
    while std::time::Instant::now() < deadline {
        if let Some(cmd) = commands.lock().unwrap().get(server_key).cloned() {
            return Some(cmd);
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

/// The `local_model_request` v1 request hash: an independent-kind canonical document hash (§5.1).
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

/// Produce the model-turn receipt (§6.3 B). device_local usage is stamped `usage_source='device_adapter'`
/// with no egress fields (DD:264). success→completed/succeeded; an I/O unknown→unknown (awaits
/// operation_resolution, §5.3); an identity/binding refusal→completed/rejected_not_executed (no byte
/// sent, §5.4 step 4); an endpoint refusal→completed/failed (the model produced no answer).
fn produce_model_receipt(
    ctx: &RunContext,
    bootstrap: &crate::ipc::nodepipe::RunBootstrap,
    request_doc: &Value,
    logical_key: &str,
    reply: &Value,
    checkpoint_seq: &mut i64,
    latest_checkpoint_hash: &mut String,
) {
    let ty = reply["type"].as_str().unwrap_or("");
    let body = &reply["body"];
    let request_hash = model_request_hash(request_doc);
    let local_ref = format!("{}:{}", ctx.run_id, logical_key);
    let facts = match ty {
        nodemsg::MODEL_RESPONSE => ReceiptFacts {
            operation_id: logical_key.to_string(),
            run_id: ctx.run_id.clone(),
            session_id: ctx.session_id.clone(),
            generation: ctx.generation,
            attempt: logical_key.to_string(),
            fence: ctx.fence,
            request_hash,
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
            operation_id: logical_key.to_string(),
            run_id: ctx.run_id.clone(),
            session_id: ctx.session_id.clone(),
            generation: ctx.generation,
            attempt: logical_key.to_string(),
            fence: ctx.fence,
            request_hash,
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
                operation_id: logical_key.to_string(),
                run_id: ctx.run_id.clone(),
                session_id: ctx.session_id.clone(),
                generation: ctx.generation,
                attempt: logical_key.to_string(),
                fence: ctx.fence,
                request_hash,
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
        _ => return,
    };
    record_model_turn(
        ctx,
        bootstrap,
        facts,
        logical_key,
        checkpoint_seq,
        latest_checkpoint_hash,
    );
}

/// Produce the tool-call receipt (§6.3 C). A write binds the dispatched command's operation_id +
/// request_hash; a read uses the Run-unique logical_key + the canonical args hash. success→completed/
/// succeeded; an isError result→completed/failed; a side-effect unknown (io_unknown/tool_unknown)→
/// unknown (replay:'never', awaits resolution DD:104); pending_approval records NOTHING (the action
/// awaits a future command, no execution decision yet); any other refusal→completed/rejected_not_executed.
#[allow(clippy::too_many_arguments)]
fn produce_tool_receipt(
    ctx: &RunContext,
    bootstrap: &crate::ipc::nodepipe::RunBootstrap,
    cmd: Option<&DispatchedCommand>,
    args: &Value,
    logical_key: &str,
    reply: &Value,
    checkpoint_seq: &mut i64,
    latest_checkpoint_hash: &mut String,
) {
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
                let r = crate::journalop::execute(&journal, &producer, op);
                let _ = reply.send(r);
            }
            drop(journal);
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_file(path.with_extension("db-wal"));
            let _ = std::fs::remove_file(path.with_extension("db-shm"));
        });
        (handle, up_rx, server)
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
        }
    }

    fn executor_with_grant(tmp: &TempDir) -> WorkspaceExecutor {
        let mut exec = WorkspaceExecutor::new();
        let (token, _conf) = exec.prepare_root(tmp.path()).unwrap();
        exec.confirm_root(&token, "g1", vec!["out".into()], true)
            .unwrap();
        exec
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
        let (handle, server) = journal_server();
        let ctx = ctx(handle);
        let cmd = DispatchedCommand {
            operation_id: "op-1".into(),
            logical_key: "tool:0:0".into(),
            tool_name: "artifact.write".into(),
            request_hash: "sha256:req".into(),
            permit_jti: "jti-1".into(),
            fence: 2,
            generation: 1,
            dispatch_attempt_id: "attempt-1".into(),
        };
        let args = json!({
            "grant_id": "g1", "artifact_id": "a", "version_id": "v1", "format": "md",
            "body_ref": "body-1", "content_hash": sealed.hash(), "byte_count": "13"
        });
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
            sealed_input_refs: vec!["buf-1".into()],
            max_turns: 8,
            max_tokens: 4096,
            max_bytes: 1048576,
            deadline: "2026-11-19T01:00:00Z".into(),
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
            tool_name: "artifact.write".into(),
            request_hash: "sha256:req".into(),
            permit_jti: "jti-1".into(),
            fence: 2,
            generation: 1,
            dispatch_attempt_id: "attempt-1".into(),
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
        let (handle, server) = journal_server();
        let ctx = ctx(handle);
        let cmd = DispatchedCommand {
            operation_id: "op-1".into(),
            logical_key: "tool:0:0".into(),
            tool_name: "artifact.write".into(),
            request_hash: "sha256:req".into(),
            permit_jti: "jti-1".into(),
            fence: 2,
            generation: 1,
            dispatch_attempt_id: "attempt-1".into(),
        };
        let args = json!({
            "grant_id": "g1", "artifact_id": "a", "version_id": "v1", "format": "md",
            "body_ref": input_ref, "content_hash": content_hash, "byte_count": byte_count.to_string()
        });
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
        let reply = exec.invoke_model(&ctx, &json!({ "v": 1, "messages": [] }));
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
        // Provision a confirmed grant through the thread (the confirmation flow).
        let (rtx, rrx) = tokio::sync::oneshot::channel();
        service
            .blocking_send(NodeRequest::PrepareRoot {
                selected_path: tmp.path().to_string(),
                reply: rtx,
            })
            .unwrap();
        let (token, _conf) = rrx.blocking_recv().unwrap().unwrap();
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

        let (handle, mut up_rx, server) = journal_server_with_uplinks();
        let run_ctx = ctx(handle);
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
                    "body": { "transcript_final": { "messages": [] }, "turn_count": "1" }
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
            sealed_input_refs: vec![],
            max_turns: 8,
            max_tokens: 4096,
            max_bytes: 1048576,
            deadline: "2026-11-19T01:00:00Z".into(),
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
            sealed_input_refs: vec![],
            max_turns: 8,
            max_tokens: 4096,
            max_bytes: 1048576,
            deadline: "2026-11-19T01:00:00Z".into(),
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
        assert_eq!(snapshot["state"], "completed");
        assert_eq!(snapshot["outcome"], "succeeded");
        drop(ctx);
        server.join().unwrap();
    }

    #[test]
    fn model_unknown_records_a_local_unknown_turn_awaiting_resolution() {
        let (handle, mut up_rx, server) = journal_server_with_uplinks();
        let ctx = ctx(handle);
        let bootstrap = test_bootstrap();
        let reply = nodemsg::model_unknown("model_io_unknown");
        let mut cp = 0;
        produce_model_receipt(
            &ctx,
            &bootstrap,
            &json!({ "v": 1 }),
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
        let cmd = DispatchedCommand {
            operation_id: "op-w".into(),
            logical_key: "tool:0:0".into(),
            tool_name: "artifact.write".into(),
            request_hash: "sha256:cmd".into(),
            permit_jti: "jti".into(),
            fence: 2,
            generation: 1,
            dispatch_attempt_id: "attempt-1".into(),
        };
        let args = json!({ "grant_id": "g1", "relative_path": "out/a.txt" });
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
            &args,
            "tool:0:0",
            &ok,
            &mut cp,
            &mut String::new(),
        );
        assert_eq!(cp, 1);
        let receipt = up_rx.blocking_recv().unwrap();
        assert_eq!(receipt.body["original_execution"]["operation"], "op-w");
        assert_eq!(receipt.body["request_hash"], "sha256:cmd");
        assert_eq!(receipt.body["outcome"], "succeeded");
        let _commit = up_rx.blocking_recv().unwrap();
        // pending_approval pauses the loop: NO receipt, NO checkpoint, the sequence does not advance.
        let pending = nodemsg::tool_blocked("tc", "pending_approval", true, false);
        produce_tool_receipt(
            &ctx,
            &bootstrap,
            Some(&cmd),
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
