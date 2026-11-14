//! Work R0b device-side Broker (M3).
//!
//! Authority is the signed device design
//! `docs/work/design/work-r0b-device-design-2026-10-30.md`; this crate implements
//! it batch by batch. Batch 0 is the compiling skeleton only — device identity,
//! journal, permits, named-pipe IPC and the sidecar supervisor land in later
//! batches. Nothing here yet claims a production capability.

/// Crate version, surfaced by the binary entry point.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// SHA-256 hex of `bytes`. Placeholder proving the crypto dependency resolves;
/// the real receipt/proof hashing lands with the identity batch.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hex_matches_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn version_is_present() {
        assert!(!version().is_empty());
    }

    #[test]
    fn bundled_sqlite_opens_in_memory() {
        // Proves the bundled SQLite C source compiles and links with the MinGW
        // toolchain. The real journal schema (WAL on a file DB) lands with the
        // journal batch; an in-memory database cannot use WAL.
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory sqlite");
        conn.execute_batch("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (42);")
            .expect("write");
        let value: i64 = conn
            .query_row("SELECT x FROM t", [], |row| row.get(0))
            .expect("read");
        assert_eq!(value, 42);
    }
}
