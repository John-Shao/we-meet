package canonical

// This file holds the structural validation the signed design assigns to the
// document layer. The JSON Schema can only bound shapes ("Schema 限制形状"),
// so the rules it cannot express — logical key ordering, gap-free completed
// model sequences, chain continuity, the terminal receipt dichotomy — are
// enforced here as validation this package performs, not as comments.

// Validate checks the schema-level and structural rules of a model request.
func (d ModelRequest) Validate() error {
	if err := d.Binding.Validate("binding"); err != nil {
		return err
	}
	if err := d.LogicalKey.Validate("logicalKey"); err != nil {
		return err
	}
	index, _ := d.LogicalKey.Index()
	if err := d.Input.Validate("input"); err != nil {
		return err
	}
	if d.Template != nil {
		if err := d.Template.Validate("template"); err != nil {
			return err
		}
	}
	if len(d.PriorReceipts) > MaxModelOperations-1 {
		return wrapf(ErrSchemaViolation, "priorReceipts has %d entries, the limit is %d", len(d.PriorReceipts), MaxModelOperations-1)
	}
	// §8.1 item 5: the assembled request appends exactly the public answers of
	// the already completed steps, and the pending logical key is completed
	// count + 1. Within one document that fixes the prior receipt count.
	if len(d.PriorReceipts) != index-1 {
		return wrapf(ErrStructuralViolation, "%s requires exactly %d prior receipts, got %d", string(d.LogicalKey), index-1, len(d.PriorReceipts))
	}
	for i, ref := range d.PriorReceipts {
		if err := ref.Validate("priorReceipts"); err != nil {
			return err
		}
		for j := 0; j < i; j++ {
			if d.PriorReceipts[j] == ref {
				return wrapf(ErrStructuralViolation, "priorReceipts[%d] repeats reference %s", i, ref.RefID)
			}
		}
	}
	switch d.Route.Provider {
	case ProviderAliyun, ProviderDeepSeek, ProviderVolcengine:
	default:
		return wrapf(ErrSchemaViolation, "route.provider %q is not an approved provider", d.Route.Provider)
	}
	if !versionNamePattern.MatchString(d.Route.Model) {
		return wrapf(ErrSchemaViolation, "route.model %q is invalid", d.Route.Model)
	}
	if _, err := ValidateConfigRevision(d.Route.ConfigRevision); err != nil {
		return err
	}
	if !versionNamePattern.MatchString(d.Route.CompatProfileVersion) {
		return wrapf(ErrSchemaViolation, "route.compatProfileVersion %q is invalid", d.Route.CompatProfileVersion)
	}
	if d.Parameters.MaxOutputTokens < 1 || d.Parameters.MaxOutputTokens > MaxSafeInteger {
		return wrapf(ErrSchemaViolation, "parameters.maxOutputTokens %d is outside 1..%d", d.Parameters.MaxOutputTokens, int64(MaxSafeInteger))
	}
	if d.Parameters.TemperatureMilli < 0 || d.Parameters.TemperatureMilli > 2000 {
		return wrapf(ErrSchemaViolation, "parameters.temperatureMilli %d is outside 0..2000", d.Parameters.TemperatureMilli)
	}
	if d.Parameters.OutputFormat != OutputFormatMarkdown {
		return wrapf(ErrSchemaViolation, "parameters.outputFormat %q is not %q", d.Parameters.OutputFormat, OutputFormatMarkdown)
	}
	return nil
}

// Validate checks the schema-level and structural rules of a canonical state.
//
// Enforced here: revision 0 is the initial ready state with previous=null,
// completedModels=[] and pending/artifact null; a later revision must carry a
// previous reference; awaiting_model has exactly one pending whose logical key
// is completed count + 1 and at most model:3; finished has no pending and must
// carry an artifact reference; completedModels is exactly model:1..N with no
// gaps, duplicates or rewritten hashes.
func (d CanonicalState) Validate() error {
	if err := d.Binding.Validate("binding"); err != nil {
		return err
	}
	if d.Revision < 0 || d.Revision > 1000000 {
		return wrapf(ErrSchemaViolation, "revision %d is outside 0..1000000", d.Revision)
	}
	if !uuidPattern.MatchString(d.WriterExecutionID) {
		return wrapf(ErrSchemaViolation, "writerExecutionId %q is not a uuid", d.WriterExecutionID)
	}
	if err := d.Input.Validate("input"); err != nil {
		return err
	}
	if d.Template != nil {
		if err := d.Template.Validate("template"); err != nil {
			return err
		}
	}
	if d.Previous != nil {
		if err := d.Previous.Validate("previous"); err != nil {
			return err
		}
	}
	if err := d.validateCompletedModels(); err != nil {
		return err
	}
	if d.Revision == 0 {
		if d.Previous != nil {
			return wrapf(ErrStructuralViolation, "revision 0 must have previous=null")
		}
		if d.Phase != PhaseReady {
			return wrapf(ErrStructuralViolation, "revision 0 must be the initial %q phase, got %q", string(PhaseReady), string(d.Phase))
		}
		if len(d.CompletedModels) != 0 {
			return wrapf(ErrStructuralViolation, "revision 0 must have an empty completedModels")
		}
	} else if d.Previous == nil {
		return wrapf(ErrStructuralViolation, "revision %d must point at the committed head through previous", d.Revision)
	}
	switch d.Phase {
	case PhaseReady:
		if d.Pending != nil {
			return wrapf(ErrStructuralViolation, "phase ready must not carry a pending request")
		}
		if d.Artifact != nil {
			return wrapf(ErrStructuralViolation, "phase ready must not carry an artifact")
		}
	case PhaseAwaitingModel:
		if d.Pending == nil {
			return wrapf(ErrStructuralViolation, "phase awaiting_model requires exactly one pending request")
		}
		if d.Artifact != nil {
			return wrapf(ErrStructuralViolation, "phase awaiting_model must not carry an artifact")
		}
		if err := d.Pending.Validate("pending"); err != nil {
			return err
		}
		expected, err := LogicalKeyAt(len(d.CompletedModels) + 1)
		if err != nil {
			return err
		}
		if d.Pending.LogicalKey != expected {
			return wrapf(ErrStructuralViolation, "pending.logicalKey must be %q after %d completed models, got %q", string(expected), len(d.CompletedModels), string(d.Pending.LogicalKey))
		}
	case PhaseFinished:
		if d.Pending != nil {
			return wrapf(ErrStructuralViolation, "phase finished must not retain a pending request")
		}
		if d.Artifact == nil {
			return wrapf(ErrStructuralViolation, "phase finished requires an artifact reference derived from the last successful receipt")
		}
		if err := d.Artifact.Validate("artifact"); err != nil {
			return err
		}
		if len(d.CompletedModels) == 0 {
			return wrapf(ErrStructuralViolation, "phase finished requires at least one completed model")
		}
	default:
		return wrapf(ErrSchemaViolation, "phase %q is not ready, awaiting_model or finished", string(d.Phase))
	}
	return nil
}

func (d CanonicalState) validateCompletedModels() error {
	if len(d.CompletedModels) > MaxModelOperations {
		return wrapf(ErrSchemaViolation, "completedModels has %d entries, the limit is %d", len(d.CompletedModels), MaxModelOperations)
	}
	seenReceipts := make(map[string]struct{}, len(d.CompletedModels))
	for i, model := range d.CompletedModels {
		path := "completedModels"
		expected, err := LogicalKeyAt(i + 1)
		if err != nil {
			return err
		}
		if model.LogicalKey != expected {
			return wrapf(ErrStructuralViolation, "%s[%d] must be %q, got %q: model:1..N must have no gaps or duplicates", path, i, string(expected), string(model.LogicalKey))
		}
		if !ValidHash(model.RequestHash) {
			return wrapf(ErrSchemaViolation, "%s[%d].requestHash %q is not a lowercase sha256 digest", path, i, model.RequestHash)
		}
		if err := model.Receipt.Validate(path + ".receipt"); err != nil {
			return err
		}
		if _, dup := seenReceipts[model.Receipt.RefID]; dup {
			return wrapf(ErrStructuralViolation, "%s[%d] reuses receipt %s", path, i, model.Receipt.RefID)
		}
		seenReceipts[model.Receipt.RefID] = struct{}{}
	}
	return nil
}

// Validate checks the schema-level and structural rules of a model receipt.
//
// A terminal receipt is either a full success or a provable not-executed
// rejection. 429/5xx, a broken stream, a partial answer and an unknown or
// SDK-aborted placeholder are not terminal receipts and cannot be dressed up
// as rejected_not_executed.
func (d ModelReceipt) Validate() error {
	if !uuidPattern.MatchString(d.ReceiptID) {
		return wrapf(ErrSchemaViolation, "receiptId %q is not a uuid", d.ReceiptID)
	}
	if err := d.Binding.Validate("binding"); err != nil {
		return err
	}
	if err := d.LogicalKey.Validate("logicalKey"); err != nil {
		return err
	}
	for _, f := range []struct {
		name  string
		value string
	}{
		{"operationId", d.OperationID},
		{"dispatchAttemptId", d.DispatchAttemptID},
		{"executionId", d.ExecutionID},
		{"writerGatewayId", d.WriterGatewayID},
	} {
		if !uuidPattern.MatchString(f.value) {
			return wrapf(ErrSchemaViolation, "%s %q is not a uuid", f.name, f.value)
		}
	}
	if !ValidHash(d.RequestHash) {
		return wrapf(ErrSchemaViolation, "requestHash %q is not a lowercase sha256 digest", d.RequestHash)
	}
	if d.RecordedAtUnixMs < 1 || d.RecordedAtUnixMs > MaxSafeInteger {
		return wrapf(ErrSchemaViolation, "recordedAtUnixMs %d is outside 1..%d", d.RecordedAtUnixMs, int64(MaxSafeInteger))
	}
	// providerRequestId may be absent: without upstream query capability the
	// gateway must not invent an id. An empty string is not "absent" and is
	// rejected by the signed pattern.
	if d.ProviderRequestID != nil && !providerRequestIDPattern.MatchString(*d.ProviderRequestID) {
		return wrapf(ErrSchemaViolation, "providerRequestId %q is invalid; use null when the provider gave none", *d.ProviderRequestID)
	}
	if err := d.Usage.Validate("usage"); err != nil {
		return err
	}
	if d.ContentBytes < 0 || d.ContentBytes > MaxBodyBytes {
		return wrapf(ErrSchemaViolation, "contentBytes %d is outside 0..%d", d.ContentBytes, int64(MaxBodyBytes))
	}
	switch d.Outcome {
	case OutcomeSucceeded:
		if d.Content == nil {
			return wrapf(ErrStructuralViolation, "a succeeded receipt requires a public answer content reference")
		}
		if err := d.Content.Validate("content"); err != nil {
			return err
		}
		if d.ContentBytes < 1 {
			return wrapf(ErrStructuralViolation, "a succeeded receipt requires contentBytes >= 1")
		}
		if d.RejectionEvidence != nil {
			return wrapf(ErrStructuralViolation, "a succeeded receipt must not carry rejection evidence")
		}
	case OutcomeRejectedNotExec:
		if d.RejectionEvidence == nil {
			return wrapf(ErrStructuralViolation, "rejected_not_executed requires a rejection evidence reference")
		}
		if err := d.RejectionEvidence.Validate("rejectionEvidence"); err != nil {
			return err
		}
		if d.Content != nil {
			return wrapf(ErrStructuralViolation, "rejected_not_executed must have no content")
		}
		if d.ContentBytes != 0 {
			return wrapf(ErrStructuralViolation, "rejected_not_executed must have contentBytes 0, got %d", d.ContentBytes)
		}
		if d.Usage.Source != UsageProvider || !d.Usage.IsZeroBilled() {
			return wrapf(ErrStructuralViolation, "rejected_not_executed must carry provider usage with zero tokens")
		}
	default:
		return wrapf(ErrSchemaViolation, "outcome %q is not a terminal outcome; unknown and aborted placeholders are not receipts", string(d.Outcome))
	}
	return nil
}

// ValidateSuccession checks that next is a legal successor of the committed
// head base, whose stored reference is baseRef.
//
// It enforces the parts of "Canonical 提交点与恢复算法" a document pair can
// prove: strictly base+1, previous pointing exactly at the committed head,
// an unchanged binding and input/template, and completed models that extend
// the head by appending only — no rewritten hashes or receipts. CAS ordering,
// lease validity and ledger reconciliation remain database facts and are not
// claimed here.
func ValidateSuccession(base CanonicalState, baseRef Reference, next CanonicalState) error {
	if err := base.Validate(); err != nil {
		return err
	}
	if err := next.Validate(); err != nil {
		return err
	}
	if err := baseRef.Validate("baseRef"); err != nil {
		return err
	}
	baseHash, err := base.Hash()
	if err != nil {
		return err
	}
	if baseHash != baseRef.Hash {
		return wrapf(ErrHashMismatch, "baseRef.hash %s does not match the head document hash %s", baseRef.Hash, baseHash)
	}
	if next.Revision != base.Revision+1 {
		return wrapf(ErrStructuralViolation, "revision must be %d, got %d", base.Revision+1, next.Revision)
	}
	if next.Previous == nil || *next.Previous != baseRef {
		return wrapf(ErrStructuralViolation, "previous must point exactly at the committed head %s", baseRef.RefID)
	}
	if next.Binding != base.Binding {
		return wrapf(ErrStructuralViolation, "binding must not change between revisions")
	}
	if next.Input != base.Input {
		return wrapf(ErrStructuralViolation, "input reference must not change between revisions")
	}
	if !referenceEqual(next.Template, base.Template) {
		return wrapf(ErrStructuralViolation, "template reference must not change between revisions")
	}
	if len(next.CompletedModels) < len(base.CompletedModels) {
		return wrapf(ErrStructuralViolation, "completedModels must not shrink from %d to %d", len(base.CompletedModels), len(next.CompletedModels))
	}
	for i, model := range base.CompletedModels {
		if next.CompletedModels[i] != model {
			return wrapf(ErrStructuralViolation, "completedModels[%d] rewrites a confirmed step", i)
		}
	}
	if len(next.CompletedModels) > len(base.CompletedModels)+1 {
		return wrapf(ErrStructuralViolation, "a revision may confirm at most one model step, got %d new", len(next.CompletedModels)-len(base.CompletedModels))
	}
	return nil
}

// ValidateIntentForRequest checks that an intent (as stored in
// canonical_state.pending or carried on the fragment wire) names the request
// document it claims. The gateway recomputes this before consuming a send
// gate, so request.Hash must equal intent.RequestHash exactly.
func ValidateIntentForRequest(intent ModelIntent, request ModelRequest) error {
	if err := intent.Validate("pending"); err != nil {
		return err
	}
	if err := request.Validate(); err != nil {
		return err
	}
	hash, err := request.Hash()
	if err != nil {
		return err
	}
	if hash != intent.RequestHash {
		return wrapf(ErrHashMismatch, "pending.requestHash %s does not match the request document hash %s", intent.RequestHash, hash)
	}
	if intent.Request.Hash != hash {
		return wrapf(ErrHashMismatch, "pending.request.hash %s does not match the request document hash %s", intent.Request.Hash, hash)
	}
	if intent.LogicalKey != request.LogicalKey {
		return wrapf(ErrStructuralViolation, "pending.logicalKey %q does not match the request logical key %q", string(intent.LogicalKey), string(request.LogicalKey))
	}
	return nil
}

// ValidateRequestAgainstHead checks §8.1 item 5: the request's logical key is
// the head's completed count + 1, its binding matches the head, its input and
// template are the head's approved references, and priorReceipts is exactly
// the head's completed receipts in logical order. History text supplied by the
// model is never accepted, so a mismatch is a rejection, not a merge.
func ValidateRequestAgainstHead(request ModelRequest, head CanonicalState) error {
	if err := request.Validate(); err != nil {
		return err
	}
	if err := head.Validate(); err != nil {
		return err
	}
	if request.Binding != head.Binding {
		return wrapf(ErrStructuralViolation, "request binding does not match the head binding")
	}
	if request.Input != head.Input {
		return wrapf(ErrStructuralViolation, "request input does not match the approved head input")
	}
	if !referenceEqual(request.Template, head.Template) {
		return wrapf(ErrStructuralViolation, "request template does not match the approved head template")
	}
	expected, err := LogicalKeyAt(len(head.CompletedModels) + 1)
	if err != nil {
		return err
	}
	if request.LogicalKey != expected {
		return wrapf(ErrStructuralViolation, "request logicalKey must be %q after %d completed models, got %q", string(expected), len(head.CompletedModels), string(request.LogicalKey))
	}
	if len(request.PriorReceipts) != len(head.CompletedModels) {
		return wrapf(ErrStructuralViolation, "priorReceipts must list the %d confirmed receipts, got %d", len(head.CompletedModels), len(request.PriorReceipts))
	}
	for i, ref := range request.PriorReceipts {
		if ref != head.CompletedModels[i].Receipt {
			return wrapf(ErrStructuralViolation, "priorReceipts[%d] does not match the head receipt for %s", i, string(head.CompletedModels[i].LogicalKey))
		}
	}
	return nil
}

// ValidateReceiptForIntent checks that a terminal receipt belongs to the
// pending intent: same logical key and the same request hash the gateway
// recomputed before the gate was consumed.
func ValidateReceiptForIntent(intent ModelIntent, receipt ModelReceipt) error {
	if err := intent.Validate("pending"); err != nil {
		return err
	}
	if err := receipt.Validate(); err != nil {
		return err
	}
	if receipt.RequestHash != intent.RequestHash {
		return wrapf(ErrHashMismatch, "receipt requestHash %s does not match the pending request hash %s", receipt.RequestHash, intent.RequestHash)
	}
	if receipt.LogicalKey != intent.LogicalKey {
		return wrapf(ErrStructuralViolation, "receipt logicalKey %q does not match the pending logical key %q", string(receipt.LogicalKey), string(intent.LogicalKey))
	}
	return nil
}
