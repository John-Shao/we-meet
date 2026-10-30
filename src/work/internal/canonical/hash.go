package canonical

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"unicode/utf8"
)

// HashForm distinguishes the two hash kinds §8.1 keeps apart: the
// domain-prefixed document digest and the plain body digest. A reference
// registry must record the kind, so a caller can never substitute one for the
// other ("不能混用正文 hash 与请求 hash").
type HashForm uint8

const (
	// HashFormDocument is sha256(schemaVersion + "\n" + canonical_json).
	HashFormDocument HashForm = iota + 1
	// HashFormBody is plain UTF-8 SHA-256 over the stored bytes, no domain.
	HashFormBody
)

func (f HashForm) String() string {
	switch f {
	case HashFormDocument:
		return "document"
	case HashFormBody:
		return "body"
	default:
		return "unknown"
	}
}

// DocumentKind is the kind field of the three immutable documents.
type DocumentKind string

const (
	KindModelRequest   DocumentKind = "model_request"
	KindCanonicalState DocumentKind = "canonical_state"
	KindModelReceipt   DocumentKind = "model_receipt"
)

// SchemaVersion returns the hash domain prefix for a document kind.
func (k DocumentKind) SchemaVersion() (string, bool) {
	switch k {
	case KindModelRequest:
		return SchemaVersionModelRequest, true
	case KindCanonicalState:
		return SchemaVersionCanonicalState, true
	case KindModelReceipt:
		return SchemaVersionModelReceipt, true
	default:
		return "", false
	}
}

// ReferenceKind is the Content Store object kind a StoredReference points at.
// Document kinds hash with HashFormDocument; body kinds hash with
// HashFormBody.
type ReferenceKind string

const (
	RefKindModelRequest   ReferenceKind = "model_request"
	RefKindCanonicalState ReferenceKind = "canonical_state"
	RefKindModelReceipt   ReferenceKind = "model_receipt"

	RefKindTaskInputBody      ReferenceKind = "task_input_body"
	RefKindSystemTemplateBody ReferenceKind = "system_template_body"
	RefKindPublicAnswerBody   ReferenceKind = "public_answer_body"
	RefKindArtifactBody       ReferenceKind = "artifact_body"
	RefKindRejectionEvidence  ReferenceKind = "rejection_evidence_body"
)

// HashForm reports which hash form a reference kind uses.
func (k ReferenceKind) HashForm() (HashForm, error) {
	switch k {
	case RefKindModelRequest, RefKindCanonicalState, RefKindModelReceipt:
		return HashFormDocument, nil
	case RefKindTaskInputBody, RefKindSystemTemplateBody, RefKindPublicAnswerBody,
		RefKindArtifactBody, RefKindRejectionEvidence:
		return HashFormBody, nil
	default:
		return 0, wrapf(ErrSchemaViolation, "unknown reference kind %q", string(k))
	}
}

// DocumentKind maps a document reference kind to its document kind.
func (k ReferenceKind) DocumentKind() (DocumentKind, error) {
	switch k {
	case RefKindModelRequest:
		return KindModelRequest, nil
	case RefKindCanonicalState:
		return KindCanonicalState, nil
	case RefKindModelReceipt:
		return KindModelReceipt, nil
	default:
		return "", wrapf(ErrHashFormMismatch, "reference kind %q is not a document kind", string(k))
	}
}

var hashPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// ValidHash reports whether s is a lowercase sha256:<hex> digest.
func ValidHash(s string) bool { return hashPattern.MatchString(s) }

func digest(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// HashCanonical computes sha256(domain + "\n" + canonical_json) and enforces
// the 256 KiB limit on the prefixed encoding, exactly as §8.1 item 3 states.
// domain must be one of the three schema version strings.
func HashCanonical(domain string, v Value) (string, error) {
	switch domain {
	case SchemaVersionModelRequest, SchemaVersionCanonicalState, SchemaVersionModelReceipt:
	default:
		return "", wrapf(ErrUnsupportedSchemaVersion, "%q is not a canonical hash domain", domain)
	}
	body, err := Encode(v)
	if err != nil {
		return "", err
	}
	prefixed := make([]byte, 0, len(domain)+1+len(body))
	prefixed = append(prefixed, domain...)
	prefixed = append(prefixed, '\n')
	prefixed = append(prefixed, body...)
	if len(prefixed) > MaxDocumentBytes {
		return "", wrapf(ErrDocumentTooLarge, "%d prefixed bytes exceeds the %d byte limit", len(prefixed), MaxDocumentBytes)
	}
	return digest(prefixed), nil
}

// HashValue derives the domain from the value's own kind field and requires
// schemaVersion to agree with it, mirroring documentHash in
// runtime-recovery.model.mjs.
func HashValue(v Value) (string, error) {
	if v.Kind() != KindObject {
		return "", wrapf(ErrSchemaViolation, "a document must be a JSON object, got %s", v.Kind())
	}
	kindValue, ok := v.Lookup("kind")
	if !ok || kindValue.Kind() != KindString {
		return "", wrapf(ErrMissingField, "document is missing a string kind field")
	}
	domain, known := DocumentKind(kindValue.Str()).SchemaVersion()
	if !known {
		return "", wrapf(ErrUnsupportedSchemaVersion, "unsupported document kind %q", kindValue.Str())
	}
	versionValue, ok := v.Lookup("schemaVersion")
	if !ok || versionValue.Kind() != KindString || versionValue.Str() != domain {
		return "", wrapf(ErrUnsupportedSchemaVersion, "schemaVersion must be %q for kind %q", domain, kindValue.Str())
	}
	return HashCanonical(domain, v)
}

// HashDocumentBytes parses raw document bytes with the strict reader and
// returns the document hash. This is the gateway's recompute path: it must
// reject anything the writer could have slipped past a lenient parser.
func HashDocumentBytes(raw []byte) (string, error) {
	v, err := Parse(raw)
	if err != nil {
		return "", err
	}
	return HashValue(v)
}

// BodyHash computes the plain UTF-8 SHA-256 of original input or public
// answer bytes. There is no domain prefix: §8.1 reserves the prefixed form
// for the three JSON documents and the raw form for bodies. R0a bodies are
// text, so invalid UTF-8 is rejected rather than hashed.
func BodyHash(body []byte) (string, error) {
	if len(body) > MaxBodyBytes {
		return "", wrapf(ErrDocumentTooLarge, "%d body bytes exceeds the %d byte limit", len(body), MaxBodyBytes)
	}
	if !utf8.Valid(body) {
		return "", wrapf(ErrInvalidUnicode, "body is not well-formed UTF-8")
	}
	return digest(body), nil
}

// HashForKind computes the hash of payload using the form required by kind.
// For document kinds the payload is parsed strictly and its kind field must
// match; for body kinds the payload is hashed raw.
func HashForKind(kind ReferenceKind, payload []byte) (string, error) {
	form, err := kind.HashForm()
	if err != nil {
		return "", err
	}
	if form == HashFormBody {
		return BodyHash(payload)
	}
	want, err := kind.DocumentKind()
	if err != nil {
		return "", err
	}
	v, err := Parse(payload)
	if err != nil {
		return "", err
	}
	kindValue, ok := v.Lookup("kind")
	if !ok || kindValue.Kind() != KindString || DocumentKind(kindValue.Str()) != want {
		return "", wrapf(ErrSchemaViolation, "payload is not a %q document", string(want))
	}
	return HashValue(v)
}

// VerifyReference recomputes the hash of payload for the registered reference
// kind and compares it with the reference. It never falls back to the other
// hash form: a body verified as a document (or the reverse) is an error.
func VerifyReference(kind ReferenceKind, ref Reference, payload []byte) error {
	if err := ref.Validate("reference"); err != nil {
		return err
	}
	got, err := HashForKind(kind, payload)
	if err != nil {
		return err
	}
	if got != ref.Hash {
		return wrapf(ErrHashMismatch, "reference %s expects %s but %s payload hashes to %s", ref.RefID, ref.Hash, kind, got)
	}
	return nil
}
