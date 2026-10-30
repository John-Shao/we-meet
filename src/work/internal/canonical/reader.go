package canonical

import "regexp"

// reader decodes a parsed object and enforces the schema layer: every field is
// claimed by name, and any field left over is an unknown field rejection
// ("先按 Schema 验证并拒绝未知字段"). Parse has already rejected duplicate keys,
// so a single map lookup per field is safe here.
type reader struct {
	path    string
	fields  map[string]Value
	claimed map[string]bool
}

func newReader(path string, v Value) (*reader, error) {
	if v.Kind() != KindObject {
		return nil, wrapf(ErrSchemaViolation, "%s must be an object, got %s", path, v.Kind())
	}
	r := &reader{path: path, fields: make(map[string]Value, len(v.Members())), claimed: map[string]bool{}}
	for _, m := range v.Members() {
		r.fields[m.Key] = m.Value
	}
	return r, nil
}

func (r *reader) at(name string) string {
	if r.path == "" {
		return name
	}
	return r.path + "." + name
}

func (r *reader) required(name string) (Value, error) {
	v, ok := r.fields[name]
	if !ok {
		return Value{}, wrapf(ErrMissingField, "%s is required", r.at(name))
	}
	r.claimed[name] = true
	return v, nil
}

func (r *reader) done() error {
	for key := range r.fields {
		if !r.claimed[key] {
			return wrapf(ErrUnknownField, "%s is not part of the schema", r.at(key))
		}
	}
	return nil
}

func (r *reader) object(name string) (*reader, error) {
	v, err := r.required(name)
	if err != nil {
		return nil, err
	}
	return newReader(r.at(name), v)
}

func (r *reader) stringField(name string) (string, error) {
	v, err := r.required(name)
	if err != nil {
		return "", err
	}
	if v.Kind() != KindString {
		return "", wrapf(ErrSchemaViolation, "%s must be a string, got %s", r.at(name), v.Kind())
	}
	return v.Str(), nil
}

func (r *reader) matching(name string, pattern *regexp.Regexp, label string) (string, error) {
	s, err := r.stringField(name)
	if err != nil {
		return "", err
	}
	if !pattern.MatchString(s) {
		return "", wrapf(ErrSchemaViolation, "%s %q is not a valid %s", r.at(name), s, label)
	}
	return s, nil
}

func (r *reader) constant(name, want string) error {
	s, err := r.stringField(name)
	if err != nil {
		return err
	}
	if s != want {
		return wrapf(ErrSchemaViolation, "%s must be %q, got %q", r.at(name), want, s)
	}
	return nil
}

func (r *reader) enum(name string, allowed ...string) (string, error) {
	s, err := r.stringField(name)
	if err != nil {
		return "", err
	}
	for _, candidate := range allowed {
		if s == candidate {
			return s, nil
		}
	}
	return "", wrapf(ErrSchemaViolation, "%s %q is not one of %v", r.at(name), s, allowed)
}

func (r *reader) nullableString(name string, pattern *regexp.Regexp, label string) (*string, error) {
	v, err := r.required(name)
	if err != nil {
		return nil, err
	}
	switch v.Kind() {
	case KindNull:
		return nil, nil
	case KindString:
		if !pattern.MatchString(v.Str()) {
			return nil, wrapf(ErrSchemaViolation, "%s %q is not a valid %s", r.at(name), v.Str(), label)
		}
		s := v.Str()
		return &s, nil
	default:
		return nil, wrapf(ErrSchemaViolation, "%s must be a string or null, got %s", r.at(name), v.Kind())
	}
}

func (r *reader) integer(name string, min, max int64) (int64, error) {
	v, err := r.required(name)
	if err != nil {
		return 0, err
	}
	if v.Kind() != KindInt {
		return 0, wrapf(ErrSchemaViolation, "%s must be an integer, got %s", r.at(name), v.Kind())
	}
	if v.Int() < min || v.Int() > max {
		return 0, wrapf(ErrSchemaViolation, "%s %d is outside %d..%d", r.at(name), v.Int(), min, max)
	}
	return v.Int(), nil
}

func (r *reader) nullableInteger(name string, min, max int64) (*int64, error) {
	v, err := r.required(name)
	if err != nil {
		return nil, err
	}
	switch v.Kind() {
	case KindNull:
		return nil, nil
	case KindInt:
		if v.Int() < min || v.Int() > max {
			return nil, wrapf(ErrSchemaViolation, "%s %d is outside %d..%d", r.at(name), v.Int(), min, max)
		}
		n := v.Int()
		return &n, nil
	default:
		return nil, wrapf(ErrSchemaViolation, "%s must be an integer or null, got %s", r.at(name), v.Kind())
	}
}

func (r *reader) array(name string, maxItems int) ([]Value, error) {
	v, err := r.required(name)
	if err != nil {
		return nil, err
	}
	if v.Kind() != KindArray {
		return nil, wrapf(ErrSchemaViolation, "%s must be an array, got %s", r.at(name), v.Kind())
	}
	if len(v.Items()) > maxItems {
		return nil, wrapf(ErrSchemaViolation, "%s has %d items, the limit is %d", r.at(name), len(v.Items()), maxItems)
	}
	return v.Items(), nil
}

func decodeReference(path string, v Value) (Reference, error) {
	sub, err := newReader(path, v)
	if err != nil {
		return Reference{}, err
	}
	refID, err := sub.matching("refId", uuidPattern, "uuid")
	if err != nil {
		return Reference{}, err
	}
	hash, err := sub.matching("hash", hashPattern, "sha256 digest")
	if err != nil {
		return Reference{}, err
	}
	if err := sub.done(); err != nil {
		return Reference{}, err
	}
	return Reference{RefID: refID, Hash: hash}, nil
}

func (r *reader) reference(name string) (Reference, error) {
	v, err := r.required(name)
	if err != nil {
		return Reference{}, err
	}
	return decodeReference(r.at(name), v)
}

func (r *reader) nullableReference(name string) (*Reference, error) {
	v, err := r.required(name)
	if err != nil {
		return nil, err
	}
	if v.Kind() == KindNull {
		return nil, nil
	}
	ref, err := decodeReference(r.at(name), v)
	if err != nil {
		return nil, err
	}
	return &ref, nil
}

func (r *reader) binding(name string) (Binding, error) {
	sub, err := r.object(name)
	if err != nil {
		return Binding{}, err
	}
	var b Binding
	if b.OrgID, err = sub.matching("orgId", idPattern, "organization id"); err != nil {
		return Binding{}, err
	}
	if b.TaskID, err = sub.matching("taskId", uuidPattern, "uuid"); err != nil {
		return Binding{}, err
	}
	if b.RunID, err = sub.matching("runId", uuidPattern, "uuid"); err != nil {
		return Binding{}, err
	}
	if b.SnapshotID, err = sub.matching("snapshotId", uuidPattern, "uuid"); err != nil {
		return Binding{}, err
	}
	if b.RuntimeVersion, err = sub.matching("runtimeVersion", versionNamePattern, "version name"); err != nil {
		return Binding{}, err
	}
	if err := sub.done(); err != nil {
		return Binding{}, err
	}
	return b, nil
}

func (r *reader) logicalKey(name string) (LogicalKey, error) {
	s, err := r.enum(name, string(LogicalKey1), string(LogicalKey2), string(LogicalKey3))
	if err != nil {
		return "", err
	}
	return LogicalKey(s), nil
}

func (r *reader) hashField(name string) (string, error) {
	return r.matching(name, hashPattern, "sha256 digest")
}

func (r *reader) header(kind DocumentKind) error {
	if err := r.constant("kind", string(kind)); err != nil {
		return err
	}
	version, _ := kind.SchemaVersion()
	return r.constant("schemaVersion", version)
}

func decodeIntent(path string, v Value) (ModelIntent, error) {
	sub, err := newReader(path, v)
	if err != nil {
		return ModelIntent{}, err
	}
	var intent ModelIntent
	if intent.Request, err = sub.reference("request"); err != nil {
		return ModelIntent{}, err
	}
	if intent.RequestHash, err = sub.hashField("requestHash"); err != nil {
		return ModelIntent{}, err
	}
	if intent.LogicalKey, err = sub.logicalKey("logicalKey"); err != nil {
		return ModelIntent{}, err
	}
	if err := sub.done(); err != nil {
		return ModelIntent{}, err
	}
	return intent, nil
}
