//! The Node↔Broker named pipe (execution-face design §6.1, DD:20). This is a SEPARATE pipe
//! instance from the shell→Broker channel ([`crate::ipc::pipe`]) with a separate ACL and message
//! set: the DACL grants only the Run's AppContainer SID, and the PID predicate is the sidecar
//! process id recorded at spawn (not the shell PID). The one-time handshake declares
//! `client_kind="node"`; a shell client on this instance is refused. After the handshake the
//! Broker sends `run_bootstrap` (§6.3 family A); the model/tool families are batch 2.
//!
//! Node is untrusted (DD:17/20): it holds no root handle, journal, CNG key, provider key or
//! network capability. The AppContainer + Job Object + Node `--permission` model carry the
//! capability boundary; this pipe is the only channel back to the Broker.

use std::ffi::c_void;

use serde_json::{json, Value};
use windows::core::{HRESULT, PCWSTR};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_PIPE_CONNECTED, GENERIC_ALL, HANDLE, INVALID_HANDLE_VALUE,
};
use windows::Win32::Security::{
    AddAccessAllowedAce, EqualSid, GetLengthSid, GetTokenInformation, InitializeAcl,
    InitializeSecurityDescriptor, SetSecurityDescriptorDacl, TokenUser, ACL, ACL_REVISION,
    PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
};
use windows::Win32::Storage::FileSystem::{
    FlushFileBuffers, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX,
};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
    PIPE_READMODE_MESSAGE, PIPE_TYPE_MESSAGE, PIPE_WAIT,
};
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::ipc::frame;
use crate::ipc::handshake::{self, ClientKind, Handshake};

/// A Node-pipe failure. The closed vocabulary mirrors the shell pipe's, plus the Node-specific
/// kind refusal (a shell client on the Node instance).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NodePipeError {
    Create,
    Acl,
    Connect,
    Auth,
    SidMismatch,
    SessionMismatch,
    /// The client is not the sidecar process this Run spawned.
    PidMismatch,
    Io,
    Frame,
    Handshake,
    /// The handshake declared a client kind other than `node`.
    WrongKind,
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

struct SecurityBuffers {
    _acl: Vec<u8>,
    sd: Vec<u8>,
}

/// Build a DACL granting only the AppContainer SID GENERIC_ALL.
unsafe fn build_security(sid: &[u8]) -> Result<SecurityBuffers, NodePipeError> {
    let mut acl = vec![0u8; 1024];
    let acl_ptr = acl.as_mut_ptr() as *mut ACL;
    InitializeAcl(acl_ptr, acl.len() as u32, ACL_REVISION).map_err(|_| NodePipeError::Acl)?;
    AddAccessAllowedAce(
        acl_ptr,
        ACL_REVISION,
        GENERIC_ALL.0,
        PSID(sid.as_ptr() as *mut c_void),
    )
    .map_err(|_| NodePipeError::Acl)?;
    let mut sd = vec![0u8; 64];
    let sd_ptr = sd.as_mut_ptr() as *mut c_void;
    InitializeSecurityDescriptor(PSECURITY_DESCRIPTOR(sd_ptr), 1)
        .map_err(|_| NodePipeError::Acl)?;
    SetSecurityDescriptorDacl(
        PSECURITY_DESCRIPTOR(sd_ptr),
        true,
        Some(acl_ptr as *const ACL),
        false,
    )
    .map_err(|_| NodePipeError::Acl)?;
    Ok(SecurityBuffers { _acl: acl, sd })
}

unsafe fn token_user_sid(token: HANDLE) -> Result<Vec<u8>, NodePipeError> {
    let mut len: u32 = 0;
    let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
    if len == 0 {
        return Err(NodePipeError::Auth);
    }
    let mut buf = vec![0u8; len as usize];
    GetTokenInformation(
        token,
        TokenUser,
        Some(buf.as_mut_ptr() as *mut c_void),
        len,
        &mut len,
    )
    .map_err(|_| NodePipeError::Auth)?;
    let user = &*(buf.as_ptr() as *const TOKEN_USER);
    let sid = user.User.Sid;
    let sid_len = GetLengthSid(sid) as usize;
    Ok(std::slice::from_raw_parts(sid.0 as *const u8, sid_len).to_vec())
}

unsafe fn process_sid(pid: u32) -> Result<Vec<u8>, NodePipeError> {
    let proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
        .map_err(|_| NodePipeError::Auth)?;
    let mut token = HANDLE::default();
    let result = OpenProcessToken(proc, TOKEN_QUERY, &mut token)
        .map_err(|_| NodePipeError::Auth)
        .and_then(|()| token_user_sid(token));
    let _ = CloseHandle(token);
    let _ = CloseHandle(proc);
    result
}

fn session_id(pid: u32) -> Result<u32, NodePipeError> {
    let mut session: u32 = 0;
    unsafe {
        ProcessIdToSessionId(pid, &mut session).map_err(|_| NodePipeError::Auth)?;
    }
    Ok(session)
}

/// A Node↔Broker pipe instance bound to one Run's AppContainer SID and spawned sidecar PID.
pub struct NodePipeServer {
    handle: HANDLE,
    expected_sid: Vec<u8>,
    expected_session: u32,
    expected_pid: u32,
}

impl NodePipeServer {
    /// Create the per-Run pipe. `container_sid` is the AppContainer SID the sidecar token carries
    /// (the only SID granted by the DACL); `sidecar_pid` is the process id recorded at spawn.
    pub fn create(
        name: &str,
        container_sid: &[u8],
        sidecar_pid: u32,
    ) -> Result<Self, NodePipeError> {
        unsafe {
            let expected_session = session_id(GetCurrentProcessId())?;
            let sec = build_security(container_sid)?;
            let sa = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: sec.sd.as_ptr() as *mut c_void,
                bInheritHandle: false.into(),
            };
            let name_w = wide(name);
            let handle = CreateNamedPipeW(
                PCWSTR(name_w.as_ptr()),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
                1,
                (frame::MAX_FRAME_BYTES + frame::LENGTH_PREFIX) as u32,
                (frame::MAX_FRAME_BYTES + frame::LENGTH_PREFIX) as u32,
                0,
                Some(&sa),
            );
            if handle == INVALID_HANDLE_VALUE {
                return Err(NodePipeError::Create);
            }
            Ok(Self {
                handle,
                expected_sid: container_sid.to_vec(),
                expected_session,
                expected_pid: sidecar_pid,
            })
        }
    }

    /// Block until the sidecar connects, then verify PID/SID/login-session. The PID predicate is
    /// the recorded spawn fact; the SID predicate binds the AppContainer the DACL already granted.
    pub fn accept(&self) -> Result<NodePipeConnection, NodePipeError> {
        unsafe {
            match ConnectNamedPipe(self.handle, None) {
                Ok(()) => {}
                Err(e) if e.code() == HRESULT::from_win32(ERROR_PIPE_CONNECTED.0) => {}
                Err(_) => return Err(NodePipeError::Connect),
            }
            let mut pid: u32 = 0;
            GetNamedPipeClientProcessId(self.handle, &mut pid).map_err(|_| NodePipeError::Auth)?;
            if pid != self.expected_pid {
                let _ = DisconnectNamedPipe(self.handle);
                return Err(NodePipeError::PidMismatch);
            }
            let client_sid = process_sid(pid)?;
            let sid_ok = EqualSid(
                PSID(client_sid.as_ptr() as *mut c_void),
                PSID(self.expected_sid.as_ptr() as *mut c_void),
            )
            .is_ok();
            if !sid_ok {
                let _ = DisconnectNamedPipe(self.handle);
                return Err(NodePipeError::SidMismatch);
            }
            if session_id(pid)? != self.expected_session {
                let _ = DisconnectNamedPipe(self.handle);
                return Err(NodePipeError::SessionMismatch);
            }
            Ok(NodePipeConnection {
                handle: self.handle,
            })
        }
    }
}

impl Drop for NodePipeServer {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

/// An authenticated Node connection on the server's pipe handle.
pub struct NodePipeConnection {
    handle: HANDLE,
}

impl NodePipeConnection {
    pub fn write_frame(&self, payload: &[u8]) -> Result<(), NodePipeError> {
        let bytes = frame::encode(payload).map_err(|_| NodePipeError::Frame)?;
        let mut written: u32 = 0;
        unsafe {
            WriteFile(
                self.handle,
                Some(bytes.as_slice()),
                Some(&mut written),
                None,
            )
            .map_err(|_| NodePipeError::Io)?;
        }
        Ok(())
    }

    pub fn read_frame(&self) -> Result<Vec<u8>, NodePipeError> {
        let mut buf = vec![0u8; frame::MAX_FRAME_BYTES + frame::LENGTH_PREFIX];
        let mut read: u32 = 0;
        unsafe {
            ReadFile(self.handle, Some(buf.as_mut_slice()), Some(&mut read), None)
                .map_err(|_| NodePipeError::Io)?;
        }
        buf.truncate(read as usize);
        let payload = frame::decode(&buf).map_err(|_| NodePipeError::Frame)?;
        Ok(payload.to_vec())
    }

    /// Run the one-time Node handshake: write the server hello, read the client hello, require
    /// `client_kind="node"`, verify nonce + protocol major. Single-use (the Handshake enforces it).
    pub fn handshake_node(&self) -> Result<(), NodePipeError> {
        let mut hs = Handshake::new();
        let server_hello =
            serde_json::to_vec(&hs.server_hello()).map_err(|_| NodePipeError::Frame)?;
        self.write_frame(&server_hello)?;
        let raw = self.read_frame()?;
        let value: Value = serde_json::from_slice(&raw).map_err(|_| NodePipeError::Handshake)?;
        let hello = handshake::parse_client_hello(&value).map_err(|_| NodePipeError::Handshake)?;
        if hello.client_kind != ClientKind::Node {
            return Err(NodePipeError::WrongKind);
        }
        hs.verify(&hello).map_err(|_| NodePipeError::Handshake)?;
        Ok(())
    }

    /// Send the one-time `run_bootstrap` (§6.3 family A). Node initializes its Agent from this and
    /// does NOT auto-call the model (DD:113); the model/tool families are batch 2.
    pub fn send_bootstrap(&self, bootstrap: &RunBootstrap) -> Result<(), NodePipeError> {
        let frame_value = json!({ "type": "run_bootstrap", "body": bootstrap.to_value() });
        let bytes = serde_json::to_vec(&frame_value).map_err(|_| NodePipeError::Frame)?;
        self.write_frame(&bytes)
    }
}

impl Drop for NodePipeConnection {
    fn drop(&mut self) {
        unsafe {
            // Flush before disconnect so a refusal reaches Node before the pipe breaks (the same
            // GW18 boundary the shell pipe documents).
            let _ = FlushFileBuffers(self.handle);
            let _ = DisconnectNamedPipe(self.handle);
        }
    }
}

/// The `run_bootstrap` body (§6.3 family A, closed). The model route carries provider/model/
/// config_revision but NO endpoint URL — the Broker holds the endpoint (§5.3). Sealed input buffer
/// refs point at Broker-sealed bodies Node only reads (DD:194). Bounds and deadline cap the loop.
#[derive(Clone, Debug)]
pub struct RunBootstrap {
    pub run_id: String,
    pub binding_revision: u64,
    pub start_nonce: String,
    pub profile_id: String,
    pub compat_profile_version: u64,
    pub tool_manifest_hash: String,
    pub runtime_digest: String,
    pub model_provider: String,
    pub model_name: String,
    pub model_config_revision: u64,
    pub sealed_input_refs: Vec<String>,
    pub max_turns: u64,
    pub max_tokens: u64,
    pub max_bytes: u64,
    pub deadline: String,
}

impl RunBootstrap {
    pub fn to_value(&self) -> Value {
        json!({
            "run_id": self.run_id,
            "binding_revision": self.binding_revision.to_string(),
            "start_nonce": self.start_nonce,
            "profile_id": self.profile_id,
            "compat_profile_version": self.compat_profile_version.to_string(),
            "tool_manifest_hash": self.tool_manifest_hash,
            "runtime_digest": self.runtime_digest,
            "model_route": {
                "provider": self.model_provider,
                "model": self.model_name,
                "config_revision": self.model_config_revision.to_string(),
            },
            "sealed_input_refs": self.sealed_input_refs,
            "max_turns": self.max_turns.to_string(),
            "max_tokens": self.max_tokens.to_string(),
            "max_bytes": self.max_bytes.to_string(),
            "deadline": self.deadline,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_NONE, OPEN_EXISTING,
    };
    use windows::Win32::System::Threading::GetCurrentProcess;

    fn unique_name() -> String {
        format!(
            "\\\\.\\pipe\\work-device-node-test-{}",
            uuid::Uuid::new_v4()
        )
    }

    fn current_sid() -> Vec<u8> {
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).unwrap();
            let sid = token_user_sid(token).unwrap();
            let _ = CloseHandle(token);
            sid
        }
    }

    fn bootstrap() -> RunBootstrap {
        RunBootstrap {
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

    #[test]
    fn bootstrap_body_is_closed_and_carries_no_endpoint_url() {
        let value = bootstrap().to_value();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(|s| s.as_str())
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "binding_revision",
                "compat_profile_version",
                "deadline",
                "max_bytes",
                "max_tokens",
                "max_turns",
                "model_route",
                "profile_id",
                "run_id",
                "runtime_digest",
                "sealed_input_refs",
                "start_nonce",
                "tool_manifest_hash",
            ]
        );
        // The model route carries provider/model/config_revision but NEVER an endpoint URL (§5.3).
        let route = &value["model_route"];
        assert_eq!(route["provider"], "device-local");
        assert!(route.get("endpoint").is_none() && route.get("base_url").is_none());
        assert!(value.get("endpoint").is_none());
        // u64 members are decimal strings (the wire convention).
        assert_eq!(value["binding_revision"], "1");
        assert_eq!(value["max_turns"], "8");
    }

    /// Drive one client connection: read the server hello, echo a client hello of `kind`, then read
    /// whatever the server sends next (the bootstrap on accept). Returns the next frame's bytes.
    fn client_exchange(name: &str, kind: &str) -> Vec<u8> {
        let name_w = wide(name);
        unsafe {
            let handle = CreateFileW(
                PCWSTR(name_w.as_ptr()),
                GENERIC_READ.0 | GENERIC_WRITE.0,
                FILE_SHARE_NONE,
                None,
                OPEN_EXISTING,
                FILE_FLAGS_AND_ATTRIBUTES(0),
                None,
            )
            .expect("client connect");
            let mut buf = vec![0u8; frame::MAX_FRAME_BYTES + frame::LENGTH_PREFIX];
            let mut read: u32 = 0;
            // A PID-refused connection is disconnected before any server hello; treat a failed
            // first read as "no exchange" rather than panicking the client thread.
            if ReadFile(handle, Some(buf.as_mut_slice()), Some(&mut read), None).is_err()
                || read == 0
            {
                let _ = CloseHandle(handle);
                return Vec::new();
            }
            buf.truncate(read as usize);
            let hello_payload = frame::decode(&buf).expect("decode server hello");
            let server_hello: Value = serde_json::from_slice(hello_payload).unwrap();
            let client_hello = json!({
                "nonce": server_hello["nonce"],
                "protocol_major": server_hello["protocol_major"],
                "client_kind": kind,
            });
            let bytes = frame::encode(&serde_json::to_vec(&client_hello).unwrap()).unwrap();
            WriteFile(handle, Some(bytes.as_slice()), Some(&mut read), None)
                .expect("write client hello");
            // Read the next frame (bootstrap). On a kind refusal the server disconnects; read fails
            // or returns zero, which the caller treats as no bootstrap.
            let mut buf2 = vec![0u8; frame::MAX_FRAME_BYTES + frame::LENGTH_PREFIX];
            let mut read2: u32 = 0;
            let mut out = Vec::new();
            if ReadFile(handle, Some(buf2.as_mut_slice()), Some(&mut read2), None).is_ok()
                && read2 > 0
            {
                buf2.truncate(read2 as usize);
                if let Ok(payload) = frame::decode(&buf2) {
                    out = payload.to_vec();
                }
            }
            let _ = CloseHandle(handle);
            out
        }
    }

    #[test]
    fn a_node_client_handshakes_and_receives_bootstrap() {
        let name = unique_name();
        let pid = unsafe { GetCurrentProcessId() };
        let server = NodePipeServer::create(&name, &current_sid(), pid).expect("create node pipe");
        let client_name = name.clone();
        let client = std::thread::spawn(move || client_exchange(&client_name, "node"));
        let conn = server.accept().expect("accept sidecar");
        conn.handshake_node().expect("node handshake");
        conn.send_bootstrap(&bootstrap()).expect("send bootstrap");
        let received = client.join().unwrap();
        let value: Value = serde_json::from_slice(&received).expect("bootstrap frame");
        assert_eq!(value["type"], "run_bootstrap");
        assert_eq!(value["body"]["run_id"], "run");
        drop(conn);
    }

    #[test]
    fn a_shell_client_on_the_node_instance_is_refused() {
        let name = unique_name();
        let pid = unsafe { GetCurrentProcessId() };
        let server = NodePipeServer::create(&name, &current_sid(), pid).expect("create node pipe");
        let client_name = name.clone();
        let client = std::thread::spawn(move || client_exchange(&client_name, "shell"));
        let conn = server.accept().expect("accept sidecar");
        assert_eq!(conn.handshake_node(), Err(NodePipeError::WrongKind));
        // Drop the connection BEFORE joining: the client is parked reading a bootstrap that a
        // refused kind never sends, so the disconnect is what unblocks it.
        drop(conn);
        let received = client.join().unwrap();
        assert!(
            received.is_empty(),
            "a refused kind must receive no bootstrap"
        );
    }

    #[test]
    fn a_client_that_is_not_the_spawned_sidecar_pid_is_refused() {
        let name = unique_name();
        let pid = unsafe { GetCurrentProcessId() };
        // The connecting client is this process; any other expected PID refuses it.
        let server = NodePipeServer::create(&name, &current_sid(), pid.wrapping_add(1))
            .expect("create node pipe");
        let client_name = name.clone();
        let client = std::thread::spawn(move || client_exchange(&client_name, "node"));
        assert_eq!(server.accept().err(), Some(NodePipeError::PidMismatch));
        let _ = client.join();
    }
}
