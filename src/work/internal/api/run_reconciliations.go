package api

import (
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
)

// RunReconciliationsPath is §1.4's GET /runs/{id}/reconciliations under the /work/v2 prefix
// that table declares for all of its relative paths.
const RunReconciliationsPath = "/work/v2/runs/{runId}/reconciliations"

// getRunReconciliations answers the "what is this waiting on, and who signed what" question
// that J16/R12C-2 put on the client side: the wait clock, which mandatory outcome is
// currently blocked, whether server-side authority already exists, and whether a J38
// verdict has been signed - the three states §1.4 names as pending, downgraded_readonly and
// evidence_exhausted. Before this face existed those facts lived only in a work-reconcile
// job outside the product, so "无法定论" was something an operator could say but a customer
// could not see.
//
// Everything in the response is metadata: the command reads no artifact body, no content
// reference and no provider text, and the Run must belong to the caller's own task - a Run
// under somebody else's ownership answers as not-found rather than as forbidden, because a
// 403 here would still disclose that a stuck Run exists.
func (s *Server) getRunReconciliations(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	runID := r.PathValue("runId")
	if !validUUID(runID) {
		writeAPIError(w, correlationID, apierr.New("run_not_found"))
		return
	}
	// §1.4's permission column for this row is owner plus a current seat: the seat check is
	// the same one the task reads use, and it is a read gate rather than an execution one.
	if err := s.requireSeat(r.Context(), claims); err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}

	var view json.RawMessage
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			var raw []byte
			if err := tx.QueryRow(r.Context(),
				`SELECT work.list_run_reconciliations($1, $2::uuid, $3)`,
				claims.OrgID, runID, claims.SubjectID).Scan(&raw); err != nil {
				return err
			}
			view = json.RawMessage(append([]byte(nil), raw...))
			return nil
		},
	)
	if err != nil {
		s.writeAccessError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}
