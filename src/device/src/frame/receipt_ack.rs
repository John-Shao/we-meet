//! The receipt_ack downlink body (M3 gateway GW4/GW5). It carries the landed
//! `work.record_device_receipt` result verbatim: `recorded[]` (the receipts the
//! server stored, new or idempotently replayed), `conflicts[]` (the seqs it
//! refused, with a code), and `receipt_through_seq` (the server's recorded
//! watermark). The seqs here are JSON numbers, matching the SQL bigint output —
//! unlike the receipt uplink body, which carries decimal strings at the wire
//! boundary (frame/receipt.rs).
//!
//! Trust model (GW8): the gateway server-signs this ack (and the reconcile_ack
//! that shares this body); the device verifies the ES256 over the wire frame against
//! the hello_ack server_public_jwk BEFORE applying it — fail-closed, no
//! optional-signature shim (GW5 ruling: sign the moment server signing lands).
//! Consuming it only advances the outbox `acked` flag (stop replay) and surfaces
//! conflicts — it NEVER deletes a receipt. Durable release stays gated on the
//! server-signed `checkpoint_ack` watermark (B03 carrier §3.2, reconcile/watermark.rs),
//! so `acked` and durable-release remain distinct facts (device-design §6.1
//! receipt_outbox row).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::frame::sign;
use crate::jwk::EcP256Jwk;

/// The receipt_ack frame type tag.
pub const FRAME_TYPE: &str = "receipt_ack";

/// One receipt the server recorded. `replayed` marks an idempotent re-send the
/// server already held; `resolution_revision` is present only when recording the
/// receipt issued an operation_resolution (a current-fence completed receipt).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecordedReceipt {
    pub receipt_seq: u64,
    pub operation_id: String,
    pub state: String,
    pub resolution_revision: Option<u64>,
    pub replayed: bool,
}

/// One receipt the server refused. The code is the closed conflict set from
/// record_device_receipt (invalid_request / idempotency_key_conflict /
/// receipt_seq_out_of_window / receipt_signature_invalid); it is surfaced for
/// reconciliation, never silently dropped.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReceiptConflict {
    pub receipt_seq: u64,
    pub code: String,
}

/// The receipt_ack body: the record_device_receipt result, plus the server's
/// signature over the wire frame.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReceiptAckBody {
    pub recorded: Vec<RecordedReceipt>,
    pub conflicts: Vec<ReceiptConflict>,
    pub receipt_through_seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl ReceiptAckBody {
    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("receipt_ack serializes")
    }

    /// Verify the server signature over the ack body. The same body is carried by
    /// two frame types (`receipt_ack` and `reconcile_ack`), and the signature covers
    /// {schema_version, type, body}, so the caller must pass the type the frame
    /// actually carried — a receipt_ack signature never verifies as reconcile_ack.
    pub fn verify(&self, jwk: &EcP256Jwk, frame_type: &str) -> bool {
        match &self.signature {
            Some(sig) => sign::verify_frame(jwk, frame_type, &self.to_value(), sig),
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ReceiptAckBody {
        ReceiptAckBody {
            recorded: vec![
                RecordedReceipt {
                    receipt_seq: 1,
                    operation_id: "op".into(),
                    state: "started".into(),
                    resolution_revision: None,
                    replayed: false,
                },
                RecordedReceipt {
                    receipt_seq: 2,
                    operation_id: "op".into(),
                    state: "completed".into(),
                    resolution_revision: Some(3),
                    replayed: true,
                },
            ],
            conflicts: vec![ReceiptConflict {
                receipt_seq: 3,
                code: "receipt_seq_out_of_window".into(),
            }],
            receipt_through_seq: 2,
            signature: None,
        }
    }

    #[test]
    fn seqs_are_json_numbers_not_strings() {
        let value = sample().to_value();
        assert_eq!(value["receipt_through_seq"], 2);
        assert_eq!(value["recorded"][0]["receipt_seq"], 1);
        assert_eq!(value["recorded"][1]["resolution_revision"], 3);
        assert!(value["recorded"][0]["resolution_revision"].is_null());
        assert_eq!(value["conflicts"][0]["receipt_seq"], 3);
    }

    #[test]
    fn round_trips_through_json() {
        let body = sample();
        let raw = serde_json::to_vec(&body).unwrap();
        let back: ReceiptAckBody = serde_json::from_slice(&raw).unwrap();
        assert_eq!(back.recorded.len(), 2);
        assert_eq!(back.conflicts.len(), 1);
        assert_eq!(back.receipt_through_seq, 2);
        assert!(back.recorded[1].replayed);
    }

    #[test]
    fn server_signature_verifies_and_frame_type_separates() {
        use crate::key::{DeviceKey, SoftwareKey};

        let server = SoftwareKey::random();
        let jwk = server.public_jwk();
        let mut body = sample();
        let sig = sign::sign_frame(&server, FRAME_TYPE, &body.to_value()).unwrap();
        body.signature = Some(sig);
        assert!(body.verify(&jwk, FRAME_TYPE));
        // The same body under the reconcile_ack frame type does not verify: the
        // signature covers {schema_version, type, body}, so type is domain separation.
        assert!(!body.verify(&jwk, "reconcile_ack"));
        // An unsigned ack and a tampered ack are both rejected (fail-closed).
        assert!(!sample().verify(&jwk, FRAME_TYPE));
        let mut tampered = body.clone();
        tampered.receipt_through_seq = 99;
        assert!(!tampered.verify(&jwk, FRAME_TYPE));
    }
}
