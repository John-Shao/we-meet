//! The reconcile uplink body (device-design §3.1 reconcile row). Carries the
//! original signed receipt bytes nested and unchanged — "原始签名字节嵌套传输，
//! 不按新session修改". The body itself is not re-signed; each nested receipt keeps
//! its own historical-execution signature. The recovery-only channel note in the
//! design row is moved out of this release (card E=B / B03 §3.3).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::b64;
use crate::frame::u64string;
use crate::journal::recover::OutboxReceipt;

/// The reconcile frame type tag.
pub const FRAME_TYPE: &str = "reconcile";

/// Maximum receipts per reconcile batch (§3.1 :105).
pub const MAX_RECEIPTS_PER_BATCH: usize = 100;

/// The reconcile body. `signed_receipt_bytes` are base64url of the original
/// signed receipt bytes, transmitted verbatim.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReconcileBody {
    pub original_run_id: String,
    pub journal_epoch: String,
    #[serde(with = "u64string")]
    pub from_seq: u64,
    pub signed_receipt_bytes: Vec<String>,
    #[serde(with = "u64string")]
    pub last_receipt_seq: u64,
}

impl ReconcileBody {
    /// Build a reconcile batch from outbox receipts, encoding their original
    /// signed bytes unchanged. `last_receipt_seq` is the highest seq carried.
    pub fn from_receipts(
        original_run_id: &str,
        journal_epoch: &str,
        from_seq: u64,
        receipts: &[OutboxReceipt],
    ) -> Self {
        let signed_receipt_bytes = receipts
            .iter()
            .map(|r| b64::encode(&r.signed_bytes))
            .collect();
        let last_receipt_seq = receipts
            .iter()
            .map(|r| r.receipt_seq)
            .max()
            .unwrap_or(from_seq as i64) as u64;
        Self {
            original_run_id: original_run_id.to_string(),
            journal_epoch: journal_epoch.to_string(),
            from_seq,
            signed_receipt_bytes,
            last_receipt_seq,
        }
    }

    /// Render the body as a JSON value.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("reconcile serializes")
    }

    /// Decode the nested original signed receipt bytes.
    pub fn decode_receipts(&self) -> Result<Vec<Vec<u8>>, base64ct::Error> {
        self.signed_receipt_bytes
            .iter()
            .map(|s| b64::decode(s))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receipt(seq: i64, bytes: &[u8]) -> OutboxReceipt {
        OutboxReceipt {
            receipt_seq: seq,
            operation_id: "op".into(),
            state: "completed".into(),
            signed_bytes: bytes.to_vec(),
            signed_hash: "h".into(),
        }
    }

    #[test]
    fn nested_bytes_are_unchanged_and_round_trip() {
        let receipts = [receipt(1, b"signed-one"), receipt(2, b"signed-two")];
        let body = ReconcileBody::from_receipts("run", "epoch", 1, &receipts);
        let decoded = body.decode_receipts().unwrap();
        assert_eq!(
            decoded,
            vec![b"signed-one".to_vec(), b"signed-two".to_vec()]
        );
        assert_eq!(body.last_receipt_seq, 2);
    }

    #[test]
    fn uint64_fields_are_decimal_strings() {
        let body = ReconcileBody::from_receipts("run", "epoch", 1, &[receipt(1, b"x")]);
        let value = body.to_value();
        assert_eq!(value["from_seq"], "1");
        assert_eq!(value["last_receipt_seq"], "1");
    }

    #[test]
    fn empty_batch_carries_from_seq() {
        let body = ReconcileBody::from_receipts("run", "epoch", 7, &[]);
        assert!(body.signed_receipt_bytes.is_empty());
        assert_eq!(body.last_receipt_seq, 7);
    }
}
