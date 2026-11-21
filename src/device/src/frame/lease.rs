//! The heartbeat uplink and lease downlink bodies (device-design §3.1 heartbeat/lease
//! rows, §3.3 renewal). Both frames are UNSIGNED: neither row lists a signature member,
//! and they ride the mTLS transport plus the hello-established session (the hello_ack
//! precedent). The server's ownership judgment lives in the database (0051 binds a
//! renewal to the lease's original device AND session); the device's judgment is fence
//! match plus a successful renewal, applied in `permit::lease::Lease::apply_renewal`.
//!
//! A lease is not an action permit (§3.1: "不等于动作许可"): extending it never grants a
//! tool/model action, which still needs action_prepare and a SignedPermit.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::frame::u64string;

/// The heartbeat frame type tag (unsigned uplink).
pub const HEARTBEAT_FRAME_TYPE: &str = "heartbeat";
/// The lease frame type tag (unsigned downlink).
pub const LEASE_FRAME_TYPE: &str = "lease";
/// The lease_acquire frame type tag (unsigned uplink, batch 6). The device asks for a
/// same-session reconcile_finish lease after a reconnect so it can hand its history back and
/// propose run_finish once its original execute lease is gone (§3.3/J12; the gap 0053 registered
/// and 0061 closes). Like heartbeat it carries NO signature: the gateway mints the lease through
/// acquire_device_lease under the certificate-mapped transport identity and answers on the same
/// unsigned `lease` downlink the heartbeat renewal already uses.
pub const LEASE_ACQUIRE_FRAME_TYPE: &str = "lease_acquire";

/// The heartbeat body: the device's monotonic clock reading at send time, the leases it
/// wants extended, and its receipt watermark. `monotonic_ms` is never a server deadline —
/// §3.3 makes the LOCAL deadline monotonic so a wall-clock rollback cannot extend a lease.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HeartbeatBody {
    #[serde(with = "u64string")]
    pub monotonic_ms: u64,
    pub lease_ids: Vec<String>,
    #[serde(with = "u64string")]
    pub last_receipt_seq: u64,
}

impl HeartbeatBody {
    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("heartbeat serializes")
    }
}

/// The lease_acquire body: the Run the device wants a reconcile_finish lease for, and the binding
/// revision the lease is minted at (the same one the durable run_start recorded, so acquire binds
/// it to this device's binding row). No signature (§3.1 lease-row sibling). binding_revision is a
/// decimal string on the wire, matching every other §3.1 uint64 boundary.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LeaseAcquireBody {
    pub run_id: String,
    #[serde(with = "u64string")]
    pub binding_revision: u64,
}

impl LeaseAcquireBody {
    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("lease_acquire serializes")
    }
}

/// The lease body: the closed five-field renewal result. `expires_at` is the server's
/// wall-clock expiry, carried for display/diagnostics only — the local deadline is
/// computed from `ttl_ms` minus the measured round trip (§3.3), never from this string.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LeaseBody {
    pub lease_id: String,
    pub run_id: String,
    #[serde(with = "u64string")]
    pub fence: u64,
    pub expires_at: String,
    #[serde(with = "u64string")]
    pub ttl_ms: u64,
}

impl LeaseBody {
    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("lease serializes")
    }

    /// The server-granted TTL as a duration.
    pub fn ttl(&self) -> Duration {
        Duration::from_millis(self.ttl_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn heartbeat() -> HeartbeatBody {
        HeartbeatBody {
            monotonic_ms: 1_000,
            lease_ids: vec!["lease-1".into(), "lease-2".into()],
            last_receipt_seq: 7,
        }
    }

    fn lease_body(fence: u64) -> LeaseBody {
        LeaseBody {
            lease_id: "lease-1".into(),
            run_id: "run-1".into(),
            fence,
            expires_at: "2026-11-16T00:00:30Z".into(),
            ttl_ms: 30_000,
        }
    }

    #[test]
    fn lease_acquire_wire_shape_is_closed_unsigned_decimal_string() {
        let body = LeaseAcquireBody {
            run_id: "run-1".into(),
            binding_revision: 7,
        };
        let value = body.to_value();
        let obj = value.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["binding_revision", "run_id"]);
        // The uint64 boundary renders binding_revision as a decimal string, never a JSON number.
        assert_eq!(obj["binding_revision"], "7");
        assert_eq!(obj["run_id"], "run-1");
        assert!(!obj.contains_key("signature"));
        let round_trip: LeaseAcquireBody = serde_json::from_value(value).unwrap();
        assert_eq!(round_trip.binding_revision, 7);
        assert_eq!(round_trip.run_id, "run-1");
    }

    #[test]
    fn heartbeat_wire_shape_is_closed_and_decimal_strings() {
        let value = heartbeat().to_value();
        let obj = value.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["last_receipt_seq", "lease_ids", "monotonic_ms"]);
        assert_eq!(obj["monotonic_ms"], "1000");
        assert_eq!(obj["last_receipt_seq"], "7");
        assert_eq!(obj["lease_ids"].as_array().unwrap().len(), 2);
        // No signature member: §3.1 lists none for this row.
        assert!(!obj.contains_key("signature"));
        let round_trip: HeartbeatBody = serde_json::from_value(value).unwrap();
        assert_eq!(round_trip.monotonic_ms, 1_000);
        assert_eq!(round_trip.last_receipt_seq, 7);
        assert_eq!(round_trip.lease_ids, heartbeat().lease_ids);
    }

    #[test]
    fn lease_wire_shape_is_closed_and_decimal_strings() {
        let value = lease_body(2).to_value();
        let obj = value.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["expires_at", "fence", "lease_id", "run_id", "ttl_ms"]
        );
        assert_eq!(obj["fence"], "2");
        assert_eq!(obj["ttl_ms"], "30000");
        assert!(!obj.contains_key("signature"));
        let round_trip: LeaseBody = serde_json::from_value(value).unwrap();
        assert_eq!(round_trip.fence, 2);
        assert_eq!(round_trip.ttl(), Duration::from_secs(30));
    }

    #[test]
    fn uint64_fields_reject_floats_and_large_values_stay_exact() {
        // A float fence would silently lose precision above 2^53 (§3.1 boundary rule).
        let float = r#"{"lease_id":"l","run_id":"r","fence":2,"expires_at":"t","ttl_ms":30000}"#;
        assert!(serde_json::from_str::<LeaseBody>(float).is_err());
        let big = r#"{"lease_id":"l","run_id":"r","fence":"18446744073709551615","expires_at":"t","ttl_ms":"30000"}"#;
        let parsed: LeaseBody = serde_json::from_str(big).unwrap();
        assert_eq!(parsed.fence, u64::MAX);
        let hb = r#"{"monotonic_ms":"18446744073709551615","lease_ids":[],"last_receipt_seq":"0"}"#;
        let parsed: HeartbeatBody = serde_json::from_str(hb).unwrap();
        assert_eq!(parsed.monotonic_ms, u64::MAX);
        assert!(parsed.lease_ids.is_empty());
    }
}
