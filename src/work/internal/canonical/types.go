package canonical

import (
	"regexp"
	"strconv"
)

// Field-level patterns restated from runtime-recovery.schema.json and
// advance-runtime.schema.json. They are the schema layer; range checks that
// the schema leaves to "语义层" live in the helpers below.
var (
	uuidPattern              = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	idPattern                = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	versionNamePattern       = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)
	providerRequestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,256}$`)
	configRevisionPattern    = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)
	fencePattern             = regexp.MustCompile(`^(0|[1-9][0-9]{0,18})$`)
)

// ValidateConfigRevision checks a PG bigint-valued decimal string as used by
// model_request.route.configRevision. The schema pattern alone admits up to 19
// nines, which overflows PostgreSQL bigint, so the semantic range check that
// §8.1 item 4 delegates to this layer is applied here. Zero is not accepted:
// the signed pattern starts at 1.
func ValidateConfigRevision(s string) (int64, error) {
	if !configRevisionPattern.MatchString(s) {
		return 0, wrapf(ErrSchemaViolation, "configRevision %q must be a positive decimal bigint string", s)
	}
	return parseBigintString("configRevision", s)
}

// ValidateFence checks a PG bigint-valued decimal string as used by the
// fragment fence. Unlike configRevision the signed pattern allows "0".
func ValidateFence(s string) (int64, error) {
	if !fencePattern.MatchString(s) {
		return 0, wrapf(ErrSchemaViolation, "fence %q must be a non-negative decimal bigint string", s)
	}
	return parseBigintString("fence", s)
}

func parseBigintString(field, s string) (int64, error) {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n > MaxPGBigint {
		return 0, wrapf(ErrSchemaViolation, "%s %q is outside the PostgreSQL bigint range", field, s)
	}
	return n, nil
}

// Reference is a Content Store StoredReference: an immutable object reference
// plus the hash of that object version.
type Reference struct {
	RefID string
	Hash  string
}

// Validate checks the reference shape.
func (r Reference) Validate(path string) error {
	if !uuidPattern.MatchString(r.RefID) {
		return wrapf(ErrSchemaViolation, "%s.refId %q is not a uuid", path, r.RefID)
	}
	if !ValidHash(r.Hash) {
		return wrapf(ErrSchemaViolation, "%s.hash %q is not a lowercase sha256 digest", path, r.Hash)
	}
	return nil
}

func (r Reference) value() Value {
	return ObjectValue(Field("refId", StringValue(r.RefID)), Field("hash", StringValue(r.Hash)))
}

func nullableReferenceValue(r *Reference) Value {
	if r == nil {
		return NullValue()
	}
	return r.value()
}

func referenceEqual(a, b *Reference) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// Binding is the org/task/run/snapshot/runtime binding shared by the three
// documents. It deliberately carries no execution id, fence, timestamp or
// credential version: instance and authorization changes must not change the
// logical request.
type Binding struct {
	OrgID          string
	TaskID         string
	RunID          string
	SnapshotID     string
	RuntimeVersion string
}

// Validate checks the binding shape.
func (b Binding) Validate(path string) error {
	if !idPattern.MatchString(b.OrgID) {
		return wrapf(ErrSchemaViolation, "%s.orgId %q is invalid", path, b.OrgID)
	}
	for _, f := range []struct {
		name  string
		value string
	}{{"taskId", b.TaskID}, {"runId", b.RunID}, {"snapshotId", b.SnapshotID}} {
		if !uuidPattern.MatchString(f.value) {
			return wrapf(ErrSchemaViolation, "%s.%s %q is not a uuid", path, f.name, f.value)
		}
	}
	if !versionNamePattern.MatchString(b.RuntimeVersion) {
		return wrapf(ErrSchemaViolation, "%s.runtimeVersion %q is invalid", path, b.RuntimeVersion)
	}
	return nil
}

func (b Binding) value() Value {
	return ObjectValue(
		Field("orgId", StringValue(b.OrgID)),
		Field("taskId", StringValue(b.TaskID)),
		Field("runId", StringValue(b.RunID)),
		Field("snapshotId", StringValue(b.SnapshotID)),
		Field("runtimeVersion", StringValue(b.RuntimeVersion)),
	)
}

// LogicalKey is the R0a model step key, model:1..model:3.
type LogicalKey string

// LogicalKeys are the only accepted logical keys.
const (
	LogicalKey1 LogicalKey = "model:1"
	LogicalKey2 LogicalKey = "model:2"
	LogicalKey3 LogicalKey = "model:3"
)

// Index returns the 1-based step number of a logical key.
func (k LogicalKey) Index() (int, bool) {
	switch k {
	case LogicalKey1:
		return 1, true
	case LogicalKey2:
		return 2, true
	case LogicalKey3:
		return 3, true
	default:
		return 0, false
	}
}

// LogicalKeyAt returns the logical key for a 1-based step number.
func LogicalKeyAt(index int) (LogicalKey, error) {
	switch index {
	case 1:
		return LogicalKey1, nil
	case 2:
		return LogicalKey2, nil
	case 3:
		return LogicalKey3, nil
	default:
		return "", wrapf(ErrStructuralViolation, "logical step %d exceeds the %d model operation ceiling", index, MaxModelOperations)
	}
}

// Validate checks the logical key value.
func (k LogicalKey) Validate(path string) error {
	if _, ok := k.Index(); !ok {
		return wrapf(ErrSchemaViolation, "%s %q is not model:1..model:%d", path, string(k), MaxModelOperations)
	}
	return nil
}

// Route is the frozen provider routing of a model request.
type Route struct {
	Provider             string
	Model                string
	ConfigRevision       string
	CompatProfileVersion string
}

// Providers accepted by the signed contract.
const (
	ProviderAliyun     = "aliyun"
	ProviderDeepSeek   = "deepseek"
	ProviderVolcengine = "volcengine"
)

// Parameters is the frozen model parameter set. temperatureMilli is an
// integer 0..2000 that providers map to 0..2; there is no float in the
// canonical form.
type Parameters struct {
	MaxOutputTokens  int64
	TemperatureMilli int64
	OutputFormat     string
}

// OutputFormatMarkdown is the only accepted output format in R0a.
const OutputFormatMarkdown = "markdown"

// ModelIntent is the pending model step recorded in a canonical state and in
// the fragment wire contract.
type ModelIntent struct {
	Request     Reference
	RequestHash string
	LogicalKey  LogicalKey
}

// Validate checks the intent shape.
func (i ModelIntent) Validate(path string) error {
	if err := i.Request.Validate(path + ".request"); err != nil {
		return err
	}
	if !ValidHash(i.RequestHash) {
		return wrapf(ErrSchemaViolation, "%s.requestHash %q is not a lowercase sha256 digest", path, i.RequestHash)
	}
	return i.LogicalKey.Validate(path + ".logicalKey")
}

func (i ModelIntent) value() Value {
	return ObjectValue(
		Field("request", i.Request.value()),
		Field("requestHash", StringValue(i.RequestHash)),
		Field("logicalKey", StringValue(string(i.LogicalKey))),
	)
}

// CompletedModel is one confirmed model step in a canonical state.
type CompletedModel struct {
	LogicalKey  LogicalKey
	RequestHash string
	Receipt     Reference
}

func (c CompletedModel) value() Value {
	return ObjectValue(
		Field("logicalKey", StringValue(string(c.LogicalKey))),
		Field("requestHash", StringValue(c.RequestHash)),
		Field("receipt", c.Receipt.value()),
	)
}

// Phase is the canonical state phase.
type Phase string

// The three canonical phases.
const (
	PhaseReady         Phase = "ready"
	PhaseAwaitingModel Phase = "awaiting_model"
	PhaseFinished      Phase = "finished"
)

// Outcome is the terminal receipt outcome. unknown and SDK-aborted
// placeholders are not terminal outcomes and have no constant here.
type Outcome string

// The two terminal outcomes.
const (
	OutcomeSucceeded       Outcome = "succeeded"
	OutcomeRejectedNotExec Outcome = "rejected_not_executed"
)

// UsageSource is the provenance of the token counts.
type UsageSource string

// The three usage sources.
const (
	UsageProvider        UsageSource = "provider"
	UsageGatewayEstimate UsageSource = "gateway_estimate"
	UsageUnavailable     UsageSource = "unavailable"
)

// Usage carries token counts. For source unavailable all three counts MUST be
// nil: a zero would claim "no tokens were used" instead of "unknown".
type Usage struct {
	Source            UsageSource
	InputTokens       *int64
	OutputTokens      *int64
	CachedInputTokens *int64
}

// Validate enforces the usage rules of §8.1 ("usage = provider /
// gateway_estimate / unavailable; unavailable 的 token 字段必须 null").
func (u Usage) Validate(path string) error {
	switch u.Source {
	case UsageProvider, UsageGatewayEstimate:
		for _, f := range []struct {
			name  string
			value *int64
		}{{"inputTokens", u.InputTokens}, {"outputTokens", u.OutputTokens}, {"cachedInputTokens", u.CachedInputTokens}} {
			if f.value == nil {
				return wrapf(ErrStructuralViolation, "%s.%s must be present when usage source is %q", path, f.name, string(u.Source))
			}
			if *f.value < 0 || *f.value > MaxSafeInteger {
				return wrapf(ErrSchemaViolation, "%s.%s %d is outside 0..%d", path, f.name, *f.value, int64(MaxSafeInteger))
			}
		}
		return nil
	case UsageUnavailable:
		for _, f := range []struct {
			name  string
			value *int64
		}{{"inputTokens", u.InputTokens}, {"outputTokens", u.OutputTokens}, {"cachedInputTokens", u.CachedInputTokens}} {
			if f.value != nil {
				return wrapf(ErrStructuralViolation, "%s.%s must be null when usage is unavailable, %d does not mean unknown", path, f.name, *f.value)
			}
		}
		return nil
	default:
		return wrapf(ErrSchemaViolation, "%s.source %q is not provider, gateway_estimate or unavailable", path, string(u.Source))
	}
}

// IsZeroBilled reports whether all three counts are present and zero.
func (u Usage) IsZeroBilled() bool {
	return u.InputTokens != nil && *u.InputTokens == 0 &&
		u.OutputTokens != nil && *u.OutputTokens == 0 &&
		u.CachedInputTokens != nil && *u.CachedInputTokens == 0
}

func (u Usage) value() Value {
	return ObjectValue(
		Field("source", StringValue(string(u.Source))),
		Field("inputTokens", nullableIntValue(u.InputTokens)),
		Field("outputTokens", nullableIntValue(u.OutputTokens)),
		Field("cachedInputTokens", nullableIntValue(u.CachedInputTokens)),
	)
}

func nullableIntValue(n *int64) Value {
	if n == nil {
		return NullValue()
	}
	return IntValue(*n)
}

func nullableStringValue(s *string) Value {
	if s == nil {
		return NullValue()
	}
	return StringValue(*s)
}

// Int64 returns a pointer to v, for building Usage and optional fields.
func Int64(v int64) *int64 { return &v }

// String returns a pointer to v, for building optional string fields.
func String(v string) *string { return &v }

// Ref returns a pointer to r, for building optional references.
func Ref(r Reference) *Reference { return &r }
