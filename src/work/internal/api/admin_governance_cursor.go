package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
)

// AdminGovernanceEventCursorPath is under /work/v2 for the same reason as the local-policy
// face: §1.4 registers every relative path in that table beneath /work/v2, and its row for
// this command spells the path as /admin/governance-event-cursor.
const AdminGovernanceEventCursorPath = "/work/v2/admin/governance-event-cursor"

// governanceCursorRequest is the J7 first step's whole input surface: which position to
// jump to, which Host-attested gap report authorises that interval, the external ticket,
// and the request id the idempotent receipt is keyed on.
//
// org is taken from the session, never from the body: §1.4 lists org_id among the
// command's inputs, but on this API the tenant is the authenticated session's own
// organization (every other admin command behaves this way) and the command refuses a
// p_org_id that differs from app.org_id regardless.
type governanceCursorRequest struct {
	ToSeq           *int64  `json:"to_seq"`
	GapReportID     *string `json:"gap_report_id"`
	TicketID        *string `json:"ticket_id"`
	ClientRequestID *string `json:"client_request_id"`
}

func trimmedPointer(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

// adminAdvanceGovernanceCursor is the only caller-reachable path for
// work.advance_governance_event_cursor. The command jumps the cursor over an interval the
// Host enumerated, registers the skipped seat events as consumed-but-never-releasing, and
// marks the denys those events could have released as reconcile_required. It releases
// nothing, and §3.1's order is fixed: this step first, then an explicit re-grant through
// ChangeSeat.
//
// The response is the command's own closed document - {org_id, gap_report_id,
// last_event_seq} - and deliberately carries no deny counts. §1.4's row still names §1.2's
// GovernanceChange shape, but that envelope cannot represent this operation:
// governance_change.target_kind is the closed set seat|assignment|entitlement (§4.1), and
// §4.1 ④ fixes the idempotent receipt for this command as the governance_gap_skipped audit
// row rather than a second ledger, so there is no change row to report. The counts were
// already removed from the response once (R10A-14), and the affected-deny list lives in the
// audit and the report row.
func (s *Server) adminAdvanceGovernanceCursor(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if !s.verifyCSRF(w, r, claims, correlationID) {
		return
	}
	var body governanceCursorRequest
	// Transport cap, not a domain rule (see the same note in admin_local_policy.go).
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := decodeStrictJSONBody(r.Body, &body); err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	if body.ToSeq == nil || *body.ToSeq < 0 {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	reportID := trimmedPointer(body.GapReportID)
	if reportID == "" {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	// The request id is the key the idempotent receipt is found by, so it is taken exactly
	// as sent: surrounding whitespace would make a retry look like a different request and
	// jump a second interval. The 8-character floor is R0a's published convention for
	// `client_request_id` (commit b66d0e4df gave the cancel endpoint the same minLength 8 for
	// the same reason: a receipt key that collides by accident is worse than a rejected
	// request), and §1.4 line 88 now says so instead of "not blank".
	rawRequestID := ""
	if body.ClientRequestID != nil {
		rawRequestID = *body.ClientRequestID
	}
	requestID := strings.TrimSpace(rawRequestID)
	if len(requestID) < 8 || requestID != rawRequestID || len(requestID) > 128 {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	// ticket_id is passed through unvalidated on purpose: the command refuses a blank one
	// with cursor_advance_not_allowed, and §3.1's requirement that the ticket point at a
	// record visible outside this system is not something this process can check.
	ticketID := trimmedPointer(body.TicketID)

	var view json.RawMessage
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(),
				`SELECT work.advance_governance_event_cursor($1, $2, $3::uuid, $4, $5, $6)`,
				claims.OrgID, *body.ToSeq, reportID, ticketID, claims.SubjectID, requestID,
			).Scan(&raw); err != nil {
				return err
			}
			view = json.RawMessage(append([]byte(nil), raw...))
			return nil
		},
	)
	if err != nil {
		s.writeAdminError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}
