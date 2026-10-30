// Package canonical implements the signed F0-R3 canonical document codec for
// the three immutable Content Store documents of the Work R0a runtime:
// model_request, canonical_state and model_receipt.
//
// Authority: docs/plan/work-r0a-runtime-egress-design-2026-10-25.md §8.1
// ("三类不可变文档", "规范化与模型消息装配" 1-6, "Canonical 提交点与恢复算法"),
// with the field-level contract stated by
// docs/plan/assets/work-r0a-orchestration-2026-10-25/RuntimeRecovery.contract.ts
// and runtime-recovery.schema.json, and the pure-function reference
// runtime-recovery.model.mjs.
//
// The Node/Pi runtime, the authenticated egress gateway and the Go control
// plane must all compute byte-identical hashes: the gateway recomputes the
// request hash before a send gate is consumed, and the control plane verifies
// receipts and checkpoint candidates against the same bytes. Therefore this
// package owns three things and keeps them separable:
//
//  1. A strict JSON reader (Parse) that rejects duplicate object keys,
//     unknown syntax, invalid Unicode, floats, negative zero, non-finite
//     literals and oversized input. encoding/json silently applies
//     "last key wins" and silently replaces invalid UTF-8, so it is not used
//     for untrusted document bytes anywhere in this package.
//  2. A canonical writer (Encode) that sorts object keys by UTF-16 code unit
//     order, keeps array order, keeps strings byte-exact (no NFC/NFD, no
//     trimming), emits no whitespace and encodes UTF-8.
//  3. Two clearly distinguished hash forms: the domain-prefixed document hash
//     sha256(schemaVersion + "\n" + canonical_json) for the three documents,
//     and the plain UTF-8 SHA-256 body hash for original input and public
//     answer bytes. Mixing a "body hash" with a "request hash" is forbidden,
//     so the hash form is selected by reference kind and a mismatch is an
//     error, never a fallback.
//
// On top of the codec the package performs the structural validation the
// signed design assigns to the document layer: schema shape first, then the
// canonical-state chain/phase rules and the terminal-receipt rules. CAS, lease,
// gate and ledger facts stay in the database and the control plane; this
// package never claims them.
//
// The package has no PostgreSQL, network or Temporal dependency.
package canonical

// Schema versions double as the hash domain prefixes (§8.1 item 3).
const (
	SchemaVersionModelRequest   = "work-model-request-v1"
	SchemaVersionCanonicalState = "work-canonical-v1"
	SchemaVersionModelReceipt   = "work-model-receipt-v1"
)

const (
	// MaxDocumentBytes bounds both the raw document bytes handed to Parse and
	// the prefixed canonical encoding handed to SHA-256 (256 KiB,
	// RECOVERY_DESIGN.maxDocumentBytes).
	MaxDocumentBytes = 262144

	// MaxBodyBytes bounds raw input / public answer bodies. §6.3 caps a
	// content candidate upload at 256 KiB and the receipt schema caps
	// contentBytes at the same value.
	MaxBodyBytes = 262144

	// MaxSafeInteger is the largest integer the cross-language codec accepts.
	// The Node side is the binding constraint (Number.MAX_SAFE_INTEGER), so Go
	// must not widen it to int64.
	MaxSafeInteger = 9007199254740991

	// MinSafeInteger mirrors MaxSafeInteger for negative values. No signed
	// field in the three documents is negative today; the codec still refuses
	// anything a JS reader could not round-trip.
	MinSafeInteger = -9007199254740991

	// MaxModelOperations is the R0a per-Run model call ceiling (model:1..3).
	MaxModelOperations = 3

	// MaxPGBigint is the PostgreSQL bigint upper bound used by the semantic
	// range check for decimal-string bigint fields (configRevision, fence).
	MaxPGBigint = int64(9223372036854775807)

	// maxParseDepth bounds nesting so untrusted bytes cannot drive recursion.
	// The deepest signed document is 3 levels; 64 is slack, not a contract.
	maxParseDepth = 64
)
