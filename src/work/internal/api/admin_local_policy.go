package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
)

// AdminLocalPolicyPath lives under /work/v2 because §1.4 opens "所有下列相对路径均在
// /work/v2", and its row writes GET/PATCH /admin/local-policy. The shipped R0a admin faces
// are /work/v1/admin/*, so this is the first admin route in the v2 group: same handler
// plumbing, different prefix, because the version is part of the contract this table
// registers rather than a detail of where the handler sits.
const AdminLocalPolicyPath = "/work/v2/admin/local-policy"

// localPolicyDocument is §4.1's local_execution_policy column set under exactly those
// names, because §1.4 pins this endpoint's request and response fields to the table and
// forbids a second DTO for the same facts.
//
// Values stay raw json deliberately. The closed sets, the rule-element shape, the
// "ceiling may not be looser than the determination" comparison, the floor comparison and
// the numeric bounds are all decided by work.set_local_policy in SQL; re-checking any of
// them here would create a second authority that can drift from the first, which is how
// §13's whole "两处各自推导" class of bug starts. What this struct does enforce is the key
// set: an unknown field is a refused request rather than something the command never
// looks at.
type localPolicyDocument struct {
	AllowedTools                   json.RawMessage `json:"allowed_tools"`
	AllowedDestinations            json.RawMessage `json:"allowed_destinations"`
	ClassificationRules            json.RawMessage `json:"classification_rules"`
	ClassificationDefault          json.RawMessage `json:"classification_default"`
	ClassificationDefaultConfirmed json.RawMessage `json:"classification_default_confirmed"`
	ClassificationFloor            json.RawMessage `json:"classification_floor"`
	ReadonlyMaxActions             json.RawMessage `json:"readonly_max_actions"`
	ReadonlyTTL                    json.RawMessage `json:"readonly_ttl"`
	InputLimitBytes                json.RawMessage `json:"input_limit_bytes"`
	OutputLimitBytes               json.RawMessage `json:"output_limit_bytes"`
}

// localPolicyWriteRequest is the PATCH body: the document, the compare-and-set
// precondition, and the request id that lands in the audit row.
//
// client_request_id is this API's shipped name for that field (admin.go:42, inputs.go:31)
// and §4.1's own governance_change column, so it is the wire name here even though §1.4's
// local-policy row and set_local_policy's parameter both say "request_id" - one concept,
// one name.
//
// There is no idempotent replay, and it is not missing: set_local_policy records the
// request id but keeps no receipt, because the CAS already decides. A client that loses
// the response and retries with the same expected revision is refused with
// governance_revision_conflict - the first write landed - which is the honest answer for
// a policy write, where replay must not silently bump the revision a second time.
type localPolicyWriteRequest struct {
	Revision        *int64  `json:"revision"`
	ClientRequestID *string `json:"client_request_id"`
	localPolicyDocument
}

// policyJSON rebuilds the document for the command, dropping keys the client omitted so
// that an absent bound reaches SQL as absent rather than as null-with-a-value.
func (d localPolicyDocument) policyJSON() ([]byte, error) {
	fields := map[string]json.RawMessage{
		"allowed_tools":                    d.AllowedTools,
		"allowed_destinations":             d.AllowedDestinations,
		"classification_rules":             d.ClassificationRules,
		"classification_default":           d.ClassificationDefault,
		"classification_default_confirmed": d.ClassificationDefaultConfirmed,
		"classification_floor":             d.ClassificationFloor,
		"readonly_max_actions":             d.ReadonlyMaxActions,
		"readonly_ttl":                     d.ReadonlyTTL,
		"input_limit_bytes":                d.InputLimitBytes,
		"output_limit_bytes":               d.OutputLimitBytes,
	}
	for name, value := range fields {
		if len(value) == 0 {
			delete(fields, name)
		}
	}
	return json.Marshal(fields)
}

// readLocalPolicy calls the admin read command, which asserts an active owner/admin of
// this organization and binds the actor to the session subject. The document is returned
// verbatim: get_local_policy already reports the column names plus the gate verdict, and
// re-shaping it in Go would put a second copy of the contract here.
func (s *Server) readLocalPolicy(ctx context.Context, tx pgx.Tx, orgID, subjectID string) (json.RawMessage, error) {
	var view []byte
	if err := tx.QueryRow(ctx, `SELECT work.get_local_policy($1, $2)`, orgID, subjectID).Scan(&view); err != nil {
		return nil, err
	}
	return json.RawMessage(view), nil
}

func (s *Server) adminGetLocalPolicy(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	var view json.RawMessage
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			var readErr error
			view, readErr = s.readLocalPolicy(r.Context(), tx, claims.OrgID, claims.SubjectID)
			return readErr
		},
	)
	if err != nil {
		s.writeAdminError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) adminSetLocalPolicy(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if !s.verifyCSRF(w, r, claims, correlationID) {
		return
	}
	var body localPolicyWriteRequest
	// The body limit is transport hygiene, not a domain rule: `classification_rules`
	// is handed to the SQL validator as jsonb and bounds the document only by content,
	// so without a byte cap one request could pin memory (ReadTimeout caps duration, not
	// size). 64 KiB matches the precedent in previews.go; the semantic ceilings still
	// live in work.local_execution_policy_rules_valid.
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	// decodeStrictJSONBody, not a bare Decode: this file shipped with
	// DisallowUnknownFields plus one Decode, which still accepts `{} {}` and acts on the
	// first object while a proxy or a log sees two - the exact defect decode.go:11-16
	// records for previews.go.
	if err := decodeStrictJSONBody(r.Body, &body); err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	if body.Revision == nil || *body.Revision < 0 {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	requestID := ""
	if body.ClientRequestID != nil {
		requestID = *body.ClientRequestID
	}
	if len(requestID) < 8 || len(requestID) > 128 || strings.TrimSpace(requestID) != requestID {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	document, err := body.localPolicyDocument.policyJSON()
	if err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}

	var view json.RawMessage
	err = workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			if _, err := tx.Exec(r.Context(),
				`SELECT work.set_local_policy($1, $2, $3::jsonb, $4, $5)`,
				claims.OrgID, *body.Revision, string(document), claims.SubjectID, requestID,
			); err != nil {
				return err
			}
			// The response is the row as the server now holds it, including the gate
			// verdict the write produced: §1.2/§8.4 all ask the same question of
			// local_policy_gate, and an administrator who just wrote a policy must not have
			// to guess whether it opened the local face.
			var readErr error
			view, readErr = s.readLocalPolicy(r.Context(), tx, claims.OrgID, claims.SubjectID)
			return readErr
		},
	)
	if err != nil {
		s.writeAdminError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}
