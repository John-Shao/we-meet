package egressservice

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"

	"github.com/we-meet/work/internal/canonical"
)

// This file is the closed wire body for POST /runtime/v1/model/invoke. The
// signed contract carries exactly three fields: the execution the capability
// is bound to, the frozen model_request reference and that document's hash.
// Operation, attempt, holder, fence, route, parameters, message text and
// reference graph have no field here and cannot be selected by the caller.
//
// requestRef accepts the reference object the Node child sends,
// {"refId":"<uuid>","hash":"sha256:<hex>"}, and also a bare uuid for callers
// that carry the hash only once. Both shapes are closed: unknown members,
// duplicate keys, invalid Unicode and malformed values are refused.
//
// Decoding is strict in two passes:
//
//  1. canonical.Parse rejects duplicate object keys, invalid Unicode, floats,
//     negative zero and oversized input. encoding/json silently applies
//     "last key wins" and would turn those into an authorization-relevant
//     request the caller did not write.
//  2. encoding/json with DisallowUnknownFields decodes into the closed struct
//     below (and the closed reference object) and refuses trailing data.
type invokeEnvelope struct {
	ExecutionID string            `json:"executionId"`
	RequestRef  referenceEnvelope `json:"requestRef"`
	RequestHash string            `json:"requestHash"`
}

// referenceEnvelope is one content reference on the wire: either a uuid string
// or the full {"refId","hash"} pair. Hash is empty for the bare-uuid form.
type referenceEnvelope struct {
	RefID  string
	Hash   string
	Object bool
}

// UnmarshalJSON implements the two accepted shapes. A null, array, number or
// object with unknown/duplicate members is refused.
func (r *referenceEnvelope) UnmarshalJSON(body []byte) error {
	if len(body) == 0 || string(body) == "null" {
		return errInvalidCall
	}
	if body[0] == '"' {
		var refID string
		if err := json.Unmarshal(body, &refID); err != nil {
			return errInvalidCall
		}
		r.RefID, r.Hash, r.Object = refID, "", false
		return nil
	}
	var object struct {
		RefID string `json:"refId"`
		Hash  string `json:"hash"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&object); err != nil {
		return errInvalidCall
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errInvalidCall
	}
	r.RefID, r.Hash, r.Object = object.RefID, object.Hash, true
	return nil
}

// MarshalJSON renders the shape the value was decoded from.
func (r referenceEnvelope) MarshalJSON() ([]byte, error) {
	if r.Object {
		return json.Marshal(struct {
			RefID string `json:"refId"`
			Hash  string `json:"hash"`
		}{RefID: r.RefID, Hash: r.Hash})
	}
	return json.Marshal(r.RefID)
}

// errInvalidCall is the single shape failure. Its text is never returned.
var errInvalidCall = errors.New("egressservice: invalid invoke envelope")

// decodeInvoke enforces the closed schema. The body ceiling is applied by the
// listener middleware before this function runs.
func decodeInvoke(body []byte) (invokeEnvelope, error) {
	var envelope invokeEnvelope
	if len(body) == 0 {
		return envelope, errInvalidCall
	}
	if _, err := canonical.Parse(body); err != nil {
		return envelope, errInvalidCall
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return invokeEnvelope{}, errInvalidCall
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return invokeEnvelope{}, errInvalidCall
	}
	return envelope, nil
}

// validate checks the fields and the body/header capability binding. A body
// naming another execution can never reach the registry, the gate or the
// provider. When the reference object repeats the hash, it must agree with
// requestHash; two different hashes for one reference are ambiguous.
func (e invokeEnvelope) validate(presentedExecution string) error {
	if !uuidPattern.MatchString(e.ExecutionID) ||
		!uuidPattern.MatchString(e.RequestRef.RefID) ||
		!canonical.ValidHash(e.RequestHash) {
		return errInvalidCall
	}
	if e.RequestRef.Object {
		if !canonical.ValidHash(e.RequestRef.Hash) || e.RequestRef.Hash != e.RequestHash {
			return errInvalidCall
		}
	}
	if presentedExecution == "" || e.ExecutionID != presentedExecution {
		return errInvalidCall
	}
	return nil
}
