package api

import (
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
)

// RunHistoryHandbackPath is the §1.4 GET /runs/{id}/history-handback row under the /work/v2
// prefix that table declares for all of its relative paths.
const RunHistoryHandbackPath = "/work/v2/runs/{runId}/history-handback"

// getRunHistoryHandback answers the half of device-design §3.3 that batch 6 registered as NOT
// done: "租约过期不等于设备失去交回历史的通道 … 界面在此情形下应显示'正在交回历史并收尾'，不是
// '任务卡住'". The mechanism - a device minting a same-session reconcile_finish lease after a
// reconnect and finishing under it - became reachable in batch 6 (0061), and the sentence's
// display obligation is what this face serves.
//
// The answer is one boolean read off the ledger, not off the device: work.run_history_handback
// (0062) reports whether the Run has a live reconcile_finish lease. 0040:876-877 allows one
// active lease per Run regardless of purpose, so that single fact is the whole judgment and a Run
// still holding an execute lease answers false. The Run's own state is deliberately not restated
// here: control design §4.2's rule that a local Run's wrap-up must not invent a
// `waiting→succeeded` edge (line 296; run.waiting's legal exits are active/failed/cancel_requested
// at 0002:518-520) is why this is a projection shown ALONGSIDE run.state rather than a new state,
// a new wait_reason member, or a new key in the frozen R0a Run schema
// (r0a-openapi-v1.yaml:1147-1148 closes that one).
//
// What the client sees is the function's jsonb verbatim - the same convention
// work.list_run_reconciliations set (0021 §4.2 段末 ⑨): the SQL owns the shape, Go does not
// reshape it. Nothing in the response is body content: no artifact, no content reference, no
// provider text. Permission is §1.4's "owner plus a current seat", read-only and stateless, and
// the two not-found branches in 0062 keep the §1.4 idiom - somebody else's Run answers exactly
// like a missing one, because a 403 would confirm the Run is real.
func (s *Server) getRunHistoryHandback(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	// An id that is not even a UUID is refused as run_not_found before reaching the database, the
	// same distinction §1.4's reconciliations row documents: the client can tell "the id I passed
	// is malformed" from "that Run is not mine" without either answer confirming an existence.
	runID := r.PathValue("runId")
	if !validUUID(runID) {
		writeAPIError(w, correlationID, apierr.New("run_not_found"))
		return
	}
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
				`SELECT work.run_history_handback($1, $2::uuid, $3)`,
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
