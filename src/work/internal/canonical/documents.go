package canonical

// Document is one of the three immutable Content Store documents.
//
// Hash never implies validity: the gateway and the control plane must be able
// to recompute the hash of whatever bytes were stored. Call Validate
// separately (ParseModelRequest and friends do both).
type Document interface {
	DocumentKind() DocumentKind
	SchemaVersion() string
	Value() Value
	Validate() error
	Hash() (string, error)
	Canonical() ([]byte, error)
}

// ModelRequest is the work-model-request-v1 document: the logical model
// request, with no baseURL, key, raw messages, execution id, fence or
// timestamp. Routing or parameter changes must produce a new approved intent
// rather than mutate this document.
type ModelRequest struct {
	Binding       Binding
	LogicalKey    LogicalKey
	Input         Reference
	Template      *Reference
	PriorReceipts []Reference
	Route         Route
	Parameters    Parameters
}

// DocumentKind implements Document.
func (d ModelRequest) DocumentKind() DocumentKind { return KindModelRequest }

// SchemaVersion implements Document.
func (d ModelRequest) SchemaVersion() string { return SchemaVersionModelRequest }

// Value renders the document as a canonical value tree.
func (d ModelRequest) Value() Value {
	priorReceipts := make([]Value, 0, len(d.PriorReceipts))
	for _, ref := range d.PriorReceipts {
		priorReceipts = append(priorReceipts, ref.value())
	}
	return ObjectValue(
		Field("kind", StringValue(string(KindModelRequest))),
		Field("schemaVersion", StringValue(SchemaVersionModelRequest)),
		Field("binding", d.Binding.value()),
		Field("logicalKey", StringValue(string(d.LogicalKey))),
		Field("input", d.Input.value()),
		Field("template", nullableReferenceValue(d.Template)),
		Field("priorReceipts", ArrayValue(priorReceipts...)),
		Field("route", ObjectValue(
			Field("provider", StringValue(d.Route.Provider)),
			Field("model", StringValue(d.Route.Model)),
			Field("configRevision", StringValue(d.Route.ConfigRevision)),
			Field("compatProfileVersion", StringValue(d.Route.CompatProfileVersion)),
		)),
		Field("parameters", ObjectValue(
			Field("maxOutputTokens", IntValue(d.Parameters.MaxOutputTokens)),
			Field("temperatureMilli", IntValue(d.Parameters.TemperatureMilli)),
			Field("outputFormat", StringValue(d.Parameters.OutputFormat)),
		)),
	)
}

// Hash returns the domain-prefixed document hash.
func (d ModelRequest) Hash() (string, error) {
	return HashCanonical(SchemaVersionModelRequest, d.Value())
}

// Canonical returns the canonical JSON encoding without the domain prefix.
func (d ModelRequest) Canonical() ([]byte, error) { return Encode(d.Value()) }

// CanonicalState is the work-canonical-v1 checkpoint document. It is not a
// serialized Pi object, JSONL session, reasoning trace or aborted placeholder,
// and it does not replace the Run/Operation/quota ledger.
type CanonicalState struct {
	Binding           Binding
	Revision          int64
	Previous          *Reference
	WriterExecutionID string
	Input             Reference
	Template          *Reference
	CompletedModels   []CompletedModel
	Phase             Phase
	Pending           *ModelIntent
	Artifact          *Reference
}

// DocumentKind implements Document.
func (d CanonicalState) DocumentKind() DocumentKind { return KindCanonicalState }

// SchemaVersion implements Document.
func (d CanonicalState) SchemaVersion() string { return SchemaVersionCanonicalState }

// Value renders the document as a canonical value tree.
func (d CanonicalState) Value() Value {
	completed := make([]Value, 0, len(d.CompletedModels))
	for _, model := range d.CompletedModels {
		completed = append(completed, model.value())
	}
	pending := NullValue()
	if d.Pending != nil {
		pending = d.Pending.value()
	}
	return ObjectValue(
		Field("kind", StringValue(string(KindCanonicalState))),
		Field("schemaVersion", StringValue(SchemaVersionCanonicalState)),
		Field("binding", d.Binding.value()),
		Field("revision", IntValue(d.Revision)),
		Field("previous", nullableReferenceValue(d.Previous)),
		Field("writerExecutionId", StringValue(d.WriterExecutionID)),
		Field("input", d.Input.value()),
		Field("template", nullableReferenceValue(d.Template)),
		Field("completedModels", ArrayValue(completed...)),
		Field("phase", StringValue(string(d.Phase))),
		Field("pending", pending),
		Field("artifact", nullableReferenceValue(d.Artifact)),
	)
}

// Hash returns the domain-prefixed document hash.
func (d CanonicalState) Hash() (string, error) {
	return HashCanonical(SchemaVersionCanonicalState, d.Value())
}

// Canonical returns the canonical JSON encoding without the domain prefix.
func (d CanonicalState) Canonical() ([]byte, error) { return Encode(d.Value()) }

// ModelReceipt is the work-model-receipt-v1 document written by the
// authenticated egress gateway. A valid shape does not authenticate the
// writer: writerGatewayId must be checked against the authenticated context,
// never trusted because it appears in the body.
type ModelReceipt struct {
	ReceiptID         string
	Binding           Binding
	LogicalKey        LogicalKey
	OperationID       string
	DispatchAttemptID string
	ExecutionID       string
	RequestHash       string
	WriterGatewayID   string
	RecordedAtUnixMs  int64
	Outcome           Outcome
	ProviderRequestID *string
	Content           *Reference
	ContentBytes      int64
	Usage             Usage
	RejectionEvidence *Reference
}

// DocumentKind implements Document.
func (d ModelReceipt) DocumentKind() DocumentKind { return KindModelReceipt }

// SchemaVersion implements Document.
func (d ModelReceipt) SchemaVersion() string { return SchemaVersionModelReceipt }

// Value renders the document as a canonical value tree.
func (d ModelReceipt) Value() Value {
	return ObjectValue(
		Field("kind", StringValue(string(KindModelReceipt))),
		Field("schemaVersion", StringValue(SchemaVersionModelReceipt)),
		Field("receiptId", StringValue(d.ReceiptID)),
		Field("binding", d.Binding.value()),
		Field("logicalKey", StringValue(string(d.LogicalKey))),
		Field("operationId", StringValue(d.OperationID)),
		Field("dispatchAttemptId", StringValue(d.DispatchAttemptID)),
		Field("executionId", StringValue(d.ExecutionID)),
		Field("requestHash", StringValue(d.RequestHash)),
		Field("writerGatewayId", StringValue(d.WriterGatewayID)),
		Field("recordedAtUnixMs", IntValue(d.RecordedAtUnixMs)),
		Field("outcome", StringValue(string(d.Outcome))),
		Field("providerRequestId", nullableStringValue(d.ProviderRequestID)),
		Field("content", nullableReferenceValue(d.Content)),
		Field("contentBytes", IntValue(d.ContentBytes)),
		Field("usage", d.Usage.value()),
		Field("rejectionEvidence", nullableReferenceValue(d.RejectionEvidence)),
	)
}

// Hash returns the domain-prefixed document hash.
func (d ModelReceipt) Hash() (string, error) {
	return HashCanonical(SchemaVersionModelReceipt, d.Value())
}

// Canonical returns the canonical JSON encoding without the domain prefix.
func (d ModelReceipt) Canonical() ([]byte, error) { return Encode(d.Value()) }

// ParseDocument reads any of the three documents from raw bytes. It performs
// the strict read, the schema layer and the structural rules, in that order.
func ParseDocument(raw []byte) (Document, error) {
	v, err := Parse(raw)
	if err != nil {
		return nil, err
	}
	if v.Kind() != KindObject {
		return nil, wrapf(ErrSchemaViolation, "a document must be a JSON object, got %s", v.Kind())
	}
	kindValue, ok := v.Lookup("kind")
	if !ok || kindValue.Kind() != KindString {
		return nil, wrapf(ErrMissingField, "document is missing a string kind field")
	}
	switch DocumentKind(kindValue.Str()) {
	case KindModelRequest:
		doc, err := DecodeModelRequest(v)
		if err != nil {
			return nil, err
		}
		return doc, nil
	case KindCanonicalState:
		doc, err := DecodeCanonicalState(v)
		if err != nil {
			return nil, err
		}
		return doc, nil
	case KindModelReceipt:
		doc, err := DecodeModelReceipt(v)
		if err != nil {
			return nil, err
		}
		return doc, nil
	default:
		return nil, wrapf(ErrUnsupportedSchemaVersion, "unsupported document kind %q", kindValue.Str())
	}
}

// ParseModelRequest reads and validates a model_request document.
func ParseModelRequest(raw []byte) (ModelRequest, error) {
	v, err := Parse(raw)
	if err != nil {
		return ModelRequest{}, err
	}
	return DecodeModelRequest(v)
}

// ParseCanonicalState reads and validates a canonical_state document.
func ParseCanonicalState(raw []byte) (CanonicalState, error) {
	v, err := Parse(raw)
	if err != nil {
		return CanonicalState{}, err
	}
	return DecodeCanonicalState(v)
}

// ParseModelReceipt reads and validates a model_receipt document.
func ParseModelReceipt(raw []byte) (ModelReceipt, error) {
	v, err := Parse(raw)
	if err != nil {
		return ModelReceipt{}, err
	}
	return DecodeModelReceipt(v)
}

// DecodeModelRequest applies the schema layer and the structural rules to an
// already parsed value.
func DecodeModelRequest(v Value) (ModelRequest, error) {
	r, err := newReader("", v)
	if err != nil {
		return ModelRequest{}, err
	}
	if err := r.header(KindModelRequest); err != nil {
		return ModelRequest{}, err
	}
	var doc ModelRequest
	if doc.Binding, err = r.binding("binding"); err != nil {
		return ModelRequest{}, err
	}
	if doc.LogicalKey, err = r.logicalKey("logicalKey"); err != nil {
		return ModelRequest{}, err
	}
	if doc.Input, err = r.reference("input"); err != nil {
		return ModelRequest{}, err
	}
	if doc.Template, err = r.nullableReference("template"); err != nil {
		return ModelRequest{}, err
	}
	priorReceipts, err := r.array("priorReceipts", MaxModelOperations-1)
	if err != nil {
		return ModelRequest{}, err
	}
	for i, item := range priorReceipts {
		ref, err := decodeReference("priorReceipts", item)
		if err != nil {
			return ModelRequest{}, err
		}
		for _, seen := range doc.PriorReceipts {
			if seen == ref {
				return ModelRequest{}, wrapf(ErrSchemaViolation, "priorReceipts[%d] repeats reference %s", i, ref.RefID)
			}
		}
		doc.PriorReceipts = append(doc.PriorReceipts, ref)
	}
	route, err := r.object("route")
	if err != nil {
		return ModelRequest{}, err
	}
	if doc.Route.Provider, err = route.enum("provider", ProviderAliyun, ProviderDeepSeek, ProviderVolcengine); err != nil {
		return ModelRequest{}, err
	}
	if doc.Route.Model, err = route.matching("model", versionNamePattern, "model name"); err != nil {
		return ModelRequest{}, err
	}
	if doc.Route.ConfigRevision, err = route.stringField("configRevision"); err != nil {
		return ModelRequest{}, err
	}
	if doc.Route.CompatProfileVersion, err = route.matching("compatProfileVersion", versionNamePattern, "version name"); err != nil {
		return ModelRequest{}, err
	}
	if err := route.done(); err != nil {
		return ModelRequest{}, err
	}
	parameters, err := r.object("parameters")
	if err != nil {
		return ModelRequest{}, err
	}
	if doc.Parameters.MaxOutputTokens, err = parameters.integer("maxOutputTokens", 1, MaxSafeInteger); err != nil {
		return ModelRequest{}, err
	}
	if doc.Parameters.TemperatureMilli, err = parameters.integer("temperatureMilli", 0, 2000); err != nil {
		return ModelRequest{}, err
	}
	if err := parameters.constant("outputFormat", OutputFormatMarkdown); err != nil {
		return ModelRequest{}, err
	}
	doc.Parameters.OutputFormat = OutputFormatMarkdown
	if err := parameters.done(); err != nil {
		return ModelRequest{}, err
	}
	if err := r.done(); err != nil {
		return ModelRequest{}, err
	}
	if err := doc.Validate(); err != nil {
		return ModelRequest{}, err
	}
	return doc, nil
}

// DecodeCanonicalState applies the schema layer and the structural rules to an
// already parsed value.
func DecodeCanonicalState(v Value) (CanonicalState, error) {
	r, err := newReader("", v)
	if err != nil {
		return CanonicalState{}, err
	}
	if err := r.header(KindCanonicalState); err != nil {
		return CanonicalState{}, err
	}
	var doc CanonicalState
	if doc.Binding, err = r.binding("binding"); err != nil {
		return CanonicalState{}, err
	}
	if doc.Revision, err = r.integer("revision", 0, 1000000); err != nil {
		return CanonicalState{}, err
	}
	if doc.Previous, err = r.nullableReference("previous"); err != nil {
		return CanonicalState{}, err
	}
	if doc.WriterExecutionID, err = r.matching("writerExecutionId", uuidPattern, "uuid"); err != nil {
		return CanonicalState{}, err
	}
	if doc.Input, err = r.reference("input"); err != nil {
		return CanonicalState{}, err
	}
	if doc.Template, err = r.nullableReference("template"); err != nil {
		return CanonicalState{}, err
	}
	completed, err := r.array("completedModels", MaxModelOperations)
	if err != nil {
		return CanonicalState{}, err
	}
	for i, item := range completed {
		sub, err := newReader("completedModels", item)
		if err != nil {
			return CanonicalState{}, err
		}
		var model CompletedModel
		if model.LogicalKey, err = sub.logicalKey("logicalKey"); err != nil {
			return CanonicalState{}, err
		}
		if model.RequestHash, err = sub.hashField("requestHash"); err != nil {
			return CanonicalState{}, err
		}
		if model.Receipt, err = sub.reference("receipt"); err != nil {
			return CanonicalState{}, err
		}
		if err := sub.done(); err != nil {
			return CanonicalState{}, err
		}
		for _, seen := range doc.CompletedModels {
			if seen == model {
				return CanonicalState{}, wrapf(ErrSchemaViolation, "completedModels[%d] repeats an entry", i)
			}
		}
		doc.CompletedModels = append(doc.CompletedModels, model)
	}
	phase, err := r.enum("phase", string(PhaseReady), string(PhaseAwaitingModel), string(PhaseFinished))
	if err != nil {
		return CanonicalState{}, err
	}
	doc.Phase = Phase(phase)
	pendingValue, err := r.required("pending")
	if err != nil {
		return CanonicalState{}, err
	}
	if pendingValue.Kind() != KindNull {
		intent, err := decodeIntent("pending", pendingValue)
		if err != nil {
			return CanonicalState{}, err
		}
		doc.Pending = &intent
	}
	if doc.Artifact, err = r.nullableReference("artifact"); err != nil {
		return CanonicalState{}, err
	}
	if err := r.done(); err != nil {
		return CanonicalState{}, err
	}
	if err := doc.Validate(); err != nil {
		return CanonicalState{}, err
	}
	return doc, nil
}

// DecodeModelReceipt applies the schema layer and the structural rules to an
// already parsed value.
func DecodeModelReceipt(v Value) (ModelReceipt, error) {
	r, err := newReader("", v)
	if err != nil {
		return ModelReceipt{}, err
	}
	if err := r.header(KindModelReceipt); err != nil {
		return ModelReceipt{}, err
	}
	var doc ModelReceipt
	if doc.ReceiptID, err = r.matching("receiptId", uuidPattern, "uuid"); err != nil {
		return ModelReceipt{}, err
	}
	if doc.Binding, err = r.binding("binding"); err != nil {
		return ModelReceipt{}, err
	}
	if doc.LogicalKey, err = r.logicalKey("logicalKey"); err != nil {
		return ModelReceipt{}, err
	}
	if doc.OperationID, err = r.matching("operationId", uuidPattern, "uuid"); err != nil {
		return ModelReceipt{}, err
	}
	if doc.DispatchAttemptID, err = r.matching("dispatchAttemptId", uuidPattern, "uuid"); err != nil {
		return ModelReceipt{}, err
	}
	if doc.ExecutionID, err = r.matching("executionId", uuidPattern, "uuid"); err != nil {
		return ModelReceipt{}, err
	}
	if doc.RequestHash, err = r.hashField("requestHash"); err != nil {
		return ModelReceipt{}, err
	}
	if doc.WriterGatewayID, err = r.matching("writerGatewayId", uuidPattern, "uuid"); err != nil {
		return ModelReceipt{}, err
	}
	if doc.RecordedAtUnixMs, err = r.integer("recordedAtUnixMs", 1, MaxSafeInteger); err != nil {
		return ModelReceipt{}, err
	}
	outcome, err := r.enum("outcome", string(OutcomeSucceeded), string(OutcomeRejectedNotExec))
	if err != nil {
		return ModelReceipt{}, err
	}
	doc.Outcome = Outcome(outcome)
	if doc.ProviderRequestID, err = r.nullableString("providerRequestId", providerRequestIDPattern, "provider request id"); err != nil {
		return ModelReceipt{}, err
	}
	if doc.Content, err = r.nullableReference("content"); err != nil {
		return ModelReceipt{}, err
	}
	if doc.ContentBytes, err = r.integer("contentBytes", 0, MaxBodyBytes); err != nil {
		return ModelReceipt{}, err
	}
	usage, err := r.object("usage")
	if err != nil {
		return ModelReceipt{}, err
	}
	source, err := usage.enum("source", string(UsageProvider), string(UsageGatewayEstimate), string(UsageUnavailable))
	if err != nil {
		return ModelReceipt{}, err
	}
	doc.Usage.Source = UsageSource(source)
	if doc.Usage.InputTokens, err = usage.nullableInteger("inputTokens", 0, MaxSafeInteger); err != nil {
		return ModelReceipt{}, err
	}
	if doc.Usage.OutputTokens, err = usage.nullableInteger("outputTokens", 0, MaxSafeInteger); err != nil {
		return ModelReceipt{}, err
	}
	if doc.Usage.CachedInputTokens, err = usage.nullableInteger("cachedInputTokens", 0, MaxSafeInteger); err != nil {
		return ModelReceipt{}, err
	}
	if err := usage.done(); err != nil {
		return ModelReceipt{}, err
	}
	if doc.RejectionEvidence, err = r.nullableReference("rejectionEvidence"); err != nil {
		return ModelReceipt{}, err
	}
	if err := r.done(); err != nil {
		return ModelReceipt{}, err
	}
	if err := doc.Validate(); err != nil {
		return ModelReceipt{}, err
	}
	return doc, nil
}
