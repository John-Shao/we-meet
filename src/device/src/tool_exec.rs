//! The Windows NT handle-relative tool executor (device-design §4.2 steps 1/3/4/6).
//!
//! Every access starts from the Broker-opened, user-confirmed root handle and walks each path
//! component with a parent-handle-relative NT open (`NtCreateFile` + `OBJECT_ATTRIBUTES.RootDirectory`).
//! A relative_path string is NEVER an authorization basis (§4.2 step 2): authorization binds the
//! opened object's volume serial + file ID. Each component is opened with `FILE_OPEN_REPARSE_POINT`
//! and refused if it is a junction/symlink/mount — we never resolve-then-string-prefix-check. The
//! parent chain and final handle are held to the end of the operation with delete/rename sharing
//! denied, so an ancestor replaced after the check cannot swap the object underneath us. Reads seal
//! ONE bounded immutable buffer (§4.2 step 5, [`crate::tools::SealedBuffer`]); writes are create-new
//! in the artifact directory with all ancestors verified (§4.2 step 6).
//!
//! F13: the tests below race junction/hardlink/rename against root, intermediate dirs and the final
//! file — string-normalization tests alone are not acceptance.

use crate::tools::{SealedBuffer, ToolError};
use windows::core::PCWSTR;
use windows::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows::Wdk::Storage::FileSystem::{
    FileIdFullDirectoryInformation, NtCreateFile, NtQueryDirectoryFile, FILE_DIRECTORY_FILE,
    FILE_ID_FULL_DIR_INFORMATION, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT,
    FILE_SYNCHRONOUS_IO_NONALERT, NTCREATEFILE_CREATE_DISPOSITION,
};
use windows::Win32::Foundation::{
    CloseHandle, HANDLE, NTSTATUS, STATUS_NO_MORE_FILES, STATUS_OBJECT_NAME_COLLISION,
    STATUS_OBJECT_NAME_NOT_FOUND, STATUS_OBJECT_PATH_NOT_FOUND, UNICODE_STRING,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, GetFileInformationByHandle, GetFinalPathNameByHandleW, GetVolumeInformationW,
    ReadFile, WriteFile, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_READ_DATA,
    FILE_SHARE_READ, FILE_WRITE_DATA, OPEN_EXISTING, SYNCHRONIZE, VOLUME_NAME_DOS,
};
use windows::Win32::System::IO::IO_STATUS_BLOCK;

/// `OBJ_CASE_INSENSITIVE` (winnt.h); the literal avoids pulling an extra windows feature.
const OBJ_CASE_INSENSITIVE: u32 = 0x40;
/// `FILE_CREATE` disposition (winnt.h): fail if the object already exists (create-new).
const FILE_CREATE: NTCREATEFILE_CREATE_DISPOSITION = NTCREATEFILE_CREATE_DISPOSITION(2);

/// A handle-relative execution refusal. Each maps to a closed tool_result/tool_blocked reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecError {
    /// The root is remote/UNC or a device namespace (§4.2 step 1).
    RootRemote,
    /// The root volume is not local NTFS (§4.2 step 1).
    RootNotNtfs,
    /// The root itself is a reparse point (§4.2 根目录获取 step 1).
    RootReparse,
    /// The root could not be opened/queried.
    RootOpen,
    /// A path component is a junction/symlink/mount/reparse (§4.2 step 3).
    Reparse,
    /// A component resolved onto a different volume than the bound root (§4.2 step 4).
    VolumeMismatch,
    /// A regular file has hardlink count > 1 (§4.2 step 4).
    Hardlink,
    /// A component is not the expected regular file / directory, or is special (§4.2 step 4).
    SpecialFile,
    /// The named object does not exist.
    NotFound,
    /// The source changed after approval / an in-place write broke the hash (§4.2 step 5).
    SourceChanged,
    /// An artifact ancestor conflicts or is externally occupied (§4.2 step 6).
    WorkspaceChanged,
    /// A numeric bound was exceeded (no silent truncation, DD:182/183).
    Bound,
    /// The Run's lease expired or was revoked mid-execution. Bytes already written stay written:
    /// file side effects are not undone, and the round is recorded as unknown, never as success.
    LeaseExpired,
    /// An underlying I/O or NT call failed.
    Io,
}

/// Cooperative cancellation gate for the synchronous execution core. Production passes a closure
/// over the Run's shared `io_deadline` (the same state `modelproxy` polls); tests pass counting
/// closures so a mid-way expiry is deterministic instead of racing a real clock. `false` means the
/// Run no longer holds a lease, and the next chunk boundary refuses. A single blocked NT call is
/// still not interruptible - this bounds the space *between* calls, not inside one.
pub type LiveGate<'a> = &'a dyn Fn() -> bool;

fn ensure_live(live: LiveGate<'_>) -> Result<(), ExecError> {
    if live() {
        Ok(())
    } else {
        Err(ExecError::LeaseExpired)
    }
}

impl From<ExecError> for ToolError {
    fn from(err: ExecError) -> Self {
        match err {
            ExecError::Bound => ToolError::Bound,
            ExecError::Reparse | ExecError::VolumeMismatch | ExecError::SpecialFile => {
                ToolError::BadPath
            }
            _ => ToolError::BadPath,
        }
    }
}

fn wide_null(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// An owned Windows handle closed on drop. Holding the parent chain alive is what closes the
/// ancestor-replacement TOCTOU (§4.2 step 4).
struct OwnedHandle(HANDLE);

impl OwnedHandle {
    fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// The bound identity of an opened object (§4.2 step 4): volume serial + 64-bit file ID, plus the
/// attribute/link/size facts the verification gates read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileIdentity {
    pub volume_serial: u32,
    pub file_id: u64,
    pub links: u32,
    pub attributes: u32,
    pub size: u64,
}

impl FileIdentity {
    pub fn is_dir(&self) -> bool {
        self.attributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0
    }
    pub fn is_reparse(&self) -> bool {
        self.attributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
    }
}

fn query_identity(handle: HANDLE) -> Result<FileIdentity, ExecError> {
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    unsafe { GetFileInformationByHandle(handle, &mut info) }.map_err(|_| ExecError::Io)?;
    Ok(FileIdentity {
        volume_serial: info.dwVolumeSerialNumber,
        file_id: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        links: info.nNumberOfLinks,
        attributes: info.dwFileAttributes,
        size: ((info.nFileSizeHigh as u64) << 32) | info.nFileSizeLow as u64,
    })
}

/// The Broker-opened, user-confirmed root (§4.2 根目录获取). Held for the grant's lifetime; every
/// tool access walks from this handle, so replacing an ancestor afterwards cannot move the object.
pub struct RootHandle {
    handle: OwnedHandle,
    pub identity: FileIdentity,
    /// The actual location via `GetFinalPathNameByHandle` (display/confirmation only, never authz).
    pub final_path: String,
}

impl RootHandle {
    pub fn handle(&self) -> HANDLE {
        self.handle.raw()
    }
    pub fn volume_serial(&self) -> u32 {
        self.identity.volume_serial
    }
}

impl std::fmt::Debug for RootHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RootHandle")
            .field("identity", &self.identity)
            .field("final_path", &self.final_path)
            .finish()
    }
}

/// Bind a root directory by opening it WITHOUT following its own reparse, then verifying the actual
/// object (§4.2 根目录获取 steps 1-2). Rejects remote/UNC, non-NTFS, and a reparse root. The caller
/// (the native confirmation flow) shows `final_path` and registers the grant only after the user
/// confirms; this function performs the open + identity binding half.
pub fn bind_root(path: &str) -> Result<RootHandle, ExecError> {
    // Device namespace / UNC roots are out of scope this period (§4.2 step 1).
    if path.starts_with("\\\\") || path.starts_with("//") {
        return Err(ExecError::RootRemote);
    }
    let path_w = wide_null(path);
    // Open the directory itself (BACKUP_SEMANTICS), not its reparse target (OPEN_REPARSE_POINT),
    // read-only, denying delete sharing so the bound object cannot be renamed away under us.
    let handle = unsafe {
        CreateFileW(
            PCWSTR(path_w.as_ptr()),
            FILE_LIST_DIRECTORY.0 | FILE_READ_ATTRIBUTES.0 | SYNCHRONIZE.0,
            FILE_SHARE_READ,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
    }
    .map_err(|_| ExecError::RootOpen)?;
    let handle = OwnedHandle(handle);
    let identity = query_identity(handle.raw())?;
    if identity.is_reparse() {
        return Err(ExecError::RootReparse);
    }
    if !identity.is_dir() {
        return Err(ExecError::RootOpen);
    }

    // Actual location of the opened object (may differ from the selected path if an ancestor was a
    // legitimate junction). A UNC final path means the object is remote.
    let mut buf = vec![0u16; 1024];
    let len = unsafe { GetFinalPathNameByHandleW(handle.raw(), &mut buf, VOLUME_NAME_DOS) };
    if len == 0 {
        return Err(ExecError::RootOpen);
    }
    let final_path = String::from_utf16_lossy(&buf[..len as usize]);
    // `\\?\C:\...` is the normal local Win32 file namespace; only `\\?\UNC\` (or a bare UNC) is remote.
    if final_path.starts_with("\\\\?\\UNC\\") || final_path.starts_with("\\\\?\\GlobalRoot") {
        return Err(ExecError::RootRemote);
    }
    if final_path.starts_with("\\\\") && !final_path.starts_with("\\\\?\\") {
        return Err(ExecError::RootRemote);
    }

    // Volume type must be local NTFS (§4.2 step 1). Derive the volume root from the final path.
    let volume_root = volume_root_of(&final_path).ok_or(ExecError::RootNotNtfs)?;
    let root_w = wide_null(&volume_root);
    let mut fs_name = vec![0u16; 16];
    let mut serial: u32 = 0;
    unsafe {
        GetVolumeInformationW(
            PCWSTR(root_w.as_ptr()),
            None,
            Some(&mut serial),
            None,
            None,
            Some(&mut fs_name),
        )
    }
    .map_err(|_| ExecError::RootNotNtfs)?;
    let fs = String::from_utf16_lossy(&fs_name)
        .trim_end_matches('\0')
        .to_ascii_uppercase();
    if fs != "NTFS" {
        return Err(ExecError::RootNotNtfs);
    }
    if serial != identity.volume_serial {
        return Err(ExecError::VolumeMismatch);
    }

    Ok(RootHandle {
        handle,
        identity,
        final_path,
    })
}

/// Derive a volume root (`C:\` or `\\?\Volume{GUID}\`) from a `GetFinalPathNameByHandle` result.
pub fn volume_root_of(final_path: &str) -> Option<String> {
    let rest = final_path.strip_prefix("\\\\?\\").unwrap_or(final_path);
    if rest.starts_with("Volume{") {
        // \\?\Volume{GUID}\... — keep through the closing brace + backslash.
        let end = rest.find('}')? + 1;
        let tail = &rest[end..];
        let slash = tail.find('\\')? + 1;
        return Some(format!("\\\\?\\{}", &rest[..end + slash]));
    }
    // Drive-letter form: "C:\...".
    let bytes = rest.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' {
        return Some(format!("{}:\\", &rest[..1]));
    }
    None
}

/// Open one component relative to a parent directory handle (§4.2 step 3). The component is opened
/// with `FILE_OPEN_REPARSE_POINT` so a junction/symlink/mount is opened as itself and then refused —
/// never resolved past the root. Delete/rename sharing is denied; the handle is held by the caller.
fn open_relative(parent: HANDLE, name: &str, want_dir: bool) -> Result<OwnedHandle, ExecError> {
    let name_w: Vec<u16> = name.encode_utf16().collect();
    let byte_len = (name_w.len() * 2) as u16;
    let mut us = UNICODE_STRING {
        Length: byte_len,
        MaximumLength: byte_len,
        Buffer: windows::core::PWSTR(name_w.as_ptr() as *mut u16),
    };
    let oa = OBJECT_ATTRIBUTES {
        Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent,
        ObjectName: &mut us,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: std::ptr::null(),
        SecurityQualityOfService: std::ptr::null(),
    };
    let mut iosb: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
    let mut handle = HANDLE::default();
    let access = FILE_READ_ATTRIBUTES
        | SYNCHRONIZE
        | if want_dir {
            FILE_LIST_DIRECTORY
        } else {
            FILE_READ_DATA
        };
    let options = FILE_OPEN_REPARSE_POINT
        | FILE_SYNCHRONOUS_IO_NONALERT
        | if want_dir {
            FILE_DIRECTORY_FILE
        } else {
            FILE_NON_DIRECTORY_FILE
        };
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            access,
            &oa,
            &mut iosb,
            None,
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ,
            FILE_OPEN,
            options,
            None,
            0,
        )
    };
    // name_w / us / oa must outlive the call above; they do (still in scope here).
    if status.0 != 0 {
        return Err(map_nt_status(status));
    }
    let owned = OwnedHandle(handle);
    let identity = query_identity(owned.raw())?;
    if identity.is_reparse() {
        return Err(ExecError::Reparse);
    }
    if identity.is_dir() != want_dir {
        return Err(ExecError::SpecialFile);
    }
    Ok(owned)
}

fn map_nt_status(status: NTSTATUS) -> ExecError {
    match status {
        s if s == STATUS_OBJECT_NAME_NOT_FOUND || s == STATUS_OBJECT_PATH_NOT_FOUND => {
            ExecError::NotFound
        }
        s if s == STATUS_OBJECT_NAME_COLLISION => ExecError::WorkspaceChanged,
        _ => ExecError::Io,
    }
}

/// A verified handle chain from the root to a final object (§4.2 step 4). Every intermediate handle
/// is held alive (delete/rename denied) until the operation ends; `identity` is the final object's.
pub struct Chain {
    _handles: Vec<OwnedHandle>,
    final_handle: HANDLE,
    pub identity: FileIdentity,
}

impl Chain {
    pub fn handle(&self) -> HANDLE {
        self.final_handle
    }
}

impl std::fmt::Debug for Chain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Chain")
            .field("identity", &self.identity)
            .field("depth", &self._handles.len())
            .finish()
    }
}

/// Walk `segments` from the bound root, opening each component parent-handle-relative and verifying
/// it stays on the root volume. `final_dir` selects whether the last component is a directory or a
/// regular file. The returned chain holds the whole parent path open.
pub fn walk(
    root: &RootHandle,
    segments: &[String],
    final_dir: bool,
    live: LiveGate<'_>,
) -> Result<Chain, ExecError> {
    ensure_live(live)?;
    if segments.is_empty() {
        // The root itself is the target directory.
        return Ok(Chain {
            _handles: Vec::new(),
            final_handle: root.handle(),
            identity: root.identity,
        });
    }
    let mut handles: Vec<OwnedHandle> = Vec::new();
    let mut parent = root.handle();
    let mut identity = root.identity;
    for (i, seg) in segments.iter().enumerate() {
        ensure_live(live)?;
        let is_last = i == segments.len() - 1;
        let want_dir = if is_last { final_dir } else { true };
        let opened = open_relative(parent, seg, want_dir)?;
        let id = query_identity(opened.raw())?;
        if id.volume_serial != root.volume_serial() {
            return Err(ExecError::VolumeMismatch);
        }
        parent = opened.raw();
        identity = id;
        handles.push(opened);
    }
    Ok(Chain {
        _handles: handles,
        final_handle: parent,
        identity,
    })
}

/// Read a verified regular file ONCE into a sealed immutable buffer (§4.2 step 5). Refuses hardlink
/// count > 1, special files, and over-bound sizes (no silent truncation). The caller hands THIS
/// buffer onward and verifies expected hash/size against it — never a second source read.
pub fn read_sealed(
    chain: &Chain,
    max_bytes: u64,
    live: LiveGate<'_>,
) -> Result<SealedBuffer, ExecError> {
    read_sealed_inner(chain.handle(), chain.identity, max_bytes, live)
}

/// The sealed-read core on a verified handle + identity (shared by read and search).
fn read_sealed_inner(
    handle: HANDLE,
    id: FileIdentity,
    max_bytes: u64,
    live: LiveGate<'_>,
) -> Result<SealedBuffer, ExecError> {
    ensure_live(live)?;
    if id.is_dir() || id.is_reparse() {
        return Err(ExecError::SpecialFile);
    }
    if id.links > 1 {
        return Err(ExecError::Hardlink);
    }
    if id.size > max_bytes {
        return Err(ExecError::Bound);
    }
    let mut bytes: Vec<u8> = Vec::with_capacity(id.size as usize);
    let mut chunk = [0u8; 65536];
    let mut remaining = id.size;
    while remaining > 0 {
        ensure_live(live)?;
        let want = remaining.min(chunk.len() as u64) as u32;
        let mut read: u32 = 0;
        unsafe {
            ReadFile(
                handle,
                Some(&mut chunk[..want as usize]),
                Some(&mut read),
                None,
            )
        }
        .map_err(|_| ExecError::Io)?;
        if read == 0 {
            // EOF before the verified size: the file shrank mid-read → source changed.
            return Err(ExecError::SourceChanged);
        }
        bytes.extend_from_slice(&chunk[..read as usize]);
        remaining -= read as u64;
    }
    let sealed = SealedBuffer::seal(bytes);
    // The size must still match the verified identity (an in-place grow during read is refused).
    if sealed.len() != id.size {
        return Err(ExecError::SourceChanged);
    }
    Ok(sealed)
}

/// One directory entry from a handle-relative enumeration (no path reopen).
#[derive(Clone, Debug)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    pub is_reparse: bool,
    pub size: u64,
    pub file_id: u64,
}

/// Enumerate a verified directory handle via `NtQueryDirectoryFile` (§4.2: never reopen by path).
/// `.`/`..` are skipped. Reparse entries are flagged (the caller refuses to traverse them).
pub fn list_dir(chain: &Chain, live: LiveGate<'_>) -> Result<Vec<DirEntry>, ExecError> {
    ensure_live(live)?;
    if !chain.identity.is_dir() {
        return Err(ExecError::SpecialFile);
    }
    enumerate_dir(chain.handle(), live)
}

/// Handle-relative directory enumeration core (shared by list and search).
fn enumerate_dir(handle: HANDLE, live: LiveGate<'_>) -> Result<Vec<DirEntry>, ExecError> {
    let mut entries = Vec::new();
    let mut buffer = vec![0u8; 65536];
    let mut restart = true;
    loop {
        ensure_live(live)?;
        let mut iosb: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
        let status = unsafe {
            NtQueryDirectoryFile(
                handle,
                None,
                None,
                None,
                &mut iosb,
                buffer.as_mut_ptr() as *mut _,
                buffer.len() as u32,
                FileIdFullDirectoryInformation,
                false,
                None,
                restart,
            )
        };
        restart = false;
        if status == STATUS_NO_MORE_FILES {
            break;
        }
        if status.0 != 0 {
            return Err(map_nt_status(status));
        }
        let mut offset = 0usize;
        loop {
            let entry =
                unsafe { &*(buffer.as_ptr().add(offset) as *const FILE_ID_FULL_DIR_INFORMATION) };
            let name_len = entry.FileNameLength as usize / 2;
            let name_ptr = std::ptr::addr_of!(entry.FileName) as *const u16;
            let name =
                unsafe { String::from_utf16_lossy(std::slice::from_raw_parts(name_ptr, name_len)) };
            if name != "." && name != ".." {
                entries.push(DirEntry {
                    name,
                    is_dir: entry.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0,
                    is_reparse: entry.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0,
                    size: entry.EndOfFile.max(0) as u64,
                    file_id: entry.FileId as u64,
                });
            }
            if entry.NextEntryOffset == 0 {
                break;
            }
            offset += entry.NextEntryOffset as usize;
        }
    }
    entries.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
    });
    Ok(entries)
}

/// One literal-search hit: the display relative path, 1-based line, a bounded excerpt, and the hash
/// of the sealed buffer it was matched in (§4.2 step 5: each file is sealed before matching).
#[derive(Clone, Debug)]
pub struct SearchHit {
    pub relative_path: String,
    pub line: usize,
    pub excerpt: String,
    pub buffer_hash: String,
}

/// A bounded search result. `incomplete` + `reason` report which ceiling stopped the scan (DD:183);
/// the result is never presented as a complete corpus scan.
#[derive(Clone, Debug)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    pub incomplete: bool,
    pub reason: Option<&'static str>,
    pub files_scanned: usize,
    pub bytes_scanned: u64,
}

struct SearchState {
    query: String,
    limit: usize,
    hits: Vec<SearchHit>,
    files_scanned: usize,
    bytes_scanned: u64,
    incomplete: bool,
    reason: Option<&'static str>,
}

impl SearchState {
    fn stop(&mut self, reason: &'static str) {
        self.incomplete = true;
        if self.reason.is_none() {
            self.reason = Some(reason);
        }
    }
    fn full(&self) -> bool {
        self.hits.len() >= self.limit
            || self.files_scanned >= crate::tools::SEARCH_MAX_FILES
            || self.bytes_scanned >= crate::tools::SEARCH_MAX_SCAN_BYTES
    }
}

/// Literal (non-regex) search from a verified start directory, handle-relative at every level
/// (§4.2 steps 3-5). Bounds: 1000 files / depth 8 / 16 MiB total scan / 256 KiB per file (DD:183).
/// Reparse entries are never traversed; only the closed text formats are scanned; each file is
/// sealed once and matched in that buffer. Hitting any ceiling returns `incomplete` with a reason.
pub fn search(
    root: &RootHandle,
    start: &[String],
    query: &str,
    limit: u64,
    live: LiveGate<'_>,
) -> Result<SearchResult, ExecError> {
    ensure_live(live)?;
    let start_chain = walk(root, start, true, live)?;
    let mut state = SearchState {
        query: query.to_string(),
        limit: limit as usize,
        hits: Vec::new(),
        files_scanned: 0,
        bytes_scanned: 0,
        incomplete: false,
        reason: None,
    };
    search_dir(root, start_chain.handle(), start, 0, &mut state, live)?;
    Ok(SearchResult {
        hits: state.hits,
        incomplete: state.incomplete,
        reason: state.reason,
        files_scanned: state.files_scanned,
        bytes_scanned: state.bytes_scanned,
    })
}

fn search_dir(
    root: &RootHandle,
    dir_handle: HANDLE,
    rel: &[String],
    depth: usize,
    state: &mut SearchState,
    live: LiveGate<'_>,
) -> Result<(), ExecError> {
    ensure_live(live)?;
    if state.full() {
        state.stop("bound");
        return Ok(());
    }
    if depth > crate::tools::SEARCH_MAX_DEPTH {
        state.stop("depth");
        return Ok(());
    }
    let entries = enumerate_dir(dir_handle, live)?;
    for entry in entries {
        ensure_live(live)?;
        if state.full() {
            state.stop("bound");
            break;
        }
        // Never traverse a junction/symlink/mount (§4.2 step 3).
        if entry.is_reparse {
            continue;
        }
        let mut child_rel = rel.to_vec();
        child_rel.push(entry.name.clone());
        if entry.is_dir {
            if depth + 1 > crate::tools::SEARCH_MAX_DEPTH {
                state.stop("depth");
                continue;
            }
            let child = open_relative(dir_handle, &entry.name, true)?;
            if query_identity(child.raw())?.volume_serial != root.volume_serial() {
                return Err(ExecError::VolumeMismatch);
            }
            search_dir(root, child.raw(), &child_rel, depth + 1, state, live)?;
        } else {
            let ext = entry
                .name
                .rsplit('.')
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            if !crate::tools::TEXT_EXTENSIONS.contains(&ext.as_str()) {
                continue;
            }
            state.files_scanned += 1;
            let child = match open_relative(dir_handle, &entry.name, false) {
                Ok(c) => c,
                Err(ExecError::NotFound) => continue,
                Err(e) => return Err(e),
            };
            let id = query_identity(child.raw())?;
            if id.volume_serial != root.volume_serial() {
                return Err(ExecError::VolumeMismatch);
            }
            let sealed =
                match read_sealed_inner(child.raw(), id, crate::tools::SEARCH_MAX_FILE_BYTES, live)
                {
                    Ok(s) => s,
                    // Over-size / hardlink / special files are skipped, never substituted or truncated.
                    Err(ExecError::Bound)
                    | Err(ExecError::Hardlink)
                    | Err(ExecError::SpecialFile) => continue,
                    Err(e) => return Err(e),
                };
            state.bytes_scanned += sealed.len();
            let text = String::from_utf8_lossy(sealed.bytes());
            for (i, line) in text.lines().enumerate() {
                if line.contains(state.query.as_str()) {
                    state.hits.push(SearchHit {
                        relative_path: child_rel.join("/"),
                        line: i + 1,
                        excerpt: line.chars().take(256).collect(),
                        buffer_hash: sealed.hash().to_string(),
                    });
                    if state.hits.len() >= state.limit {
                        state.stop("limit");
                        break;
                    }
                }
            }
        }
    }
    Ok(())
}

/// Create a NEW regular file relative to a verified artifact directory handle (§4.2 step 6) and write
/// the sealed body on that same handle. An existing name (collision) or an occupied ancestor returns
/// `WorkspaceChanged`; bytes are never substituted. The body's hash/size are verified before write.
pub fn write_artifact_new(
    dir_chain: &Chain,
    file_name: &str,
    body: &SealedBuffer,
    expected_hash: &str,
    expected_size: u64,
    live: LiveGate<'_>,
) -> Result<FileIdentity, ExecError> {
    ensure_live(live)?;
    // NtCreateFile would follow intermediate junctions in a multi-component ObjectName.
    crate::tools::validate_file_name(file_name).map_err(|_| ExecError::SpecialFile)?;
    if !dir_chain.identity.is_dir() {
        return Err(ExecError::SpecialFile);
    }
    body.verify(expected_hash, expected_size)
        .map_err(|_| ExecError::SourceChanged)?;

    let name_w: Vec<u16> = file_name.encode_utf16().collect();
    let byte_len = (name_w.len() * 2) as u16;
    let mut us = UNICODE_STRING {
        Length: byte_len,
        MaximumLength: byte_len,
        Buffer: windows::core::PWSTR(name_w.as_ptr() as *mut u16),
    };
    let oa = OBJECT_ATTRIBUTES {
        Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: dir_chain.handle(),
        ObjectName: &mut us,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: std::ptr::null(),
        SecurityQualityOfService: std::ptr::null(),
    };
    let mut iosb: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
    let mut handle = HANDLE::default();
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            &oa,
            &mut iosb,
            None,
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
            None,
            0,
        )
    };
    if status.0 != 0 {
        return Err(map_nt_status(status));
    }
    let owned = OwnedHandle(handle);
    let mut written_total = 0u64;
    let bytes = body.bytes();
    while written_total < bytes.len() as u64 {
        ensure_live(live)?;
        let slice = &bytes[written_total as usize..];
        let mut written: u32 = 0;
        unsafe { WriteFile(owned.raw(), Some(slice), Some(&mut written), None) }
            .map_err(|_| ExecError::Io)?;
        if written == 0 {
            return Err(ExecError::Io);
        }
        written_total += written as u64;
    }
    query_identity(owned.raw())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::validate_relative_path;

    /// A unique temp directory under the system temp (local NTFS on the test host).
    struct TempDir(String);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("work-exec-{tag}-{}", uuid::Uuid::new_v4()));
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

    fn segs(path: &str) -> Vec<String> {
        validate_relative_path(path).unwrap()
    }

    /// A gate that allows `allow` calls and then refuses, so a mid-way expiry is deterministic
    /// (no wall clock in the assertion). Mirrors how production reads `io_deadline` per boundary.
    fn counting_gate(allow: usize) -> impl Fn() -> bool {
        let seen = std::cell::Cell::new(0usize);
        move || {
            let n = seen.get() + 1;
            seen.set(n);
            n <= allow
        }
    }

    #[test]
    fn walk_refuses_at_the_first_segment_once_the_run_lease_is_gone() {
        let tmp = TempDir::new("gate-walk");
        std::fs::create_dir_all(tmp.join("a/b")).unwrap();
        std::fs::write(tmp.join("a/b/f.txt"), b"x").unwrap();
        let root = bind_root(tmp.path()).unwrap();
        assert_eq!(
            walk(&root, &segs("a/b/f.txt"), false, &|| false).unwrap_err(),
            ExecError::LeaseExpired
        );
        // Entry boundary passes, the first segment boundary refuses: no component is opened.
        assert_eq!(
            walk(&root, &segs("a/b/f.txt"), false, &counting_gate(1)).unwrap_err(),
            ExecError::LeaseExpired
        );
        // A live lease still walks the whole path.
        let chain = walk(&root, &segs("a/b/f.txt"), false, &|| true).unwrap();
        assert_eq!(chain.identity.size, 1);
    }

    #[test]
    fn sealed_read_stops_between_chunks_once_the_run_lease_is_gone() {
        let tmp = TempDir::new("gate-read");
        let body = vec![b'y'; 200 * 1024];
        std::fs::write(tmp.join("big.txt"), &body).unwrap();
        let root = bind_root(tmp.path()).unwrap();
        let chain = walk(&root, &segs("big.txt"), false, &|| true).unwrap();
        // Entry + first 64 KiB chunk pass, the second chunk boundary refuses.
        assert_eq!(
            read_sealed(&chain, 1 << 20, &counting_gate(2)).unwrap_err(),
            ExecError::LeaseExpired
        );
        let fresh = walk(&root, &segs("big.txt"), false, &|| true).unwrap();
        let sealed = read_sealed(&fresh, 1 << 20, &|| true).unwrap();
        assert_eq!(sealed.len(), body.len() as u64);
    }

    #[test]
    fn list_dir_stops_between_enumeration_batches_once_the_run_lease_is_gone() {
        let tmp = TempDir::new("gate-list");
        std::fs::write(tmp.join("a.txt"), b"a").unwrap();
        std::fs::write(tmp.join("b.txt"), b"b").unwrap();
        let root = bind_root(tmp.path()).unwrap();
        let chain = walk(&root, &[], true, &|| true).unwrap();
        // Entry + first NtQueryDirectoryFile batch pass, the next batch boundary refuses.
        assert_eq!(
            list_dir(&chain, &counting_gate(2)).unwrap_err(),
            ExecError::LeaseExpired
        );
        assert_eq!(list_dir(&chain, &|| true).unwrap().len(), 2);
    }

    #[test]
    fn artifact_write_stops_between_chunks_and_keeps_what_it_already_created() {
        let tmp = TempDir::new("gate-write");
        let root = bind_root(tmp.path()).unwrap();
        let dir = walk(&root, &[], true, &|| true).unwrap();
        let body = SealedBuffer::seal(vec![b'z'; 200 * 1024]);
        // Entry boundary passes, the first write boundary refuses: the create-new already happened,
        // so the empty file stays on disk. Side effects are never rolled back (the round is unknown).
        assert_eq!(
            write_artifact_new(
                &dir,
                "out.bin",
                &body,
                body.hash(),
                body.len(),
                &counting_gate(1)
            )
            .unwrap_err(),
            ExecError::LeaseExpired
        );
        assert_eq!(std::fs::read(tmp.join("out.bin")).unwrap().len(), 0);
        let id =
            write_artifact_new(&dir, "ok.bin", &body, body.hash(), body.len(), &|| true).unwrap();
        assert_eq!(id.size, 200 * 1024);
        assert_eq!(std::fs::read(tmp.join("ok.bin")).unwrap().len(), 200 * 1024);
    }

    #[test]
    fn search_refuses_before_it_scans_anything_once_the_run_lease_is_gone() {
        let tmp = TempDir::new("gate-search");
        std::fs::write(tmp.join("a.txt"), b"needle").unwrap();
        let root = bind_root(tmp.path()).unwrap();
        assert_eq!(
            search(&root, &[], "needle", 100, &|| false).unwrap_err(),
            ExecError::LeaseExpired
        );
        let result = search(&root, &[], "needle", 100, &|| true).unwrap();
        assert_eq!(result.hits.len(), 1);
    }

    #[test]
    fn bind_root_rejects_unc_and_binds_local_ntfs() {
        assert!(matches!(
            bind_root("\\\\server\\share"),
            Err(ExecError::RootRemote)
        ));
        assert!(matches!(
            bind_root("//server/share"),
            Err(ExecError::RootRemote)
        ));
        let tmp = TempDir::new("bind");
        let root = bind_root(tmp.path()).expect("local NTFS root binds");
        assert!(root.final_path.contains("work-exec-bind"));
        assert!(root.identity.is_dir());
        assert_ne!(root.volume_serial(), 0);
    }

    #[test]
    fn walk_reads_a_nested_file_into_a_sealed_buffer() {
        let tmp = TempDir::new("read");
        std::fs::create_dir_all(tmp.join("docs/sub")).unwrap();
        std::fs::write(tmp.join("docs/sub/a.txt"), b"hello world").unwrap();
        let root = bind_root(tmp.path()).unwrap();
        let chain = walk(&root, &segs("docs/sub/a.txt"), false, &|| true).unwrap();
        let sealed = read_sealed(&chain, 262_144, &|| true).unwrap();
        assert_eq!(sealed.bytes(), b"hello world");
        assert!(sealed.verify(sealed.hash(), 11).is_ok());
    }

    #[test]
    fn walk_refuses_a_missing_component() {
        let tmp = TempDir::new("missing");
        let root = bind_root(tmp.path()).unwrap();
        assert_eq!(
            walk(&root, &segs("nope/a.txt"), false, &|| true).unwrap_err(),
            ExecError::NotFound
        );
    }

    #[test]
    fn read_refuses_over_bound_without_truncation() {
        let tmp = TempDir::new("bound");
        std::fs::write(tmp.join("big.txt"), vec![b'x'; 100]).unwrap();
        let root = bind_root(tmp.path()).unwrap();
        let chain = walk(&root, &segs("big.txt"), false, &|| true).unwrap();
        assert_eq!(
            read_sealed(&chain, 50, &|| true).unwrap_err(),
            ExecError::Bound
        );
    }

    #[test]
    fn list_dir_enumerates_handle_relative_and_flags_reparse() {
        let tmp = TempDir::new("list");
        std::fs::create_dir_all(tmp.join("d")).unwrap();
        std::fs::write(tmp.join("f.txt"), b"abc").unwrap();
        let root = bind_root(tmp.path()).unwrap();
        let chain = walk(&root, &[], true, &|| true).unwrap();
        let entries = list_dir(&chain, &|| true).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"d"));
        assert!(names.contains(&"f.txt"));
        assert!(!names.contains(&"."));
        let f = entries.iter().find(|e| e.name == "f.txt").unwrap();
        assert!(!f.is_dir);
        assert_eq!(f.size, 3);
    }

    #[test]
    fn search_finds_literal_hits_across_nested_dirs_and_seals_each() {
        let tmp = TempDir::new("search");
        std::fs::create_dir_all(tmp.join("a/b")).unwrap();
        std::fs::write(tmp.join("top.md"), b"needle here\nno match").unwrap();
        std::fs::write(tmp.join("a/b/deep.txt"), b"another needle line").unwrap();
        std::fs::write(tmp.join("a/skip.exe"), b"needle in binary").unwrap();
        let root = bind_root(tmp.path()).unwrap();
        let result = search(&root, &[], "needle", 100, &|| true).unwrap();
        assert!(!result.incomplete);
        let paths: Vec<&str> = result
            .hits
            .iter()
            .map(|h| h.relative_path.as_str())
            .collect();
        assert!(paths.contains(&"top.md"));
        assert!(paths.contains(&"a/b/deep.txt"));
        // The non-text .exe is never scanned.
        assert!(!paths.iter().any(|p| p.ends_with("skip.exe")));
        assert!(result
            .hits
            .iter()
            .all(|h| h.buffer_hash.starts_with("sha256:")));
        assert_eq!(result.files_scanned, 2);
    }

    #[test]
    fn search_reports_incomplete_when_the_hit_limit_is_reached() {
        let tmp = TempDir::new("searchlimit");
        std::fs::write(tmp.join("f.txt"), b"x\nx\nx\nx\n").unwrap();
        let root = bind_root(tmp.path()).unwrap();
        let result = search(&root, &[], "x", 2, &|| true).unwrap();
        assert_eq!(result.hits.len(), 2);
        assert!(result.incomplete);
        assert_eq!(result.reason, Some("limit"));
    }

    #[test]
    fn search_never_traverses_a_junction_directory() {
        let tmp = TempDir::new("searchjunc");
        let outside = TempDir::new("searchoutside");
        std::fs::write(outside.join("secret.txt"), b"needle outside").unwrap();
        let link = tmp.join("sub");
        if !make_junction(&link, outside.path()) {
            eprintln!("skipping: junction creation unavailable");
            return;
        }
        std::fs::write(tmp.join("inside.txt"), b"needle inside").unwrap();
        let root = bind_root(tmp.path()).unwrap();
        let result = search(&root, &[], "needle", 100, &|| true).unwrap();
        let paths: Vec<&str> = result
            .hits
            .iter()
            .map(|h| h.relative_path.as_str())
            .collect();
        assert!(paths.contains(&"inside.txt"));
        assert!(!paths.iter().any(|p| p.contains("secret")));
    }

    #[test]
    fn artifact_write_is_create_new_and_refuses_collision() {
        let tmp = TempDir::new("write");
        let root = bind_root(tmp.path()).unwrap();
        let dir = walk(&root, &[], true, &|| true).unwrap();
        let body = SealedBuffer::seal(b"artifact body".to_vec());
        let id =
            write_artifact_new(&dir, "out.md", &body, body.hash(), body.len(), &|| true).unwrap();
        assert_eq!(id.size, 13);
        assert_eq!(std::fs::read(tmp.join("out.md")).unwrap(), b"artifact body");
        // A second create-new of the same name is a workspace_changed collision, never an overwrite.
        let again = write_artifact_new(&dir, "out.md", &body, body.hash(), body.len(), &|| true);
        assert_eq!(again.unwrap_err(), ExecError::WorkspaceChanged);
    }

    #[test]
    fn artifact_write_refuses_unsafe_names_before_creating_any_file() {
        let tmp = TempDir::new("write-name");
        std::fs::create_dir_all(tmp.join("out/sub")).unwrap();
        let root = bind_root(tmp.path()).unwrap();
        let dir = walk(&root, &segs("out"), true, &|| true).unwrap();
        let body = SealedBuffer::seal(b"artifact".to_vec());
        let mut bad_names: Vec<String> = [
            "",
            "sub/evil.md",
            "sub\\evil.md",
            "../evil.md",
            "..\\evil.md",
            "/evil.md",
            "C:evil.md",
            "evil:ads",
            "evil\0.md",
            ".",
            "..",
            "CON",
            "nul.txt",
            "COM1.md",
            "LPT9.json",
            "evil.",
            "evil ",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        bad_names.push("a".repeat(32768));
        // 32768 UTF-16 units used to wrap Length to zero (or to a valid short prefix).
        bad_names.push(format!("evil.md{}", "a".repeat(32768)));
        bad_names.push("\u{10000}".repeat(16384));
        for name in bad_names {
            assert_eq!(
                write_artifact_new(&dir, &name, &body, body.hash(), body.len(), &|| true)
                    .unwrap_err(),
                ExecError::SpecialFile,
            );
        }
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 1);
        assert_eq!(std::fs::read_dir(tmp.join("out")).unwrap().count(), 1);
        assert_eq!(std::fs::read_dir(tmp.join("out/sub")).unwrap().count(), 0);
        write_artifact_new(&dir, "v1.md", &body, body.hash(), body.len(), &|| true).unwrap();
        assert_eq!(std::fs::read(tmp.join("out/v1.md")).unwrap(), body.bytes());
    }

    #[test]
    fn artifact_write_never_follows_a_junction_in_the_file_name() {
        let tmp = TempDir::new("write-junction");
        let outside = TempDir::new("write-outside");
        let link = tmp.join("escape");
        assert!(
            make_junction(&link, outside.path()),
            "junction fixture must be created"
        );
        // Positive control: the junction really reaches the outside directory via ordinary I/O.
        std::fs::write(outside.join("sentinel.txt"), b"outside").unwrap();
        assert_eq!(
            std::fs::read(tmp.join("escape/sentinel.txt")).unwrap(),
            b"outside"
        );
        let root = bind_root(tmp.path()).unwrap();
        let dir = walk(&root, &[], true, &|| true).unwrap();
        let body = SealedBuffer::seal(b"artifact".to_vec());
        for name in ["escape/evil.md", "escape\\evil.md", "escape\\sentinel.txt"] {
            assert_eq!(
                write_artifact_new(&dir, name, &body, body.hash(), body.len(), &|| true)
                    .unwrap_err(),
                ExecError::SpecialFile,
            );
        }
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 1);
        assert_eq!(
            std::fs::read(outside.join("sentinel.txt")).unwrap(),
            b"outside"
        );
        write_artifact_new(&dir, "v1.md", &body, body.hash(), body.len(), &|| true).unwrap();
        assert_eq!(std::fs::read(tmp.join("v1.md")).unwrap(), body.bytes());
        assert_eq!(
            write_artifact_new(&dir, "v1.md", &body, body.hash(), body.len(), &|| true)
                .unwrap_err(),
            ExecError::WorkspaceChanged,
        );
    }

    #[test]
    fn artifact_write_refuses_a_hash_mismatch_before_writing() {
        let tmp = TempDir::new("hash");
        let root = bind_root(tmp.path()).unwrap();
        let dir = walk(&root, &[], true, &|| true).unwrap();
        let body = SealedBuffer::seal(b"real".to_vec());
        let err =
            write_artifact_new(&dir, "x.txt", &body, "sha256:wrong", 4, &|| true).unwrap_err();
        assert_eq!(err, ExecError::SourceChanged);
        assert!(!std::path::Path::new(&tmp.join("x.txt")).exists());
    }

    // ---- F13 race / reparse / hardlink acceptance (string normalization alone is not enough) ----

    /// Create a directory junction `link` -> `target` via `mklink /J` (no admin needed for junctions).
    fn make_junction(link: &str, target: &str) -> bool {
        let out = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J", link, target])
            .output();
        matches!(out, Ok(o) if o.status.success())
    }

    #[test]
    fn f13_root_junction_is_refused() {
        let tmp = TempDir::new("rootjunc");
        let target = tmp.join("real");
        std::fs::create_dir_all(&target).unwrap();
        let link = tmp.join("link");
        if !make_junction(&link, &target) {
            eprintln!("skipping: junction creation unavailable");
            return;
        }
        // Binding the junction root must refuse (it is a reparse point), not resolve to `real`.
        assert_eq!(bind_root(&link).unwrap_err(), ExecError::RootReparse);
    }

    #[test]
    fn f13_intermediate_junction_component_is_refused() {
        let tmp = TempDir::new("midjunc");
        let outside = TempDir::new("outside");
        std::fs::write(outside.join("secret.txt"), b"outside").unwrap();
        let link = tmp.join("sub");
        if !make_junction(&link, outside.path()) {
            eprintln!("skipping: junction creation unavailable");
            return;
        }
        let root = bind_root(tmp.path()).unwrap();
        // Walking through the junction component must refuse, never read the outside file.
        let err = walk(&root, &segs("sub/secret.txt"), false, &|| true).unwrap_err();
        assert_eq!(err, ExecError::Reparse);
    }

    #[test]
    fn f13_final_file_hardlink_count_over_one_is_refused() {
        let tmp = TempDir::new("hardlink");
        let original = tmp.join("orig.txt");
        std::fs::write(&original, b"shared").unwrap();
        let link = tmp.join("link.txt");
        let ok = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/H", &link, &original])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ok {
            eprintln!("skipping: hardlink creation unavailable");
            return;
        }
        let root = bind_root(tmp.path()).unwrap();
        let chain = walk(&root, &segs("link.txt"), false, &|| true).unwrap();
        assert_eq!(
            read_sealed(&chain, 262_144, &|| true).unwrap_err(),
            ExecError::Hardlink
        );
    }

    #[test]
    fn f13_ancestor_rename_after_bind_does_not_move_the_bound_object() {
        let tmp = TempDir::new("rename");
        std::fs::create_dir_all(tmp.join("sub")).unwrap();
        std::fs::write(tmp.join("sub/a.txt"), b"bound content").unwrap();
        let root = bind_root(tmp.path()).unwrap();
        // Open the chain, THEN rename the root directory on disk. The held handles must still read
        // the originally bound object (authorization binds the handle, not the path string).
        let chain = walk(&root, &segs("sub/a.txt"), false, &|| true).unwrap();
        let renamed = format!("{}-moved", tmp.path());
        let moved = std::fs::rename(tmp.path(), &renamed).is_ok();
        let sealed = read_sealed(&chain, 262_144, &|| true).unwrap();
        assert_eq!(sealed.bytes(), b"bound content");
        if moved {
            let _ = std::fs::rename(&renamed, tmp.path());
        }
    }
}
