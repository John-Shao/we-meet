package gateway

import (
	"crypto/ecdsa"
	"encoding/json"
)

// maxReconcileBatch is the per-batch receipt ceiling (device-design §3.1 :105,
// "每批 receipts ≤100"); overage is RESOURCE_EXHAUSTED, matching the SQL
// device_receipt_batch_valid 1..100 window.
const maxReconcileBatch = 100

// ReconcileBody is the reconcile uplink body (device-design §3.1 reconcile row;
// Rust frame/reconcile.rs). It nests the original signed receipt bytes verbatim
// ("原始签名字节嵌套传输，不按新session修改"): each signed_receipt_bytes entry is
// base64url (no padding) of a full original receipt ENVELOPE, keeping its
// historical session_id and original_execution. The reconcile body itself is not
// re-signed — each nested receipt carries its own historical-execution signature,
// which the gateway verifies individually. from_seq/last_receipt_seq are uint64
// decimal strings at the wire boundary.
type ReconcileBody struct {
	OriginalRunID      string   `json:"original_run_id"`
	JournalEpoch       string   `json:"journal_epoch"`
	FromSeq            string   `json:"from_seq"`
	SignedReceiptBytes []string `json:"signed_receipt_bytes"`
	LastReceiptSeq     string   `json:"last_receipt_seq"`
}

// reconcileAckEnvelope wraps the record_device_receipt batch result (recorded,
// conflicts, receipt_through_seq) into a server-signed reconcile_ack frame on the
// current transport session. The body has the same shape as receipt_ack, so the device
// consumes it with the same outbox-ack path (recovery/replay.rs apply_receipt_ack); the
// signature is over the reconcile_ack frame type, so a receipt_ack signature never
// verifies here.
func reconcileAckEnvelope(deviceID, sessionID string, result json.RawMessage, key *ecdsa.PrivateKey) ([]byte, error) {
	body, err := signAckBody(key, "reconcile_ack", result)
	if err != nil {
		return nil, err
	}
	env := Envelope{
		SchemaVersion:      2,
		Type:               "reconcile_ack",
		MessageID:          newMessageID(),
		DeviceID:           deviceID,
		SessionID:          sessionID,
		RecoveryGeneration: "0",
		Body:               body,
	}
	return json.Marshal(env)
}
