//! Windows named-pipe server and client authentication (device-design §1: "受 ACL
//! 保护的命名管道交互；管道客户端 token/SID、登录会话、PID、一次性握手 nonce 和
//! 协议 major 都须匹配"). The pipe DACL grants only the current user SID; on
//! accept the server verifies the client's PID against the configured shell PID,
//! then its token SID and login session against the Broker's own user/session.
//! The one-time nonce/protocol handshake ([`crate::ipc::handshake`]) runs over the
//! framed channel after OS auth.
//!
//! The shell→Broker and Node→Broker channels are separate pipe instances with
//! separate ACL/message sets; the AppContainer per-Run ACL lands with the sidecar
//! batch.

use std::ffi::c_void;

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
    GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::ipc::frame;

/// A pipe/auth failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PipeError {
    Create,
    Acl,
    Connect,
    Auth,
    SidMismatch,
    SessionMismatch,
    /// The client process is not the shell the Broker was configured to serve (M2 ruling:
    /// only the main process may deliver tickets/certificates). Same-user is not enough —
    /// any process of the logged-in user passes the SID gate, so the configured shell PID
    /// is the predicate that keeps a same-user impostor off the privileged message set.
    PidMismatch,
    Io,
    Frame,
    /// The one-time handshake was refused (nonce, protocol major, client kind or replay).
    Handshake,
    /// The ticket pump is gone, so there is nobody to hand a delivery to or to answer from.
    Broker,
}

/// Read the user SID bytes from a process token.
///
/// # Safety
/// `token` must be a valid token handle with TOKEN_QUERY access.
unsafe fn token_user_sid(token: HANDLE) -> Result<Vec<u8>, PipeError> {
    let mut len: u32 = 0;
    // First call sizes the buffer (expected to fail with insufficient buffer).
    let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
    if len == 0 {
        return Err(PipeError::Auth);
    }
    let mut buf = vec![0u8; len as usize];
    GetTokenInformation(
        token,
        TokenUser,
        Some(buf.as_mut_ptr() as *mut c_void),
        len,
        &mut len,
    )
    .map_err(|_| PipeError::Auth)?;
    let user = &*(buf.as_ptr() as *const TOKEN_USER);
    let sid = user.User.Sid;
    let sid_len = GetLengthSid(sid) as usize;
    Ok(std::slice::from_raw_parts(sid.0 as *const u8, sid_len).to_vec())
}

/// The current process user's SID bytes.
unsafe fn current_user_sid() -> Result<Vec<u8>, PipeError> {
    let mut token = HANDLE::default();
    OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).map_err(|_| PipeError::Auth)?;
    let result = token_user_sid(token);
    let _ = CloseHandle(token);
    result
}

/// The user SID bytes of another process (by PID).
unsafe fn process_sid(pid: u32) -> Result<Vec<u8>, PipeError> {
    let proc =
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).map_err(|_| PipeError::Auth)?;
    let mut token = HANDLE::default();
    let result = OpenProcessToken(proc, TOKEN_QUERY, &mut token)
        .map_err(|_| PipeError::Auth)
        .and_then(|()| token_user_sid(token));
    let _ = CloseHandle(token);
    let _ = CloseHandle(proc);
    result
}

/// The login session of a process.
fn session_id(pid: u32) -> Result<u32, PipeError> {
    let mut session: u32 = 0;
    unsafe {
        ProcessIdToSessionId(pid, &mut session).map_err(|_| PipeError::Auth)?;
    }
    Ok(session)
}

/// Owned ACL + security-descriptor buffers (kept alive across CreateNamedPipe).
struct SecurityBuffers {
    _acl: Vec<u8>,
    sd: Vec<u8>,
}

/// Build a DACL granting only `sid` GENERIC_ALL, wrapped in a security descriptor.
unsafe fn build_security(sid: &[u8]) -> Result<SecurityBuffers, PipeError> {
    let mut acl = vec![0u8; 1024];
    let acl_ptr = acl.as_mut_ptr() as *mut ACL;
    InitializeAcl(acl_ptr, acl.len() as u32, ACL_REVISION).map_err(|_| PipeError::Acl)?;
    AddAccessAllowedAce(
        acl_ptr,
        ACL_REVISION,
        GENERIC_ALL.0,
        PSID(sid.as_ptr() as *mut c_void),
    )
    .map_err(|_| PipeError::Acl)?;
    let mut sd = vec![0u8; 64];
    let sd_ptr = sd.as_mut_ptr() as *mut c_void;
    InitializeSecurityDescriptor(PSECURITY_DESCRIPTOR(sd_ptr), 1).map_err(|_| PipeError::Acl)?;
    SetSecurityDescriptorDacl(
        PSECURITY_DESCRIPTOR(sd_ptr),
        true,
        Some(acl_ptr as *const ACL),
        false,
    )
    .map_err(|_| PipeError::Acl)?;
    Ok(SecurityBuffers { _acl: acl, sd })
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A named-pipe server bound to the current user's SID and login session.
pub struct PipeServer {
    handle: HANDLE,
    expected_sid: Vec<u8>,
    expected_session: u32,
    expected_shell_pid: u32,
}

impl PipeServer {
    /// Create a pipe instance whose DACL grants only the current user SID. `shell_pid` is the
    /// one process allowed to speak the shell message set; every other client PID is refused
    /// even when it passes the SID/session gates.
    pub fn create(name: &str, shell_pid: u32) -> Result<Self, PipeError> {
        unsafe {
            let expected_sid = current_user_sid()?;
            let expected_session = session_id(GetCurrentProcessId())?;
            let sec = build_security(&expected_sid)?;
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
                return Err(PipeError::Create);
            }
            Ok(Self {
                handle,
                expected_sid,
                expected_session,
                expected_shell_pid: shell_pid,
            })
        }
    }

    /// Block until a client connects, then verify its PID/SID/login-session.
    /// On any mismatch the client is disconnected and an error returned.
    pub fn accept(&self) -> Result<PipeConnection, PipeError> {
        unsafe {
            // A client that connected before ConnectNamedPipe was called yields
            // ERROR_PIPE_CONNECTED, which is a successful connection, not a fault.
            match ConnectNamedPipe(self.handle, None) {
                Ok(()) => {}
                Err(e) if e.code() == HRESULT::from_win32(ERROR_PIPE_CONNECTED.0) => {}
                Err(_) => return Err(PipeError::Connect),
            }
            let mut pid: u32 = 0;
            GetNamedPipeClientProcessId(self.handle, &mut pid).map_err(|_| PipeError::Auth)?;
            if pid != self.expected_shell_pid {
                let _ = DisconnectNamedPipe(self.handle);
                return Err(PipeError::PidMismatch);
            }
            let client_sid = process_sid(pid)?;
            let sid_ok = EqualSid(
                PSID(client_sid.as_ptr() as *mut c_void),
                PSID(self.expected_sid.as_ptr() as *mut c_void),
            )
            .is_ok();
            if !sid_ok {
                let _ = DisconnectNamedPipe(self.handle);
                return Err(PipeError::SidMismatch);
            }
            let client_session = session_id(pid)?;
            if client_session != self.expected_session {
                let _ = DisconnectNamedPipe(self.handle);
                return Err(PipeError::SessionMismatch);
            }
            Ok(PipeConnection {
                handle: self.handle,
                client_pid: pid,
            })
        }
    }
}

impl Drop for PipeServer {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

/// An authenticated client connection on the server's pipe handle.
pub struct PipeConnection {
    handle: HANDLE,
    client_pid: u32,
}

impl PipeConnection {
    /// The authenticated client PID.
    pub fn client_pid(&self) -> u32 {
        self.client_pid
    }

    /// Write one length-prefixed frame.
    pub fn write_frame(&self, payload: &[u8]) -> Result<(), PipeError> {
        let bytes = frame::encode(payload).map_err(|_| PipeError::Frame)?;
        let mut written: u32 = 0;
        unsafe {
            WriteFile(
                self.handle,
                Some(bytes.as_slice()),
                Some(&mut written),
                None,
            )
            .map_err(|_| PipeError::Io)?;
        }
        Ok(())
    }

    /// Read one length-prefixed frame (a single pipe message).
    pub fn read_frame(&self) -> Result<Vec<u8>, PipeError> {
        let mut buf = vec![0u8; frame::MAX_FRAME_BYTES + frame::LENGTH_PREFIX];
        let mut read: u32 = 0;
        unsafe {
            ReadFile(self.handle, Some(buf.as_mut_slice()), Some(&mut read), None)
                .map_err(|_| PipeError::Io)?;
        }
        buf.truncate(read as usize);
        let payload = frame::decode(&buf).map_err(|_| PipeError::Frame)?;
        Ok(payload.to_vec())
    }
}

impl Drop for PipeConnection {
    fn drop(&mut self) {
        unsafe {
            // DisconnectNamedPipe discards whatever the client has not read yet, so a refusal
            // written immediately before the close (a bad handshake, or the pump going away)
            // would reach the shell as a broken pipe instead of the closed code §1 requires.
            // FlushFileBuffers blocks until the peer has drained the buffer; a departed client
            // fails it at once, which is the normal end and needs no reply.
            let _ = FlushFileBuffers(self.handle);
            let _ = DisconnectNamedPipe(self.handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_NONE, OPEN_EXISTING,
    };

    fn unique_name() -> String {
        format!("\\\\.\\pipe\\work-device-test-{}", uuid::Uuid::new_v4())
    }

    #[test]
    fn same_user_client_connects_and_authenticates() {
        let name = unique_name();
        let expected_pid = unsafe { GetCurrentProcessId() };
        let server = PipeServer::create(&name, expected_pid).expect("create pipe");

        let client_name = name.clone();
        let (connected_tx, connected_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let client = std::thread::spawn(move || unsafe {
            let name_w = wide(&client_name);
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
            let _ = connected_tx.send(handle.0 as usize);
            let _ = done_rx.recv();
            let _ = CloseHandle(handle);
        });

        // Wait until the client has opened the pipe, then accept + authenticate.
        let client_handle = connected_rx.recv().expect("client connected");
        assert_ne!(client_handle, 0);
        let conn = server.accept().expect("accept + auth");
        assert_eq!(conn.client_pid(), expected_pid);

        drop(conn);
        let _ = done_tx.send(());
        client.join().unwrap();
    }

    #[test]
    fn framed_echo_over_authenticated_pipe() {
        let name = unique_name();
        let server =
            PipeServer::create(&name, unsafe { GetCurrentProcessId() }).expect("create pipe");

        let client_name = name.clone();
        let (connected_tx, connected_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let client = std::thread::spawn(move || unsafe {
            let name_w = wide(&client_name);
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
            let _ = connected_tx.send(());
            // Echo one frame back to the server.
            let mut buf = vec![0u8; frame::MAX_FRAME_BYTES + frame::LENGTH_PREFIX];
            let mut read: u32 = 0;
            if ReadFile(handle, Some(buf.as_mut_slice()), Some(&mut read), None).is_ok() {
                buf.truncate(read as usize);
                let _ = WriteFile(handle, Some(buf.as_slice()), Some(&mut read), None);
            }
            let _ = done_rx.recv();
            let _ = CloseHandle(handle);
        });

        connected_rx.recv().expect("client connected");
        let conn = server.accept().expect("accept + auth");
        conn.write_frame(b"ping").expect("write");
        let echoed = conn.read_frame().expect("read");
        assert_eq!(echoed, b"ping");

        drop(conn);
        let _ = done_tx.send(());
        client.join().unwrap();
    }

    #[test]
    fn a_same_user_client_that_is_not_the_configured_shell_is_refused() {
        // Between one client's close and the server's next accept the single instance is briefly
        // unavailable (ERROR_PIPE_BUSY), so an attach retries until it lands — the same window
        // the GW18 service-loop clients tolerate.
        fn connect_retry(name: &str) -> HANDLE {
            let name_w = wide(name);
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            loop {
                let handle = unsafe {
                    CreateFileW(
                        PCWSTR(name_w.as_ptr()),
                        GENERIC_READ.0 | GENERIC_WRITE.0,
                        FILE_SHARE_NONE,
                        None,
                        OPEN_EXISTING,
                        FILE_FLAGS_AND_ATTRIBUTES(0),
                        None,
                    )
                };
                if let Ok(handle) = handle {
                    return handle;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "could not attach to {name}"
                );
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
        fn refused_client(name: &str, server: &PipeServer) {
            let client_name = name.to_string();
            let (done_tx, done_rx) = std::sync::mpsc::channel();
            let client = std::thread::spawn(move || {
                let handle = connect_retry(&client_name);
                let _ = done_rx.recv();
                unsafe {
                    let _ = CloseHandle(handle);
                }
            });
            // accept() must be in ConnectNamedPipe while the client attaches: a REUSED instance
            // reports ERROR_PIPE_BUSY until the server listens again, so the attach retries
            // against this call rather than a pre-accept "connected" signal.
            assert_eq!(server.accept().err(), Some(PipeError::PidMismatch));
            let _ = done_tx.send(());
            client.join().unwrap();
        }

        let name = unique_name();
        let own_pid = unsafe { GetCurrentProcessId() };
        // The connecting client is this very process, so any other expected PID refuses it.
        // The SID/session gates would all pass: the PID predicate is the only thing standing
        // between a same-user impostor and the shell message set.
        let server = PipeServer::create(&name, own_pid.wrapping_add(1)).expect("create pipe");
        refused_client(&name, &server);
        // One refused client must not take the channel down: the next attachment is still
        // accepted and refused on the same predicate, not on a broken instance.
        refused_client(&name, &server);
    }
}
