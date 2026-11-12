package migrate

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	embedded "github.com/we-meet/work/migrations"
)

// Tests for increment 0043: artifact_replica, consumed_possession_nonce, the two local
// write commands, and the rebind restatement.
//
// The claims these cover are the ones the increment exists for.
//   * (B) takes the STRICTEST classification of its three input arms and refuses a looser
//     claim, including a classification that only ever appears through a grant succession
//     (EV97). An empty input set is a floor, not a guess.
//   * work.artifact_replica has exactly one writer: no runtime role holds a table
//     privilege on it, every shipped INSERT but finalize's is refused by the content
//     guard or the closed sets, and across the whole embedded chain exactly one statement
//     inserts into it.
//   * A possession nonce is spent once per organization by BOTH signature frames, and a
//     refusal after the spend leaves no nonce row behind.
//   * The user save records no replica row, because it carries no server-verifiable
//     device evidence; and its dedupe identity includes the unsigned local_ref, so moving
//     the pointer is a conflict rather than a silent re-point.
//   * O-18: the finalize gate reads THIS Run's unknown/unresolved operations, and a
//     Task-level blocker deliberately does not stop it.

// hex64 derives a distinct, shape-valid 64-hex value from a label, so the request hashes
// and content hashes in these tests are reproducible and never collide by accident.
func hex64(label string) string {
	sum := sha256.Sum256([]byte(label))
	return hex.EncodeToString(sum[:])
}

func jstr(v string) string { return `"` + v + `"` }

// jopt emits a JSON string, or null when the caller passed no value.
func jopt(v string) string {
	if v == "" {
		return "null"
	}
	return jstr(v)
}

type refusal struct {
	code   string
	state  string
	detail string
}

// refuse is the exact-match counterpart of expectCode. expectCode's Contains test cannot
// tell not_found from run_not_found or artifact_not_found, and 0043 raises all three from
// neighbouring statements, so this batch pins the message and the SQLSTATE instead.
func refuse(t *testing.T, conn *pgx.Conn, sql string, args ...any) refusal {
	t.Helper()
	var body []byte
	err := conn.QueryRow(testContext(t), sql, args...).Scan(&body)
	if err == nil {
		t.Fatalf("expected a refusal, got a result: %s", string(body))
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		t.Fatalf("error %#v is not a *pgconn.PgError", err)
	}
	return refusal{code: pgErr.Message, state: pgErr.Code, detail: pgErr.Detail}
}

func expectRefused(t *testing.T, conn *pgx.Conn, wantCode, wantState, sql string, args ...any) refusal {
	t.Helper()
	got := refuse(t, conn, sql, args...)
	if got.code != wantCode {
		t.Fatalf("expected error %q, got %q (SQLSTATE %s, detail %q)", wantCode, got.code, got.state, got.detail)
	}
	if wantState != "" && got.state != wantState {
		t.Fatalf("%q raised SQLSTATE %s, want %s", wantCode, got.state, wantState)
	}
	return got
}

// expectConstraint matches a shipped constraint or trigger name inside the database
// error, used for the structural refusals that arrive as check/FK/trigger violations
// rather than as RAISE'd codes.
func expectConstraint(t *testing.T, conn *pgx.Conn, want, sql string, args ...any) {
	t.Helper()
	got := refuse(t, conn, sql, args...)
	if !strings.Contains(got.code, want) && !strings.Contains(got.detail, want) {
		t.Fatalf("expected a refusal naming %q, got %q / %q", want, got.code, got.detail)
	}
}

func countRows(t *testing.T, admin *pgx.Conn, sql string) int {
	t.Helper()
	var n int
	if err := admin.QueryRow(testContext(t), sql).Scan(&n); err != nil {
		t.Fatalf("count: %v (%s)", err, sql)
	}
	return n
}

func mustScalar(t *testing.T, admin *pgx.Conn, sql string) string {
	t.Helper()
	var out string
	if err := admin.QueryRow(testContext(t), sql).Scan(&out); err != nil {
		t.Fatalf("scalar: %v (%s)", err, sql)
	}
	return out
}

// ---------------------------------------------------------------------------
// finalize fixture
// ---------------------------------------------------------------------------

// localArtifactFixture is the action fixture plus a grant whose tool allowlist carries
// artifact.write, and the session identity fields record_device_receipt compares.
// Everything below the lease is reused rather than rebuilt.
type localArtifactFixture struct {
	*actionFixture
	writeGrant string
	journal    string
	agentID    string
	bootID     string
	generation string
}

func newLocalArtifactFixture(t *testing.T, org string) *localArtifactFixture {
	t.Helper()
	a := newActionFixture(t, org)
	api := a.apiConn(t)
	// Rule 1 of the fixture policy maps to remote_excerpt_allowed, so this grant is the
	// looser one and can demonstrate that (B) does not take the output root's own value.
	g := callJSON(t, api,
		`SELECT work.register_workspace_grant($1,$2,'bearer',7,$3::uuid,$4::uuid,$5,$6::jsonb)`,
		a.org, a.subject, a.deviceID, a.sessionID, "req-b4-grant-write",
		`{"root_identity_hash":"`+strings.Repeat("9", 64)+
			`","allowed_tools":["workspace.read","artifact.write"],"matched_rule_index":1,`+
			`"user_selected_ttl_seconds":3600}`)
	grantID, _ := g["grant_id"].(string)
	if grantID == "" {
		t.Fatalf("artifact.write grant not registered: %#v", g)
	}
	ident := mustScalar(t, a.admin, "SELECT journal_epoch::text || '|' || agent_instance_id::text || "+
		"'|' || boot_id || '|' || generation::text FROM work.device_session WHERE id = "+quoteLiteral(a.sessionID))
	parts := strings.Split(ident, "|")
	if len(parts) != 4 {
		t.Fatalf("unexpected session identity %q", ident)
	}
	return &localArtifactFixture{actionFixture: a, writeGrant: grantID,
		journal: parts[0], agentID: parts[1], bootID: parts[2], generation: parts[3]}
}

// grantClass reads the server's own classification for a grant, which is the only value a
// prepare claim may match or exceed.
func (l *localArtifactFixture) grantClass(t *testing.T, grantID string) string {
	t.Helper()
	return mustScalar(t, l.admin, "SELECT classification FROM work.workspace_grant WHERE id = "+quoteLiteral(grantID))
}

// prepareAction runs one local action through prepare_local_operation and returns its
// operation and attempt ids. request_hash is derived from the step key so a replay of the
// same step matches, and a different step never collides.
func (l *localArtifactFixture) prepareAction(t *testing.T, worker *pgx.Conn, stepKey, kind, grantID string) (string, string) {
	t.Helper()
	rev := mustScalar(t, l.admin, "SELECT grant_revision::text FROM work.workspace_grant WHERE id = "+quoteLiteral(grantID))
	body := `{"prepare_id":"` + newUUID(t) + `","step_key":"` + stepKey + `","supersede_no":0,` +
		`"logical_key":"` + stepKey + `#0","supersedes_operation_id":null,"supersede_reason":null,` +
		`"supersede_assertion":null,"checkpoint_hash":"` + l.checkpointHash + `",` +
		`"request_hash":"` + hex64("b4-action|"+stepKey) + `","action_kind":"` + kind +
		`","tool_schema":"` + kind + `-v1","local_payload_ref":"local/payload","grant_id":"` + grantID +
		`","grant_revision":` + rev + `,"resource_selector_hash":"` + hex64("selector|"+stepKey) +
		`","classification":"` + l.grantClass(t, grantID) + `","destination_id":null,` +
		`"byte_upper_bound":2048,"token_upper_bound":64,` +
		`"device_signature":"sha256:` + strings.Repeat("2", 64) + `"}`
	out := callJSON(t, worker,
		`SELECT work.prepare_local_operation($1,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8::jsonb)`,
		l.org, l.runID, l.deviceID, l.sessionID, l.leaseID, l.fence, l.checkpointSeq, body)
	opID, _ := out["operation_id"].(string)
	attemptID, _ := out["attempt_id"].(string)
	if opID == "" || attemptID == "" {
		t.Fatalf("prepare %s returned %#v", stepKey, out)
	}
	return opID, attemptID
}

// recordReceipt appends one receipt for one action through record_device_receipt, the
// shipped writer, so the receipt_ref finalize later resolves is the product's own
// journal_epoch:seq rather than a value invented here.
func (l *localArtifactFixture) recordReceipt(t *testing.T, worker *pgx.Conn, opID, attemptID, stepKey,
	state, outcome, localRef string, seq int) string {
	t.Helper()
	exec := `{"org_id":` + jstr(l.org) + `,"subject_id":` + jstr(l.subject) +
		`,"device_id":` + jstr(l.deviceID) + `,"session_id":` + jstr(l.sessionID) +
		`,"agent_instance_id":` + jstr(l.agentID) + `,"boot_id":` + jstr(l.bootID) +
		`,"generation":` + l.generation + `,"run_id":` + jstr(l.runID) +
		`,"operation_id":` + jstr(opID) + `,"attempt_id":` + jstr(attemptID) +
		`,"fence":` + strconv.FormatInt(l.fence, 10) + `}`
	elem := `{"receipt_seq":` + strconv.Itoa(seq) + `,"original_execution":` + exec +
		`,"request_hash":` + jstr(hex64("b4-receipt|"+stepKey+"|"+state)) +
		`,"state":` + jstr(state) + `,"outcome":` + jopt(outcome) +
		`,"result_hash":null,"local_result_ref":` + jopt(localRef) +
		`,"error_code":null,"usage":null,"usage_source":null,` +
		`"signature":"sha256:` + strings.Repeat("a", 64) + `"}`
	out := callJSON(t, worker, `SELECT work.record_device_receipt($1,$2::uuid,$3::uuid,$4::jsonb)`,
		l.org, l.deviceID, l.journal, `[`+elem+`]`)
	if conflicts, ok := out["conflicts"].([]any); !ok || len(conflicts) != 0 {
		t.Fatalf("receipt %d was not accepted: %#v", seq, out)
	}
	if rec, ok := out["recorded"].([]any); !ok || len(rec) != 1 {
		t.Fatalf("receipt %d recorded nothing: %#v", seq, out)
	}
	return l.journal + ":" + strconv.Itoa(seq)
}

// versionPayload is the closed 10-key LocalArtifactVersion. artifact_id arrives as the
// raw JSON fragment the caller supplies, because null means "merge by logical_name".
func (l *localArtifactFixture) versionPayload(versionID, artifactID, logicalName, contentHash,
	localRef, deviceID, receiptRef, claimed string, bytes int64) string {
	if artifactID == "" {
		artifactID = "null"
	}
	return `{"version_id":` + jstr(versionID) + `,"artifact_id":` + artifactID +
		`,"logical_name":` + jstr(logicalName) + `,"format":` + jstr("text/markdown") +
		`,"content_hash":` + jstr(contentHash) + `,"byte_count":` + strconv.FormatInt(bytes, 10) +
		`,"local_ref":` + jstr(localRef) + `,"device_id":` + jstr(deviceID) +
		`,"classification_claimed":` + jstr(claimed) + `,"receipt_ref":` + jstr(receiptRef) + `}`
}

func (l *localArtifactFixture) finalize(t *testing.T, worker *pgx.Conn, runID, opID, payload string) map[string]any {
	t.Helper()
	return callJSON(t, worker, `SELECT work.finalize_local_artifact($1,$2::uuid,$3::uuid,$4::jsonb)`,
		l.org, runID, opID, payload)
}

func (l *localArtifactFixture) finalizeRefused(t *testing.T, worker *pgx.Conn, runID, opID, payload string) refusal {
	t.Helper()
	return refuse(t, worker, `SELECT work.finalize_local_artifact($1,$2::uuid,$3::uuid,$4::jsonb)`,
		l.org, runID, opID, payload)
}

// writeCounts is the side-effect census every refusal in this batch is checked against:
// a blocked finalize must leave all four tables untouched.
func (l *localArtifactFixture) writeCounts(t *testing.T) string {
	t.Helper()
	return mustScalar(t, l.admin, "SELECT (SELECT count(*) FROM work.artifact WHERE org_id = "+quoteLiteral(l.org)+
		")::text || '/' || (SELECT count(*) FROM work.artifact_version WHERE org_id = "+quoteLiteral(l.org)+
		")::text || '/' || (SELECT count(*) FROM work.artifact_replica WHERE org_id = "+quoteLiteral(l.org)+
		")::text || '/' || (SELECT count(*) FROM work.audit_event WHERE org_id = "+quoteLiteral(l.org)+
		" AND action = 'artifact.local_finalize')::text")
}

func TestR0bFinalizeWritesVersionReplicaAndDerivation(t *testing.T) {
	l := newLocalArtifactFixture(t, "org_b4_finalize_happy")
	worker := l.workerConn(t)

	opID, attemptID := l.prepareAction(t, worker, "artifact:1", "artifact.write", l.writeGrant)
	localRef := "local/out/report.md"
	receiptRef := l.recordReceipt(t, worker, opID, attemptID, "artifact:1", "started", "", localRef, 1)

	versionID := newUUID(t)
	contentHash := hex64("b4-content-v1")
	// The explicit-target branch (:514) reads work.artifact and refuses when the id is not
	// this Task's, so the draft row has to be there first - finalize only mints one when the
	// payload names NO artifact, never when it names a stranger.
	artifactID := newUUID(t)
	mustExec(t, l.admin, "INSERT INTO work.artifact (id, org_id, task_id, logical_name, state) VALUES ("+
		quoteLiteral(artifactID)+", "+quoteLiteral(l.org)+", "+quoteLiteral(l.taskID)+
		", 'reports/final.md', 'draft')")
	out := l.finalize(t, worker, l.runID, opID,
		l.versionPayload(versionID, jstr(artifactID), "reports/final.md", contentHash, localRef,
			l.deviceID, receiptRef, "remote_excerpt_allowed", 1024))

	// The claimed value is remote_excerpt_allowed and the output root's own grant is the
	// same, so this first case is about the write set rather than the derivation.
	if out["replayed"] != false || out["version_no"] != float64(1) || out["location"] != "local_only" {
		t.Fatalf("finalize = %#v", out)
	}
	if out["version_id"] != versionID || out["hash"] != contentHash || out["local_ref"] != localRef {
		t.Fatalf("finalize echoed the wrong identity: %#v", out)
	}
	if out["classification"] != "remote_excerpt_allowed" {
		t.Fatalf("derived classification = %v", out["classification"])
	}
	// The ack is recomputed from the two values the shipped expression reads, not copied
	// from the output.
	wantAck := "sha256:" + mustScalar(t, l.admin,
		"SELECT work.sha256_text('local_publish_ack|'||"+quoteLiteral(versionID)+
			"::uuid::text||'|'||"+quoteLiteral(contentHash)+")")
	if out["publish_ack"] != wantAck {
		t.Fatalf("publish_ack = %v, want %s", out["publish_ack"], wantAck)
	}

	if got := l.scalar(t, "SELECT state || '/' || location || '/' || (content_ref IS NULL)::text || '/' || "+
		"classification || '/' || local_ref || '/' || (device_id = "+quoteLiteral(l.deviceID)+")::text || '/' || "+
		"(provenance ->> 'source') FROM work.artifact_version WHERE org_id = "+quoteLiteral(l.org)+
		" AND version_id = "+quoteLiteral(versionID)); got != "published/local_only/true/remote_excerpt_allowed/"+
		localRef+"/true/run" {
		t.Fatalf("version row = %q", got)
	}
	if got := l.scalar(t, "SELECT (provenance ->> 'run_id') || '/' || (provenance ->> 'operation_id') "+
		"FROM work.artifact_version WHERE org_id = "+quoteLiteral(l.org)+
		" AND version_id = "+quoteLiteral(versionID)); got != l.runID+"/"+opID {
		t.Fatalf("version provenance = %q, want the run and operation it was finalized from", got)
	}
	if got := l.scalar(t, "SELECT state FROM work.artifact WHERE id = "+quoteLiteral(artifactID)); got != "published" {
		t.Fatalf("artifact state = %q, want published", got)
	}

	// The replica row is what makes the version readable on the original device, and it is
	// the only one this call writes.
	if got := countRows(t, l.admin, "SELECT count(*) FROM work.artifact_replica WHERE org_id = "+quoteLiteral(l.org)); got != 1 {
		t.Fatalf("replica rows = %d, want exactly 1", got)
	}
	if got := l.scalar(t, "SELECT location || '/' || state || '/' || (hash = "+quoteLiteral(contentHash)+
		")::text || '/' || (bytes = 1024)::text || '/' || (content_ref IS NULL)::text || '/' || "+
		"(device_id = "+quoteLiteral(l.deviceID)+")::text FROM work.artifact_replica WHERE org_id = "+
		quoteLiteral(l.org)); got != "local/published/true/true/true/true" {
		t.Fatalf("replica row = %q", got)
	}

	// The derivation is persisted exactly once, on the success path, and names every input
	// arm it read. §17.4's floor audit row is NOT written, because the raise would roll it
	// back - see the refusal case below.
	if got := countRows(t, l.admin, "SELECT count(*) FROM work.audit_event WHERE org_id = "+quoteLiteral(l.org)+
		" AND action = 'artifact.local_finalize'"); got != 1 {
		t.Fatalf("audit rows = %d, want 1", got)
	}
	if got := l.scalar(t, "SELECT (metadata -> 'classification_derivation' ->> 'result') || '/' || "+
		"(jsonb_array_length(metadata -> 'classification_derivation' -> 'inputs'))::text FROM work.audit_event "+
		"WHERE org_id = "+quoteLiteral(l.org)+" AND action = 'artifact.local_finalize' LIMIT 1"); got != "remote_excerpt_allowed/2" {
		t.Fatalf("persisted derivation = %q, want the result plus both action arms", got)
	}
	if got := l.scalar(t, "SELECT count(*)::text FROM work.audit_event WHERE org_id = "+quoteLiteral(l.org)+
		" AND action = 'artifact_classification_floor'"); got != "0" {
		t.Fatal("the success path wrote a floor audit row")
	}

	// append_task_event writes the outbox row itself, so no new outbox kind exists.
	if got := countRows(t, l.admin, "SELECT count(*) FROM work.task_event WHERE org_id = "+quoteLiteral(l.org)+
		" AND type = 'artifact.published'"); got != 1 {
		t.Fatalf("task_event rows = %d, want 1", got)
	}
	if got := countRows(t, l.admin, "SELECT count(*) FROM work.outbox o JOIN work.task_event e "+
		"ON e.id = o.event_id AND e.org_id = o.org_id WHERE o.org_id = "+quoteLiteral(l.org)+
		" AND o.aggregate_type = 'task' AND e.type = 'artifact.published'"); got != 1 {
		t.Fatalf("outbox rows paired with the artifact.published task_event = %d, want 1", got)
	}
}

// TestR0bFinalizeTakesTheStrictestInput is EV97's first half: the strictest of the Run's
// recorded classifications wins, and a claim looser than that is refused.
func TestR0bFinalizeTakesTheStrictestInput(t *testing.T) {
	l := newLocalArtifactFixture(t, "org_b4_finalize_floor")
	worker := l.workerConn(t)

	// The fixture's first grant is local_only (rule default), the write grant is
	// remote_excerpt_allowed. Reading a local_only document and then writing an artifact
	// must not end up labelled as exfiltrable.
	readOp, readAttempt := l.prepareAction(t, worker, "tool:read", "workspace.read", l.grantID)
	l.recordReceipt(t, worker, readOp, readAttempt, "tool:read", "started", "", "", 1)
	writeOp, writeAttempt := l.prepareAction(t, worker, "artifact:write", "artifact.write", l.writeGrant)
	receiptRef := l.recordReceipt(t, worker, writeOp, writeAttempt, "artifact:write", "started", "", "local/out/a.md", 2)

	if got := l.grantClass(t, l.grantID); got != "local_only" {
		t.Fatalf("fixture grant classification = %q, want local_only", got)
	}

	loose := l.versionPayload(newUUID(t), "null", "reports/a.md", hex64("b4-loose"), "local/out/a.md",
		l.deviceID, receiptRef, "remote_excerpt_allowed", 1024)
	got := l.finalizeRefused(t, worker, l.runID, writeOp, loose)
	if got.code != "classification_floor_required" {
		t.Fatalf("looser claim = %q (%s), want classification_floor_required", got.code, got.state)
	}
	// The refusal rolled the whole statement back, so no evidence of the floor is claimed.
	if counts := l.writeCounts(t); counts != "0/0/0/0" {
		t.Fatalf("side effects after the floor refusal = %s, want 0/0/0/0", counts)
	}
	if got := countRows(t, l.admin, "SELECT count(*) FROM work.audit_event WHERE org_id = "+quoteLiteral(l.org)+
		" AND action = 'artifact_classification_floor'"); got != 0 {
		t.Fatalf("floor audit rows = %d, want 0 (the raise takes it with it)", got)
	}

	strict := l.versionPayload(newUUID(t), "null", "reports/a.md", hex64("b4-strict"), "local/out/a.md",
		l.deviceID, receiptRef, "local_only", 1024)
	out := l.finalize(t, worker, l.runID, writeOp, strict)
	if out["classification"] != "local_only" {
		t.Fatalf("derived classification = %v, want the strictest input local_only", out["classification"])
	}
	// artifact_replica carries no classification column at all (0043:99-136), so the derived
	// value is only observable on the version row the same statement wrote.
	if got := mustScalar(t, l.admin, "SELECT v.classification || '/' || r.state FROM work.artifact_replica r "+
		"JOIN work.artifact_version v ON v.version_id = r.version_id AND v.org_id = r.org_id WHERE r.org_id = "+
		quoteLiteral(l.org)+" LIMIT 1"); got != "local_only/published" {
		t.Fatalf("persisted classification/state = %q, want the derived local_only", got)
	}
	// Both action rows are inputs, and the output root is reported separately, so a reader
	// can tell the artifact's own grant from the content that fed it.
	if got := mustScalar(t, l.admin, "SELECT (jsonb_array_length(metadata -> 'classification_derivation' -> 'inputs'))::text "+
		"|| '/' || (SELECT count(*) FROM jsonb_array_elements(metadata -> 'classification_derivation' -> 'inputs') e "+
		"WHERE e ->> 'source' = 'output_root')::text FROM work.audit_event WHERE org_id = "+quoteLiteral(l.org)+
		" AND action = 'artifact.local_finalize' LIMIT 1"); got != "3/1" {
		t.Fatalf("derivation inputs = %q, want three arms with one output root", got)
	}
}

// TestR0bFinalizeSuccessionGrantCountsBeforeAnyActionRuns covers the second input arm: a
// rebind's new grant participates even though no action has run on it yet. The case is
// built so that the two answers are distinguishable: without the succession arm the
// derivation is remote_excerpt_allowed, with it the result is local_only.
func TestR0bFinalizeSuccessionGrantCountsBeforeAnyActionRuns(t *testing.T) {
	l := newLocalArtifactFixture(t, "org_b4_finalize_succession")
	worker := l.workerConn(t)
	api := l.apiConn(t)

	// One grant, remote, carrying both tools, so every action row in the Run is remote.
	remote := callJSON(t, api,
		`SELECT work.register_workspace_grant($1,$2,'bearer',7,$3::uuid,$4::uuid,$5,$6::jsonb)`,
		l.org, l.subject, l.deviceID, l.sessionID, "req-b4-grant-remote",
		`{"root_identity_hash":"`+strings.Repeat("7", 64)+
			`","allowed_tools":["workspace.read","artifact.write"],"matched_rule_index":1,`+
			`"user_selected_ttl_seconds":3600}`)
	remoteID, _ := remote["grant_id"].(string)
	// The same root, narrowed to local_only by rule 0: a rebind's successor, not a new
	// workspace.
	narrow := callJSON(t, api,
		`SELECT work.register_workspace_grant($1,$2,'bearer',7,$3::uuid,$4::uuid,$5,$6::jsonb)`,
		l.org, l.subject, l.deviceID, l.sessionID, "req-b4-grant-narrow",
		`{"root_identity_hash":"`+strings.Repeat("7", 64)+
			`","allowed_tools":["workspace.read","artifact.write"],"matched_rule_index":0,`+
			`"user_selected_ttl_seconds":3600}`)
	narrowID, _ := narrow["grant_id"].(string)

	readOp, readAttempt := l.prepareAction(t, worker, "tool:read", "workspace.read", remoteID)
	l.recordReceipt(t, worker, readOp, readAttempt, "tool:read", "started", "", "", 1)
	writeOp, writeAttempt := l.prepareAction(t, worker, "artifact:write", "artifact.write", remoteID)
	receiptRef := l.recordReceipt(t, worker, writeOp, writeAttempt, "artifact:write", "started", "", "local/out/b.md", 2)

	before := l.finalize(t, worker, l.runID, writeOp, l.versionPayload(newUUID(t), "null", "reports/b.md",
		hex64("b4-before-succession"), "local/out/b.md", l.deviceID, receiptRef, "remote_excerpt_allowed", 1024))
	if before["classification"] != "remote_excerpt_allowed" {
		t.Fatalf("pre-rebind derivation = %v, want remote_excerpt_allowed", before["classification"])
	}

	// Re-point the Run's workspace at the narrowed grant. The binding's grant_set has to
	// name the old grant, so a fresh revision is offered first, then the run is parked.
	offer := `{"input_ref":"ref","input_hash":"` + hex64("input") + `","snapshot_hash":"` + strings.Repeat("3", 64) +
		`","profile_id":"p1","profile_revision":1,"runtime_digest":"` + strings.Repeat("4", 64) +
		`","tool_manifest_hash":"` + strings.Repeat("5", 64) + `","model_version":"m1","grant_set":[{"grant_id":"` +
		remoteID + `","grant_revision":1}],"offer_ttl_seconds":120}`
	callJSON(t, worker, `SELECT work.create_device_run_binding($1,$2::uuid,$3::uuid,$4::uuid,2,$5,$6::jsonb)`,
		l.org, l.runID, l.deviceID, l.sessionID, "req-b4-offer-2", offer)
	callJSON(t, worker, `SELECT work.acknowledge_run_ready($1,$2::uuid,2,$3,$4::jsonb)`,
		l.org, l.runID, "req-b4-ready-2",
		`{"binding_hash":"`+hex64("binding")+`","ready_or_reason":"ready","device_signature":"sha256:`+
			strings.Repeat("b", 64)+`"}`)
	mustExec(t, l.admin, "UPDATE work.run SET state = 'waiting', wait_reason = 'input' WHERE id = "+quoteLiteral(l.runID))
	nonce := "nonce-b4-succ-1"
	callJSON(t, api,
		`SELECT work.rebind_run_workspace($1,$2,'bearer',7,$3::uuid,$4,$5::uuid,$6::uuid,$7::jsonb)`,
		l.org, l.subject, l.runID, "req-b4-rebind-1", remoteID, narrowID,
		`{"old_grant_id":"`+remoteID+`","new_grant_id":"`+narrowID+`","run_id":"`+l.runID+
			`","root_identity_hash":"`+strings.Repeat("7", 64)+`","session_id":"`+l.sessionID+
			`","auth_plane":"bearer","auth_epoch":7,"nonce":"`+nonce+
			`","signature":"sha256:`+strings.Repeat("e", 64)+`"}`)

	after := l.finalize(t, worker, l.runID, writeOp, l.versionPayload(newUUID(t), "null", "reports/c.md",
		hex64("b4-after-succession"), "local/out/b.md", l.deviceID, receiptRef, "local_only", 2048))
	if after["classification"] != "local_only" {
		t.Fatalf("post-rebind derivation = %v, want local_only from the succession arm", after["classification"])
	}
	if got := mustScalar(t, l.admin, "SELECT (SELECT count(*) FROM jsonb_array_elements("+
		"metadata -> 'classification_derivation' -> 'inputs') e WHERE e ->> 'source' = 'succession')::text "+
		"FROM work.audit_event WHERE org_id = "+quoteLiteral(l.org)+" AND action = 'artifact.local_finalize' "+
		"ORDER BY created_at DESC LIMIT 1"); got != "1" {
		t.Fatalf("succession inputs = %s, want 1", got)
	}
	// And the looser claim is now refused because of a grant that has never run an action.
	expectRefused(t, worker, "classification_floor_required", "P0001",
		`SELECT work.finalize_local_artifact($1,$2::uuid,$3::uuid,$4::jsonb)`,
		l.org, l.runID, writeOp, l.versionPayload(newUUID(t), "null", "reports/d.md",
			hex64("b4-d"), "local/out/b.md", l.deviceID, receiptRef, "remote_excerpt_allowed", 2048))
}

// TestR0bFinalizeEmptyInputSetIsAFloorNotAGuess pins the COALESCE branch. The state is
// constructed rather than reached: today the device cannot produce a receipt without an
// action row, because prepare writes both. What is pinned is the semantics of the branch
// (the strictest value, not the claim), so that widening the arms later has to pass it.
func TestR0bFinalizeEmptyInputSetIsAFloorNotAGuess(t *testing.T) {
	l := newLocalArtifactFixture(t, "org_b4_finalize_empty")
	admin := l.admin
	worker := l.workerConn(t)

	// An operation with a receipt and no local_action row. The fixture's own Run works
	// here and is the cheaper construction: it never had a prepare call, so it holds no
	// local_action rows, and finalize accepts a Run in 'waiting' as well as 'active'. A
	// second open Run on one Task is not constructible at all - work_run_one_open_per_task
	// is a partial unique index over queued/active/waiting/cancel_requested.
	opID := newUUID(t)
	attemptID := newUUID(t)
	mustExec(t, admin, "INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash, "+
		"state, dispatch_attempt_id) VALUES ("+quoteLiteral(opID)+", "+quoteLiteral(l.org)+", "+
		quoteLiteral(l.runID)+", 'artifact:empty#0', 'artifact', "+quoteLiteral(hex64("b4-empty-op"))+
		", 'dispatching', "+quoteLiteral(attemptID)+")")
	localRef := "local/out/empty.md"
	receiptRef := l.recordReceipt(t, worker, opID, attemptID, "artifact:empty", "started", "", localRef, 1)

	if got := countRows(t, admin, "SELECT count(*) FROM work.local_action WHERE org_id = "+quoteLiteral(l.org)+
		" AND operation_id IN (SELECT id FROM work.operation WHERE run_id = "+quoteLiteral(l.runID)+")"); got != 0 {
		t.Fatalf("local_action rows in the empty Run = %d, want 0", got)
	}

	// The floor is what makes the loose claim refuse: v_inputs is [], COALESCE answers
	// 'local_only' and rank(claimed) < rank(result). Had the branch guessed the claim or
	// returned NULL, this call would have landed a version instead.
	before := l.writeCounts(t)
	got := l.finalizeRefused(t, worker, l.runID, opID, l.versionPayload(newUUID(t), "null", "reports/e.md",
		hex64("b4-empty"), localRef, l.deviceID, receiptRef, "remote_excerpt_allowed", 512))
	if got.code != "classification_floor_required" {
		t.Fatalf("empty-set loose claim = %q (%s), want classification_floor_required", got.code, got.state)
	}
	if counts := l.writeCounts(t); counts != before {
		t.Fatalf("the floor refusal changed the write set: %s -> %s", before, counts)
	}

	out := l.finalize(t, worker, l.runID, opID, l.versionPayload(newUUID(t), "null", "reports/e.md",
		hex64("b4-empty"), localRef, l.deviceID, receiptRef, "local_only", 512))
	if out["classification"] != "local_only" || out["version_no"] != float64(1) {
		t.Fatalf("empty-set derivation = %#v, want a local_only version 1", out)
	}
	if got := mustScalar(t, admin, "SELECT (jsonb_array_length(metadata -> 'classification_derivation' -> 'inputs'))::text "+
		"|| '/' || (metadata -> 'classification_derivation' ->> 'result') || '/' || "+
		"COALESCE(metadata -> 'classification_derivation' ->> 'output_root_classification', 'SQL-NULL') "+
		"FROM work.audit_event WHERE org_id = "+quoteLiteral(l.org)+" AND action = 'artifact.local_finalize' LIMIT 1"); got != "0/local_only/SQL-NULL" {
		t.Fatalf("persisted derivation = %q, want an empty input set floored to local_only "+
			"with no output root (the operation had no artifact.write local_action row)", got)
	}
}

// TestR0bFinalizeClassificationUnknownIsOnlyReachableFromTheClaim side: the two arms of
// the guard, and which of them the shipped schema can actually produce.
func TestR0bFinalizeClassificationUnknownOnlyComesFromTheClaim(t *testing.T) {
	l := newLocalArtifactFixture(t, "org_b4_finalize_unknown")
	worker := l.workerConn(t)
	opID, attemptID := l.prepareAction(t, worker, "artifact:u", "artifact.write", l.writeGrant)
	receiptRef := l.recordReceipt(t, worker, opID, attemptID, "artifact:u", "started", "", "local/out/u.md", 1)
	before := l.writeCounts(t)

	// The payload validator only requires a non-empty string here, so a value outside the
	// closed set reaches the guard. It must be classification_unknown, not invalid_request:
	// that code's only branch would otherwise be unreachable.
	expectRefused(t, worker, "classification_unknown", "P0001",
		`SELECT work.finalize_local_artifact($1,$2::uuid,$3::uuid,$4::jsonb)`,
		l.org, l.runID, opID, l.versionPayload(newUUID(t), "null", "reports/u.md",
			hex64("b4-unknown"), "local/out/u.md", l.deviceID, receiptRef, "public", 512))
	if got := l.writeCounts(t); got != before {
		t.Fatalf("refusal changed the write set: before %s, after %s", before, got)
	}

	// The input side cannot produce it: both contributing columns are CHECKed to the two
	// values, which is what makes the guard's EXISTS arm structurally unreachable. Asserted
	// as a constraint rather than argued, so a later widening shows up here.
	for _, pair := range [][2]string{
		{"work.local_action", "local_action_classification_check"},
		{"work.workspace_grant", "workspace_grant_classification_check"},
	} {
		if got := mustScalar(t, l.admin, "SELECT (count(*) = 1)::text FROM pg_constraint WHERE conrelid = "+
			quoteLiteral(pair[0])+"::regclass AND conname = "+quoteLiteral(pair[1])); got != "true" {
			t.Fatalf("%s has no %s, so the input arm of classification_unknown became reachable", pair[0], pair[1])
		}
	}
	// And the CHECK is the thing that refuses, not the guard: a hand-written local_action
	// row claiming a value outside the closed set never reaches finalize's derivation.
	expectConstraint(t, l.admin, "local_action_classification_check", "INSERT INTO work.local_action "+
		"(org_id, operation_id, attempt_id, action_kind, grant_id, grant_revision, resource_selector_hash, "+
		"classification, local_payload_ref, request_hash, tool_schema, byte_upper_bound, token_upper_bound) "+
		"VALUES ("+quoteLiteral(l.org)+", "+quoteLiteral(opID)+", "+quoteLiteral(newUUID(t))+
		", 'artifact.write', "+quoteLiteral(l.writeGrant)+", 1, "+quoteLiteral(hex64("b4-x"))+
		", 'public', 'local/p', "+quoteLiteral(hex64("b4-r"))+", 'artifact.write-v1', 1, 1)")
}

// TestR0bFinalizeReceiptBindingNegatives covers the three receipt arms and the two
// idempotency_conflict arms.
func TestR0bFinalizeReceiptBindingNegatives(t *testing.T) {
	l := newLocalArtifactFixture(t, "org_b4_finalize_receipt")
	worker := l.workerConn(t)
	opID, attemptID := l.prepareAction(t, worker, "artifact:r", "artifact.write", l.writeGrant)
	localRef := "local/out/r.md"
	receiptRef := l.recordReceipt(t, worker, opID, attemptID, "artifact:r", "started", "", localRef, 1)
	before := l.writeCounts(t)

	payload := func(receiptRef, localRef, deviceID string) string {
		return l.versionPayload(newUUID(t), "null", "reports/r.md", hex64("b4-receipt-case"),
			localRef, deviceID, receiptRef, "remote_excerpt_allowed", 512)
	}

	// (1) an epoch:seq no receipt holds. The message is the bare not_found, which
	// expectCode's substring test would confuse with run_not_found.
	expectRefused(t, worker, "not_found", "P0002",
		`SELECT work.finalize_local_artifact($1,$2::uuid,$3::uuid,$4::jsonb)`,
		l.org, l.runID, opID, payload(l.journal+":99", localRef, l.deviceID))
	// A receipt of another operation in the same journal is still not_found, because the
	// lookup is (org, operation, epoch, seq) and not (org, epoch, seq).
	otherOp, otherAttempt := l.prepareAction(t, worker, "artifact:other", "artifact.write", l.writeGrant)
	otherRef := l.recordReceipt(t, worker, otherOp, otherAttempt, "artifact:other", "started", "", localRef, 2)
	if otherRef != l.journal+":2" {
		t.Fatalf("second receipt ref = %s, want the same epoch", otherRef)
	}
	expectRefused(t, worker, "not_found", "P0002",
		`SELECT work.finalize_local_artifact($1,$2::uuid,$3::uuid,$4::jsonb)`,
		l.org, l.runID, opID, payload(l.journal+":2", localRef, l.deviceID))

	// (2) the payload points somewhere the receipt does not name.
	expectRefused(t, worker, "idempotency_conflict", "P0001",
		`SELECT work.finalize_local_artifact($1,$2::uuid,$3::uuid,$4::jsonb)`,
		l.org, l.runID, opID, payload(receiptRef, "local/out/elsewhere.md", l.deviceID))
	// (3) the device in the payload is not the device that produced the receipt.
	expectRefused(t, worker, "idempotency_conflict", "P0001",
		`SELECT work.finalize_local_artifact($1,$2::uuid,$3::uuid,$4::jsonb)`,
		l.org, l.runID, opID, payload(receiptRef, localRef, newUUID(t)))
	if got := l.writeCounts(t); got != before {
		t.Fatalf("four receipt refusals changed the write set: before %s, after %s", before, got)
	}

	// A receipt whose device agrees but which carries no local_result_ref at all is
	// accepted - §17.10 item 6's deferral, recorded as behaviour. device_receipt is
	// append-only, so the ref-less row comes from a second recorded receipt rather than
	// from rewriting the first: recordReceipt's empty localRef lands NULL.
	noRefOp, noRefAttempt := l.prepareAction(t, worker, "artifact:noref", "artifact.write", l.writeGrant)
	noRef := l.recordReceipt(t, worker, noRefOp, noRefAttempt, "artifact:noref", "started", "", "", 3)
	out := l.finalize(t, worker, l.runID, noRefOp,
		l.versionPayload(newUUID(t), "null", "reports/noref.md", hex64("b4-noref"),
			"local/out/anywhere.md", l.deviceID, noRef, "remote_excerpt_allowed", 512))
	if out["replayed"] != false || out["version_no"] != float64(1) {
		t.Fatalf("finalize against a ref-less receipt = %#v", out)
	}

	// And an 'unknown' receipt is accepted too: the absence of a state gate is the ruling,
	// so it is asserted rather than left as an untested silence.
	unknownRef := l.recordReceipt(t, worker, otherOp, otherAttempt, "artifact:other", "unknown", "", "", 4)
	out = l.finalize(t, worker, l.runID, otherOp,
		l.versionPayload(newUUID(t), "null", "reports/other.md", hex64("b4-unknown-receipt"),
			"local/out/other.md", l.deviceID, unknownRef, "remote_excerpt_allowed", 512))
	if out["version_no"] != float64(1) {
		t.Fatalf("finalize against an unknown receipt = %#v", out)
	}
}

// TestR0bFinalizeGateReadsThisRunNotTheTask is O-18 = bing made visible: a Task-level
// blocker does not stop a finalized artifact, and the same predicate does stop it when the
// unreconciled operation belongs to this Run.
func TestR0bFinalizeGateReadsThisRunNotTheTask(t *testing.T) {
	l := newLocalArtifactFixture(t, "org_b4_finalize_gate")
	worker := l.workerConn(t)
	opID, attemptID := l.prepareAction(t, worker, "artifact:g", "artifact.write", l.writeGrant)
	receiptRef := l.recordReceipt(t, worker, opID, attemptID, "artifact:g", "started", "", "local/out/g.md", 1)
	payload := l.versionPayload(newUUID(t), "null", "reports/g.md", hex64("b4-gate"),
		"local/out/g.md", l.deviceID, receiptRef, "remote_excerpt_allowed", 512)

	// A sibling Run of the same Task carrying an unreconciled operation of its own. The
	// sibling is inserted straight as 'failed' because one open Run per Task is a partial
	// unique index (work_run_one_open_per_task) - while the fixture's Run is 'waiting' no
	// second queued/active/waiting/cancel_requested Run can exist. The operation therefore
	// has to be created against the fixture's Run, which is the only row
	// enforce_operation_creation (a BEFORE INSERT trigger) will accept, and then moved to
	// the sibling: the trigger is insert-only and nothing guards operation.run_id.
	sibling := newUUID(t)
	mustExec(t, l.admin, "INSERT INTO work.run (id, org_id, task_id, attempt_no, state, wait_reason, snapshot_id, workflow_id, runtime_version) VALUES ("+
		quoteLiteral(sibling)+", "+quoteLiteral(l.org)+", "+quoteLiteral(l.taskID)+", 2, 'failed', NULL, "+
		"(SELECT snapshot_id FROM work.task WHERE id = "+quoteLiteral(l.taskID)+"), "+
		quoteLiteral("wfs-"+l.org)+", 'v1')")
	blocked := newUUID(t)
	mustExec(t, l.admin, "INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash, state) VALUES ("+
		quoteLiteral(blocked)+", "+quoteLiteral(l.org)+", "+quoteLiteral(l.runID)+", 'tool:9#0', 'tool', "+
		quoteLiteral(hex64("b4-blocked"))+", 'dispatching')")
	mustExec(t, l.admin, "UPDATE work.operation SET run_id = "+quoteLiteral(sibling)+", state = 'unknown' "+
		"WHERE id = "+quoteLiteral(blocked))

	// The Task-level predicate is true - it joins operation to run on task_id and never
	// filters by run state - so the alternative ruling would have refused here.
	if got := mustScalar(t, l.admin, "SELECT work.task_has_blocking_operation("+quoteLiteral(l.taskID)+
		", "+quoteLiteral(l.org)+")::text"); got != "true" {
		t.Fatalf("task_has_blocking_operation = %s, want true (the sibling is unreconciled)", got)
	}
	out := l.finalize(t, worker, l.runID, opID, payload)
	if out["replayed"] != false {
		t.Fatalf("a Task-level blocker stopped a Run-scoped finalize: %#v", out)
	}
	if out["classification_derivation"] == nil {
		t.Fatalf("finalize returned no derivation: %#v", out)
	}
	firstArtifact, _ := out["artifact_id"].(string)
	if firstArtifact == "" {
		t.Fatalf("finalize echoed no artifact_id: %#v", out)
	}

	// Now the same two states inside THIS Run, both branches of the predicate.
	thisOp := newUUID(t)
	mustExec(t, l.admin, "UPDATE work.run SET state = 'active' WHERE id = "+quoteLiteral(l.runID))
	mustExec(t, l.admin, "INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash, state) VALUES ("+
		quoteLiteral(thisOp)+", "+quoteLiteral(l.org)+", "+quoteLiteral(l.runID)+", 'tool:8#0', 'tool', '"+
		hex64("this-run")+"', 'dispatching')")
	mustExec(t, l.admin, "UPDATE work.operation SET state = 'unknown' WHERE id = "+quoteLiteral(thisOp))
	before := l.writeCounts(t)
	got := l.finalizeRefused(t, worker, l.runID, opID,
		l.versionPayload(newUUID(t), "null", "reports/h.md", hex64("b4-gate-2"),
			"local/out/g.md", l.deviceID, receiptRef, "remote_excerpt_allowed", 512))
	if got.code != "run_has_unreconciled_operation" {
		t.Fatalf("unknown in this Run = %q, want run_has_unreconciled_operation", got.code)
	}
	mustExec(t, l.admin, "UPDATE work.operation SET state = 'unresolved' WHERE id = "+quoteLiteral(thisOp))
	expectRefused(t, worker, "run_has_unreconciled_operation", "P0001",
		`SELECT work.finalize_local_artifact($1,$2::uuid,$3::uuid,$4::jsonb)`,
		l.org, l.runID, opID, l.versionPayload(newUUID(t), "null", "reports/i.md", hex64("b4-gate-3"),
			"local/out/g.md", l.deviceID, receiptRef, "remote_excerpt_allowed", 512))
	if counts := l.writeCounts(t); counts != before {
		t.Fatalf("the two gate refusals changed the write set: %s -> %s", before, counts)
	}
	// Reconciling it re-opens the path, which is what makes the above two a gate and not a
	// constant refusal. The logical_name is the one already published above, so this is a
	// second version of the same artifact rather than a new artifact.
	mustExec(t, l.admin, "UPDATE work.operation SET state = 'reconciled' WHERE id = "+quoteLiteral(thisOp))
	out = l.finalize(t, worker, l.runID, opID,
		l.versionPayload(newUUID(t), "null", "reports/g.md", hex64("b4-gate-4"),
			"local/out/g.md", l.deviceID, receiptRef, "remote_excerpt_allowed", 512))
	if out["version_no"] != float64(2) || out["artifact_id"] != firstArtifact {
		t.Fatalf("after reconcile = %#v, want version 2 on artifact %s", out, firstArtifact)
	}
}

// TestR0bFinalizeReplayTargetAndShapeRefusals covers the remaining branches of the command.
func TestR0bFinalizeReplayTargetAndShapeRefusals(t *testing.T) {
	l := newLocalArtifactFixture(t, "org_b4_finalize_replay")
	worker := l.workerConn(t)
	opID, attemptID := l.prepareAction(t, worker, "artifact:p", "artifact.write", l.writeGrant)
	receiptRef := l.recordReceipt(t, worker, opID, attemptID, "artifact:p", "started", "", "local/out/p.md", 1)
	artifactID := newUUID(t)
	contentHash := hex64("b4-replayed")
	localRef := "local/out/p.md"
	first := newUUID(t)
	// finalize :514 reads work.artifact for any payload that names an artifact, so the
	// draft row is seeded here the same way the happy path seeds it.
	mustExec(t, l.admin, "INSERT INTO work.artifact (id, org_id, task_id, logical_name, state) VALUES ("+
		quoteLiteral(artifactID)+", "+quoteLiteral(l.org)+", "+quoteLiteral(l.taskID)+
		", 'reports/p.md', 'draft')")

	out := l.finalize(t, worker, l.runID, opID,
		l.versionPayload(first, jstr(artifactID), "reports/p.md", contentHash, localRef,
			l.deviceID, receiptRef, "remote_excerpt_allowed", 1024))
	if out["artifact_id"] != artifactID {
		t.Fatalf("explicit artifact_id was not honoured: %#v", out)
	}

	// Same bytes, same Run, same artifact: the publish_artifact idempotency rule. The
	// version_id in the replay call is brand new and must be ignored, because the identity
	// is (artifact, content_hash, run).
	replay := l.finalize(t, worker, l.runID, opID,
		l.versionPayload(newUUID(t), jstr(artifactID), "reports/p.md", contentHash, localRef,
			l.deviceID, receiptRef, "remote_excerpt_allowed", 1024))
	if replay["replayed"] != true || replay["version_id"] != first || replay["version_no"] != float64(1) {
		t.Fatalf("replay = %#v, want the original version %s", replay, first)
	}
	if got := countRows(t, l.admin, "SELECT count(*) FROM work.artifact_replica WHERE org_id = "+quoteLiteral(l.org)); got != 1 {
		t.Fatalf("replica rows after replay = %d, want 1", got)
	}
	if got := countRows(t, l.admin, "SELECT count(*) FROM work.artifact_version WHERE org_id = "+quoteLiteral(l.org)); got != 1 {
		t.Fatalf("version rows after replay = %d, want 1", got)
	}
	if got := mustScalar(t, l.admin, "SELECT (metadata -> 'classification_derivation') IS NOT NULL::text "+
		"FROM work.audit_event WHERE org_id = "+quoteLiteral(l.org)+" AND action = 'artifact.local_finalize' LIMIT 1"); got != "true" {
		t.Fatalf("the replay response lost the derivation: %s", got)
	}

	// A version_id already in use, for other content, is a conflict rather than a new
	// version.
	expectRefused(t, worker, "idempotency_conflict", "P0001",
		`SELECT work.finalize_local_artifact($1,$2::uuid,$3::uuid,$4::jsonb)`,
		l.org, l.runID, opID, l.versionPayload(first, jstr(artifactID), "reports/p.md",
			hex64("b4-other-bytes"), localRef, l.deviceID, receiptRef, "remote_excerpt_allowed", 1024))

	// An explicit artifact that belongs to another Task, or to this Task under a different
	// logical_name, is a conflict; the draft row is not minted behind either. work.artifact
	// has a composite FK to (task_id, org_id), so the stranger needs a real second Task:
	// a clone of the fixture's row, reusing its already-valid snapshot and input.
	otherTask := newUUID(t)
	mustExec(t, l.admin, "INSERT INTO work.task (id, org_id, owner_subject_id, state, snapshot_id, "+
		"permission_mode, input_id, title) SELECT "+quoteLiteral(otherTask)+", org_id, owner_subject_id, "+
		"'open', snapshot_id, permission_mode, input_id, 'b4 stranger task' FROM work.task WHERE id = "+
		quoteLiteral(l.taskID))
	stranger := newUUID(t)
	mustExec(t, l.admin, "INSERT INTO work.artifact (id, org_id, task_id, logical_name, state) VALUES ("+
		quoteLiteral(stranger)+", "+quoteLiteral(l.org)+", "+quoteLiteral(otherTask)+", 'reports/p.md', 'draft')")
	expectRefused(t, worker, "idempotency_conflict", "P0001",
		`SELECT work.finalize_local_artifact($1,$2::uuid,$3::uuid,$4::jsonb)`,
		l.org, l.runID, opID, l.versionPayload(newUUID(t), jstr(stranger), "reports/p.md",
			hex64("b4-stranger"), localRef, l.deviceID, receiptRef, "remote_excerpt_allowed", 1024))
	expectRefused(t, worker, "idempotency_conflict", "P0001",
		`SELECT work.finalize_local_artifact($1,$2::uuid,$3::uuid,$4::jsonb)`,
		l.org, l.runID, opID, l.versionPayload(newUUID(t), jstr(artifactID), "reports/renamed.md",
			contentHash, localRef, l.deviceID, receiptRef, "remote_excerpt_allowed", 1024))
	if got := countRows(t, l.admin, "SELECT count(*) FROM work.artifact WHERE org_id = "+quoteLiteral(l.org)+
		" AND logical_name = 'reports/renamed.md'"); got != 0 {
		t.Fatalf("the renamed-target refusal minted %d artifacts, want 0", got)
	}

	// A deleted artifact of THIS Task and logical_name is artifact_deleted, not a conflict:
	// the target resolves, so :537's own branch is what answers.
	gone := newUUID(t)
	mustExec(t, l.admin, "INSERT INTO work.artifact (id, org_id, task_id, logical_name, state, deleted_at) VALUES ("+
		quoteLiteral(gone)+", "+quoteLiteral(l.org)+", "+quoteLiteral(l.taskID)+
		", 'reports/gone.md', 'deleted', now())")
	expectRefused(t, worker, "artifact_deleted", "P0001",
		`SELECT work.finalize_local_artifact($1,$2::uuid,$3::uuid,$4::jsonb)`,
		l.org, l.runID, opID, l.versionPayload(newUUID(t), jstr(gone), "reports/gone.md",
			hex64("b4-gone"), localRef, l.deviceID, receiptRef, "remote_excerpt_allowed", 1024))

	// Run and operation identity. The inactive case comes from a sibling Run inserted
	// straight as 'failed' rather than from moving the fixture's Run: 'waiting' has no
	// legal transition to a state finalize rejects, and a terminal state is not
	// recoverable, so the earlier draft of this case parked the Run in 'succeeded' and then
	// tried to UPDATE it back. 'failed' is outside work_run_one_open_per_task, so the
	// sibling costs nothing.
	sibling := newUUID(t)
	mustExec(t, l.admin, "INSERT INTO work.run (id, org_id, task_id, attempt_no, state, wait_reason, snapshot_id, workflow_id, runtime_version) VALUES ("+
		quoteLiteral(sibling)+", "+quoteLiteral(l.org)+", "+quoteLiteral(l.taskID)+", 2, 'failed', NULL, "+
		"(SELECT snapshot_id FROM work.task WHERE id = "+quoteLiteral(l.taskID)+"), "+
		quoteLiteral("wfsr-"+l.org)+", 'v1')")
	expectRefused(t, worker, "run_not_active", "P0001",
		`SELECT work.finalize_local_artifact($1,$2::uuid,$3::uuid,$4::jsonb)`,
		l.org, sibling, opID, l.versionPayload(newUUID(t), "null", "reports/q.md",
			hex64("b4-inactive"), localRef, l.deviceID, receiptRef, "remote_excerpt_allowed", 1024))
	expectRefused(t, worker, "run_not_found", "P0002",
		`SELECT work.finalize_local_artifact($1,$2::uuid,$3::uuid,$4::jsonb)`,
		l.org, newUUID(t), opID, l.versionPayload(newUUID(t), "null", "reports/q.md",
			hex64("b4-norun"), localRef, l.deviceID, receiptRef, "remote_excerpt_allowed", 1024))
	// An operation of another Run is not this Run's operation.
	otherRunOp := newUUID(t)
	mustExec(t, l.admin, "UPDATE work.task SET active_run_id = "+quoteLiteral(l.runID)+" WHERE id = "+quoteLiteral(l.taskID))
	mustExec(t, l.admin, "INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash, state) VALUES ("+
		quoteLiteral(otherRunOp)+", "+quoteLiteral(l.org)+", "+quoteLiteral(l.runID)+", 'tool:7#0', 'tool', "+
		quoteLiteral(hex64("b4-other-run"))+", 'dispatching')")
	mustExec(t, l.admin, "UPDATE work.operation SET run_id = "+quoteLiteral(sibling)+" WHERE id = "+quoteLiteral(otherRunOp))
	expectRefused(t, worker, "not_found", "P0002",
		`SELECT work.finalize_local_artifact($1,$2::uuid,$3::uuid,$4::jsonb)`,
		l.org, l.runID, otherRunOp, l.versionPayload(newUUID(t), "null", "reports/q.md",
			hex64("b4-op-mismatch"), localRef, l.deviceID, receiptRef, "remote_excerpt_allowed", 1024))

	// org_context_mismatch is the first statement in the body.
	expectRefused(t, worker, "org_context_mismatch", "P0001",
		`SELECT work.finalize_local_artifact($1,$2::uuid,$3::uuid,$4::jsonb)`,
		"org_b4_elsewhere", l.runID, opID, l.versionPayload(newUUID(t), "null", "reports/q.md",
			hex64("b4-wrong-org"), localRef, l.deviceID, receiptRef, "remote_excerpt_allowed", 1024))

	// The closed 10-key set and the value shapes. Each of these must be invalid_request
	// (22023), which is the request-error class, not a domain conflict.
	cases := []struct{ name, payload string }{
		// Eleven keys, spelled out rather than derived from versionPayload by index
		// arithmetic, so the pin is the key set itself.
		{"eleven keys", `{"version_id":` + jstr(newUUID(t)) + `,"artifact_id":null,` +
			`"logical_name":"reports/q.md","format":"text/markdown","content_hash":"` + hex64("b4-shape") +
			`","byte_count":1024,"local_ref":"` + localRef + `","device_id":` + jstr(l.deviceID) +
			`,"classification_claimed":"local_only","receipt_ref":"` + receiptRef + `","extra":1}`},
		// Nine keys: the same object without artifact_id. The validator's artifact_id
		// tolerance is about its TYPE, not its presence, so a missing key is still a shape
		// refusal.
		{"nine keys", `{"version_id":` + jstr(newUUID(t)) + `,"logical_name":"reports/q.md",` +
			`"format":"text/markdown","content_hash":"` + hex64("b4-shape") +
			`","byte_count":1024,"local_ref":"` + localRef + `","device_id":` + jstr(l.deviceID) +
			`,"classification_claimed":"local_only","receipt_ref":"` + receiptRef + `"}`},
		{"receipt_ref without a seq", `{"version_id":` + jstr(newUUID(t)) + `,"artifact_id":null,"logical_name":"x","format":"f","content_hash":"` +
			hex64("b4-shape") + `","byte_count":1,"local_ref":"l","device_id":` + jstr(l.deviceID) +
			`,"classification_claimed":"local_only","receipt_ref":"` + l.journal + `"}`},
		{"receipt_ref seq zero", `{"version_id":` + jstr(newUUID(t)) + `,"artifact_id":null,"logical_name":"x","format":"f","content_hash":"` +
			hex64("b4-shape") + `","byte_count":1,"local_ref":"l","device_id":` + jstr(l.deviceID) +
			`,"classification_claimed":"local_only","receipt_ref":"` + l.journal + `:0"}`},
		{"negative byte_count", l.versionPayload(newUUID(t), "null", "reports/q.md", hex64("b4-shape"),
			localRef, l.deviceID, receiptRef, "local_only", -1)},
		{"non-string artifact_id", strings.Replace(l.versionPayload(newUUID(t), "null", "reports/q.md",
			hex64("b4-shape"), localRef, l.deviceID, receiptRef, "local_only", 1024), `"artifact_id":null`,
			`"artifact_id":7`, 1)},
		{"empty logical_name", strings.Replace(l.versionPayload(newUUID(t), "null", "reports/q.md",
			hex64("b4-shape"), localRef, l.deviceID, receiptRef, "local_only", 1024), `"logical_name":"reports/q.md"`,
			`"logical_name":""`, 1)},
		{"content_hash not 64 hex", strings.Replace(l.versionPayload(newUUID(t), "null", "reports/q.md",
			hex64("b4-shape"), localRef, l.deviceID, receiptRef, "local_only", 1024), jstr(hex64("b4-shape")),
			`"zz"`, 1)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			expectRefused(t, worker, "invalid_request", "22023",
				`SELECT work.finalize_local_artifact($1,$2::uuid,$3::uuid,$4::jsonb)`,
				l.org, l.runID, opID, c.payload)
		})
	}
	// None of the above wrote anything either.
	if got := countRows(t, l.admin, "SELECT count(*) FROM work.artifact_version WHERE org_id = "+quoteLiteral(l.org)); got != 1 {
		t.Fatalf("version rows after the shape refusals = %d, want the 1 landed before them", got)
	}
}

// ---------------------------------------------------------------------------
// artifact_replica: the one-writer claim
// ---------------------------------------------------------------------------

func TestR0bArtifactReplicaHasOneShippedWriterAndRefusesFalseContent(t *testing.T) {
	l := newLocalArtifactFixture(t, "org_b4_replica_writer")
	worker := l.workerConn(t)

	// Land one real version first, so the guard has a version to compare against.
	opID, attemptID := l.prepareAction(t, worker, "artifact:w", "artifact.write", l.writeGrant)
	receiptRef := l.recordReceipt(t, worker, opID, attemptID, "artifact:w", "started", "", "local/out/w.md", 1)
	versionID := newUUID(t)
	contentHash := hex64("b4-replica-guard")
	out := l.finalize(t, worker, l.runID, opID,
		l.versionPayload(versionID, "null", "reports/w.md", contentHash, "local/out/w.md",
			l.deviceID, receiptRef, "remote_excerpt_allowed", 1024))
	if out["version_id"] != versionID {
		t.Fatalf("fixture finalize = %#v", out)
	}

	// No runtime role has any table privilege on either of the two new tables: the only way
	// in is a definer command. Read as has_table_privilege rather than by grep, and for all
	// six workload roles.
	for _, table := range []string{"artifact_replica", "consumed_possession_nonce"} {
		for _, role := range []string{"work_api", "work_worker", "work_directory", "work_ledger",
			"work_ops", "work_governance_events"} {
			for _, priv := range []string{"INSERT", "UPDATE", "DELETE", "SELECT"} {
				if got := mustScalar(t, l.admin, "SELECT has_table_privilege("+quoteLiteral(role)+", 'work."+
					table+"', "+quoteLiteral(priv)+")::text"); got != "false" {
					t.Fatalf("%s holds %s on work.%s", role, priv, table)
				}
			}
		}
	}
	// EXECUTE is split by face: finalize is the worker's, the user save and the rebind are
	// the api's, and neither face crosses over.
	for _, pair := range [][3]string{
		{"work.finalize_local_artifact(text,uuid,uuid,jsonb)", "work_worker", "true"},
		{"work.finalize_local_artifact(text,uuid,uuid,jsonb)", "work_api", "false"},
		{"work.create_local_user_artifact_version(text,text,text,bigint,uuid,uuid,uuid,text,text,jsonb)", "work_api", "true"},
		{"work.create_local_user_artifact_version(text,text,text,bigint,uuid,uuid,uuid,text,text,jsonb)", "work_worker", "false"},
		{"work.rebind_run_workspace(text,text,text,bigint,uuid,text,uuid,uuid,jsonb)", "work_api", "true"},
		{"work.rebind_run_workspace(text,text,text,bigint,uuid,text,uuid,uuid,jsonb)", "work_worker", "false"},
	} {
		if got := mustScalar(t, l.admin, "SELECT has_function_privilege("+quoteLiteral(pair[1])+", "+
			quoteLiteral(pair[0])+", 'EXECUTE')::text"); got != pair[2] {
			t.Fatalf("%s EXECUTE for %s = %s, want %s", pair[1], pair[0], got, pair[2])
		}
	}
	// The two validators and the trigger function are callable by nobody.
	for _, fn := range []string{"work.local_artifact_version_payload_valid(jsonb)",
		"work.user_version_proof_valid(jsonb)", "work.artifact_replica_matches_version()"} {
		if got := mustScalar(t, l.admin, "SELECT has_function_privilege('work_api', "+quoteLiteral(fn)+
			", 'EXECUTE')::text"); got != "false" {
			t.Fatalf("work_api can execute the helper %s", fn)
		}
	}
	// A direct INSERT from a workload login is refused before it reaches any guard: work_api
	// (which owns the user save) has no replica path at all.
	api := l.apiConn(t)
	expectConstraint(t, api, "permission denied for table", "INSERT INTO work.artifact_replica "+
		"(org_id, version_id, location, device_id, local_ref, hash, bytes, state) VALUES ("+
		quoteLiteral(l.org)+", "+quoteLiteral(versionID)+", 'local', "+quoteLiteral(l.deviceID)+
		", 'local/out/w.md', "+quoteLiteral(contentHash)+", 1024, 'published')")

	// The content guard and the two closed sets, from the maintenance connection: a replica
	// row that does not describe the version it points at is a false record about bytes the
	// server never saw. The guard is a BEFORE row trigger, so it is evaluated first and
	// shadows the hash/bytes CHECKs - a hash that is not 64 hex is by construction also a
	// hash that differs from the version's, so those two cases assert what actually arrives.
	ins := func(vid, location, ref, hash, bytes, state string) string {
		return "INSERT INTO work.artifact_replica (org_id, version_id, location, device_id, local_ref, " +
			"hash, bytes, state) VALUES (" + quoteLiteral(l.org) + ", " + quoteLiteral(vid) + ", " +
			quoteLiteral(location) + ", " + quoteLiteral(l.deviceID) + ", " + quoteLiteral(ref) + ", " +
			quoteLiteral(hash) + ", " + bytes + ", " + quoteLiteral(state) + ")"
	}
	for _, c := range []struct{ name, sql, want string }{
		{"hash differs", ins(versionID, "local", "local/out/w.md", hex64("b4-replica-other"), "1024", "published"),
			"artifact_replica_content_mismatch"},
		{"bytes differ", ins(versionID, "local", "local/out/w.md", contentHash, "999", "published"),
			"artifact_replica_content_mismatch"},
		{"hash not 64 hex", ins(versionID, "local", "local/out/w.md", "zz", "1024", "published"),
			"artifact_replica_content_mismatch"},
		{"negative bytes", ins(versionID, "local", "local/out/w.md", contentHash, "-1", "published"),
			"artifact_replica_content_mismatch"},
		{"version row missing", ins(newUUID(t), "local", "local/out/w.md", contentHash, "1024", "published"),
			"not_found"},
		{"location outside the closed set", ins(versionID, "cloud", "local/out/w.md", contentHash, "1024", "published"),
			"artifact_replica_location_check"},
		{"state outside the closed set", ins(versionID, "local", "local/out/w.md", contentHash, "1024", "deleted"),
			"artifact_replica_state_check"},
		{"empty local_ref", ins(versionID, "local", "", contentHash, "1024", "published"),
			"artifact_replica_local_ref_shape"},
	} {
		t.Run(c.name, func(t *testing.T) {
			expectConstraint(t, l.admin, c.want, c.sql)
		})
	}
	// The version edge is exercised through the guard rather than the FK: the BEFORE trigger
	// raises not_found for a missing version one step earlier, so the fkey is the backstop,
	// not the first line. It is asserted structurally below instead, where the whole catalog
	// edge is read.
	if got := mustScalar(t, l.admin, "SELECT count(*)::text FROM pg_constraint c "+
		"JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'work' AND "+
		"c.conrelid = 'work.artifact_replica'::regclass AND c.contype = 'f'"); got != "3" {
		t.Fatalf("artifact_replica has %s foreign keys, want the 3 shipped edges", got)
	}

	// Append-only: the row is evidence, and rewriting it would rewrite the fact that the
	// bytes were on a device.
	expectConstraint(t, l.admin, "append_only_table:artifact_replica", "UPDATE work.artifact_replica SET state = "+
		"'published' WHERE org_id = "+quoteLiteral(l.org))
	expectConstraint(t, l.admin, "append_only_table:artifact_replica", "DELETE FROM work.artifact_replica WHERE org_id = "+
		quoteLiteral(l.org))
	// The nonce ledger is append-only too, and a row-level trigger on an empty table
	// proves nothing, so one row is seeded here. Deleting a consumed nonce is the same as
	// allowing that nonce to be replayed, which is why 0043 ships the trigger rather than
	// relying on the PRIMARY KEY.
	nonceSeed := "b4-nonce-append-only-" + newUUID(t)
	mustExec(t, l.admin, "INSERT INTO work.consumed_possession_nonce (org_id, purpose, nonce) VALUES ("+
		quoteLiteral(l.org)+", 'user_version', "+quoteLiteral(nonceSeed)+")")
	expectConstraint(t, l.admin, "append_only_table:consumed_possession_nonce", "DELETE FROM work.consumed_possession_nonce "+
		"WHERE org_id = "+quoteLiteral(l.org)+" AND nonce = "+quoteLiteral(nonceSeed))
	expectConstraint(t, l.admin, "append_only_table:consumed_possession_nonce", "UPDATE work.consumed_possession_nonce "+
		"SET purpose = 'workspace_rebind' WHERE org_id = "+quoteLiteral(l.org)+" AND nonce = "+quoteLiteral(nonceSeed))
	expectConstraint(t, l.admin, "consumed_possession_nonce_purpose_check",
		"INSERT INTO work.consumed_possession_nonce (org_id, purpose, nonce) VALUES ("+
			quoteLiteral(l.org)+", 'approval', "+quoteLiteral(nonceSeed+"-2")+")")

	// And the shipped chain itself has exactly one INSERT into the table. This is the part
	// of the one-writer claim the privilege sweep cannot see: a definer command added later
	// would pass every has_table_privilege test above. That scan is the separate test below,
	// TestR0bArtifactReplicaInsertStatementExistsOnceInShipChain.
}

func TestR0bArtifactReplicaInsertStatementExistsOnceInShipChain(t *testing.T) {
	files, err := fs.Glob(embedded.FS, "increments/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Fatal("no increments in the embedded chain; the scan proves nothing")
	}
	baseline, err := fs.ReadFile(embedded.FS, "baseline/0002_initial_r0a_schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	// The baseline predates the table, so it must contribute zero matches.
	if n := strings.Count(string(baseline), "INTO work.artifact_replica"); n != 0 {
		t.Fatalf("the baseline inserts into artifact_replica %d times", n)
	}
	total := 0
	var found, statement string
	for _, name := range files {
		body, err := fs.ReadFile(embedded.FS, name)
		if err != nil {
			t.Fatal(err)
		}
		n := strings.Count(string(body), "INTO work.artifact_replica")
		if n == 0 {
			continue
		}
		total += n
		found = name
		for _, line := range strings.Split(string(body), "\n") {
			if strings.Contains(line, "INTO work.artifact_replica") {
				statement = strings.TrimSpace(line)
			}
		}
	}
	if total != 1 {
		t.Fatalf("%d INSERT statements into work.artifact_replica across the chain, want exactly 1", total)
	}
	if !strings.HasSuffix(found, "0043_local_artifact_replica_finalize.sql") ||
		!strings.Contains(statement, "INSERT INTO work.artifact_replica") {
		t.Fatalf("the single writer is in %s as %q, want finalize's INSERT", found, statement)
	}
	// It must sit inside finalize's body, not in another function of the same increment.
	body, err := fs.ReadFile(embedded.FS, found)
	if err != nil {
		t.Fatal(err)
	}
	start := strings.Index(string(body), "CREATE FUNCTION work.finalize_local_artifact(")
	end := strings.Index(string(body)[start:], "\n$$;")
	if start < 0 || end < 0 || strings.Index(string(body), "INTO work.artifact_replica") > start+end {
		t.Fatal("the replica INSERT is not inside finalize_local_artifact's body")
	}
	// No shipped statement updates or deletes the table.
	for _, name := range append(files, "baseline/0002_initial_r0a_schema.sql") {
		body, err := fs.ReadFile(embedded.FS, name)
		if err != nil {
			t.Fatal(err)
		}
		for _, needle := range []string{"UPDATE work.artifact_replica", "DELETE FROM work.artifact_replica",
			"UPDATE work.consumed_possession_nonce", "DELETE FROM work.consumed_possession_nonce"} {
			if strings.Contains(string(body), needle) {
				t.Fatalf("%s contains %q", name, needle)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// create_local_user_artifact_version
// ---------------------------------------------------------------------------

type userSaveFixture struct {
	*deviceFixture
	deviceID   string
	sessionID  string
	artifactID string
	baseID     string
	baseHash   string
	authEpoch  string
}

func newUserSaveFixture(t *testing.T, org string) *userSaveFixture {
	t.Helper()
	f := newDeviceFixture(t, org)
	api := f.apiConn(t)
	worker := f.workerConn(t)
	deviceID, _ := f.pairAndConfirm(t, api, "req-b4-user-pair")
	thumb := mustScalar(t, f.admin, "SELECT public_key_thumbprint FROM work.device WHERE id = "+quoteLiteral(deviceID))
	minted := callJSON(t, api, `SELECT work.mint_device_session_ticket($1,$2,'bearer',7,$3::uuid,$4,$5)`,
		f.org, f.subject, deviceID, "req-b4-user-tick", thumb)
	ticket, _ := minted["ticket"].(string)
	ticketHash := mustScalar(t, f.admin, "SELECT work.sha256_text("+quoteLiteral(ticket)+")")
	hello := `{"boot_id":"boot-u","agent_instance_id":"` + newUUID(t) + `","journal_epoch":"` + newUUID(t) +
		`","runtime_digest":"` + strings.Repeat("6", 64) + `","protocol_major":2,"protocol_minor":0}`
	session := callJSON(t, worker, `SELECT work.activate_device_session($1,$2::uuid,$3,$4::jsonb)`,
		f.org, deviceID, ticketHash, hello)
	sessionID, _ := session["session_id"].(string)
	u := &userSaveFixture{deviceFixture: f, deviceID: deviceID, sessionID: sessionID,
		artifactID: newUUID(t), baseHash: hex64("b4-user-base"),
		authEpoch: mustScalar(t, f.admin, "SELECT auth_epoch::text FROM work.device WHERE id = "+quoteLiteral(deviceID))}
	// baseID is the id the seeded row actually carries. It used to be a UUID invented here,
	// so every "mutate the base fact" UPDATE below matched zero rows and the cases proved
	// nothing - a success on an untouched base is indistinguishable from a pass.
	u.baseID = u.seedVersion(t, 1, "local_only", u.baseHash, "local/base.md", u.deviceID, "local_only", "'{}'::jsonb")
	return u
}

// seedVersion writes a base fact directly. The user save appends to a version; producing
// that predecessor through finalize would need the whole device slice again for every
// negative case, and none of these cases test how the base got there.
func (u *userSaveFixture) seedVersion(t *testing.T, versionNo int, location, contentHash, localRef,
	deviceID, classification, provenance string) string {
	t.Helper()
	versionID := newUUID(t)
	mustExec(t, u.admin, "INSERT INTO work.artifact (id, org_id, task_id, logical_name, state) VALUES ("+
		quoteLiteral(u.artifactID)+", "+quoteLiteral(u.org)+", "+quoteLiteral(u.taskID)+", 'reports/base.md', 'published') ON CONFLICT (id) DO NOTHING")
	contentRef := "NULL"
	if location == "cloud" {
		contentRef = quoteLiteral("cs/" + contentHash)
		localRef = ""
		deviceID = ""
	}
	mustExec(t, u.admin, "INSERT INTO work.artifact_version (artifact_id, org_id, version_no, content_hash, "+
		"bytes, media_type, state, provenance, published_at, version_id, location, local_ref, device_id, classification, content_ref) VALUES ("+
		quoteLiteral(u.artifactID)+", "+quoteLiteral(u.org)+", "+strconv.Itoa(versionNo)+", "+quoteLiteral(contentHash)+
		", 512, 'text/markdown', 'published', "+provenance+", now(), "+quoteLiteral(versionID)+", "+
		quoteLiteral(location)+", "+quoteLiteralOrNULL(localRef)+", "+quoteLiteralOrNULL(deviceID)+", "+
		quoteLiteral(classification)+", "+contentRef+")")
	return versionID
}

func quoteLiteralOrNULL(v string) string {
	if v == "" {
		return "NULL"
	}
	return quoteLiteral(v)
}

type userProof struct {
	RequestID   string
	Nonce       string
	BaseNo      int
	BaseHash    string
	ContentHash string
	Class       string
	Bytes       int64
	Clipboard   []string
	Expires     time.Time
	// Over replaces a named key's raw JSON fragment; "-" drops the key.
	Over map[string]string
}

func (u *userSaveFixture) proof(t *testing.T, p userProof) string {
	t.Helper()
	if p.Expires.IsZero() {
		p.Expires = time.Now().UTC().Add(10 * time.Minute)
	}
	clip := "[]"
	derived := "false"
	if len(p.Clipboard) > 0 {
		parts := make([]string, 0, len(p.Clipboard))
		for _, id := range p.Clipboard {
			parts = append(parts, jstr(id))
		}
		clip = "[" + strings.Join(parts, ",") + "]"
		derived = "true"
	}
	if p.Nonce == "" {
		p.Nonce = "nonce-b4-" + newUUID(t)[:8]
	}
	fields := []struct{ key, raw string }{
		{"v", "1"},
		{"org_id", jstr(u.org)},
		{"subject_id", jstr(u.subject)},
		{"auth_plane", `"bearer"`},
		{"auth_epoch", u.authEpoch},
		{"device_id", jstr(u.deviceID)},
		{"session_id", jstr(u.sessionID)},
		{"task_id", jstr(u.taskID)},
		{"artifact_id", jstr(u.artifactID)},
		{"base_version_no", strconv.Itoa(p.BaseNo)},
		{"base_hash", jstr(p.BaseHash)},
		{"version_id", jstr(newUUID(t))},
		{"format", `"text/markdown"`},
		{"content_hash", jstr(p.ContentHash)},
		{"bytes", strconv.FormatInt(p.Bytes, 10)},
		{"classification", jstr(p.Class)},
		{"clipboard_derived", derived},
		{"clipboard_source_version_ids", clip},
		{"client_request_id", jstr(p.RequestID)},
		{"nonce", jstr(p.Nonce)},
		{"expires_at", jstr(p.Expires.Format(time.RFC3339))},
	}
	parts := make([]string, 0, len(fields))
	for _, f := range fields {
		raw := f.raw
		if v, ok := p.Over[f.key]; ok {
			if v == "-" {
				continue
			}
			raw = v
		}
		parts = append(parts, jstr(f.key)+":"+raw)
	}
	if extra, ok := p.Over["+extra"]; ok {
		parts = append(parts, extra)
	}
	return "{" + strings.Join(parts, ",") + "}"
}

// userSaveSQL carries the auth plane as a scalar rather than hardcoding 'bearer', because
// :704's invalid_request branch is only reachable from the plane the CALLER sends. A
// hardcoded literal would leave that raise untested and would let a proof-plane mismatch
// masquerade as the :766 unauthorized.
const userSaveSQL = `SELECT work.create_local_user_artifact_version($1,$2,$3,$4::bigint,$5::uuid,$6::uuid,$7::uuid,$8,$9,$10::jsonb)`

func (u *userSaveFixture) save(t *testing.T, api *pgx.Conn, requestID, localRef, proof string) map[string]any {
	t.Helper()
	return callJSON(t, api, userSaveSQL, u.org, u.subject, "bearer", u.authEpoch, u.deviceID,
		u.sessionID, u.artifactID, requestID, localRef, proof)
}

func (u *userSaveFixture) saveRefused(t *testing.T, api *pgx.Conn, requestID, localRef, proof string) refusal {
	t.Helper()
	return u.refuseSave(t, api, requestID, "bearer", localRef, proof, "", "")
}

// refuseSave pins a user-save refusal in one place. The ten argument slots sit next to each
// other in the shipped signature and differ only by type, so a call written out by hand is
// how a transposed pair becomes a silent green; wantCode/wantState empty means "the caller
// asserts on the returned refusal instead".
func (u *userSaveFixture) refuseSave(t *testing.T, api *pgx.Conn, requestID, plane, localRef, proof, wantCode, wantState string) refusal {
	t.Helper()
	got := refuse(t, api, userSaveSQL, u.org, u.subject, plane, u.authEpoch, u.deviceID,
		u.sessionID, u.artifactID, requestID, localRef, proof)
	if wantCode != "" && got.code != wantCode {
		t.Fatalf("%s: expected %q, got %q (SQLSTATE %s, detail %q)", requestID, wantCode, got.code, got.state, got.detail)
	}
	if wantState != "" && got.state != wantState {
		t.Fatalf("%s: %q raised SQLSTATE %s, want %s", requestID, wantCode, got.state, wantState)
	}
	return got
}

func (u *userSaveFixture) census(t *testing.T) string {
	t.Helper()
	return mustScalar(t, u.admin, "SELECT (SELECT count(*) FROM work.artifact_version WHERE org_id = "+
		quoteLiteral(u.org)+")::text || '/' || (SELECT count(*) FROM work.artifact_replica WHERE org_id = "+
		quoteLiteral(u.org)+")::text || '/' || (SELECT count(*) FROM work.consumed_possession_nonce WHERE org_id = "+
		quoteLiteral(u.org)+")::text || '/' || (SELECT count(*) FROM work.submission_dedup WHERE org_id = "+
		quoteLiteral(u.org)+")::text")
}

func TestR0bUserSaveSpendsItsNonceAndWritesNoReplica(t *testing.T) {
	u := newUserSaveFixture(t, "org_b4_user_save")
	api := u.apiConn(t)
	nonce := "nonce-b4-save-1"
	contentHash := hex64("b4-user-v2")
	localRef := "local/edit/notes-v2.md"
	proof := u.proof(t, userProof{RequestID: "req-b4-save-1", Nonce: nonce, BaseNo: 1,
		BaseHash: u.baseHash, ContentHash: contentHash, Class: "local_only", Bytes: 700})

	out := u.save(t, api, "req-b4-save-1", localRef, proof)
	if out["version_no"] != float64(2) || out["location"] != "local_only" || out["replayed"] != false {
		t.Fatalf("user save = %#v", out)
	}
	if out["local_ref"] != localRef {
		t.Fatalf("user save echoed the wrong local_ref: %#v", out)
	}
	versionID, _ := out["version_id"].(string)
	// Same expression as finalize :964, read from the row the command just wrote rather
	// than copied out of the response, so an ack built from anything else would not match.
	if wantAck := "sha256:" + mustScalar(t, u.admin,
		"SELECT work.sha256_text('local_publish_ack|'||version_id::text||'|'||content_hash) "+
			"FROM work.artifact_version WHERE org_id = "+quoteLiteral(u.org)+
			" AND version_id = "+quoteLiteral(versionID)+"::uuid"); out["publish_ack"] != wantAck {
		t.Fatalf("publish_ack = %v, want %s", out["publish_ack"], wantAck)
	}

	// The version row carries the unsigned scalar, and no replica row is minted: §17.2. This
	// is the asymmetry the design records, so it is asserted as behaviour rather than left
	// to a comment.
	if got := mustScalar(t, u.admin, "SELECT state || '/' || location || '/' || local_ref || '/' || "+
		"(device_id = "+quoteLiteral(u.deviceID)+")::text || '/' || (provenance ->> 'source') || '/' || "+
		"(content_ref IS NULL)::text FROM work.artifact_version WHERE org_id = "+quoteLiteral(u.org)+
		" AND version_id = "+quoteLiteral(versionID)); got != "published/local_only/"+localRef+"/true/user/true" {
		t.Fatalf("saved version row = %q", got)
	}
	if got := countRows(t, u.admin, "SELECT count(*) FROM work.artifact_replica WHERE org_id = "+quoteLiteral(u.org)); got != 0 {
		t.Fatalf("replica rows after a user save = %d, want 0 (no server-verifiable device evidence)", got)
	}
	if got := mustScalar(t, u.admin, "SELECT purpose FROM work.consumed_possession_nonce WHERE org_id = "+
		quoteLiteral(u.org)+" AND nonce = "+quoteLiteral(nonce)); got != "user_version" {
		t.Fatalf("nonce purpose = %q, want user_version", got)
	}
	// §7.1's tuple is the R0a cloud save's operation_type, not a new '.local' domain.
	if got := mustScalar(t, u.admin, "SELECT operation_type || '/' || result_state || '/' || "+
		"(task_id IS NOT NULL)::text FROM work.submission_dedup WHERE org_id = "+quoteLiteral(u.org)+
		" AND client_request_id = 'req-b4-save-1'"); got != "artifact.version/published/true" {
		t.Fatalf("dedupe tuple = %q", got)
	}
	if got := countRows(t, u.admin, "SELECT count(*) FROM work.audit_event WHERE org_id = "+quoteLiteral(u.org)+
		" AND action = 'artifact.local_version_create'"); got != 1 {
		t.Fatalf("audit rows = %d, want 1", got)
	}
	if got := countRows(t, u.admin, "SELECT count(*) FROM work.task_event WHERE org_id = "+quoteLiteral(u.org)+
		" AND type = 'artifact.published'"); got != 1 {
		t.Fatalf("task_event rows = %d, want 1", got)
	}

	// The same key with the same local_ref is the ordinary retry: the original answer comes
	// back, and neither the nonce table nor the version table grows. It also must not spend
	// a second nonce or re-check expiry, which is why a replay is safe during an outage.
	replay := u.save(t, api, "req-b4-save-1", localRef, proof)
	if replay["replayed"] != true || replay["version_id"] != versionID || replay["publish_ack"] != out["publish_ack"] {
		t.Fatalf("replay = %#v, want the original %s", replay, versionID)
	}
	if got := u.census(t); got != "2/0/1/1" {
		t.Fatalf("census after replay = %s, want versions/replicas/nonces/dedup = 2/0/1/1", got)
	}

	// The same key with a DIFFERENT local_ref is a conflict, not a silent re-point, because
	// local_ref is folded into the request hash (O-19).
	moved := u.proof(t, userProof{RequestID: "req-b4-save-1", Nonce: "nonce-b4-save-moved", BaseNo: 1,
		BaseHash: u.baseHash, ContentHash: contentHash, Class: "local_only", Bytes: 700})
	got := u.saveRefused(t, api, "req-b4-save-1", "local/elsewhere.md", moved)
	if got.code != "idempotency_key_conflict" {
		t.Fatalf("moved pointer = %q, want idempotency_key_conflict", got.code)
	}
	if census := u.census(t); census != "2/0/1/1" {
		t.Fatalf("census after the moved-pointer conflict = %s, want 2/0/1/1", census)
	}

	// A fresh key reusing the spent nonce is a replayed signature: unauthorized with the
	// permission SQLSTATE, and nothing written.
	again := u.proof(t, userProof{RequestID: "req-b4-save-2", Nonce: nonce, BaseNo: 1,
		BaseHash: u.baseHash, ContentHash: hex64("b4-user-v3"), Class: "local_only", Bytes: 700})
	u.refuseSave(t, api, "req-b4-save-2", "bearer", "local/edit/v3.md", again, "unauthorized", "42501")
	if census := u.census(t); census != "2/0/1/1" {
		t.Fatalf("census after the nonce replay = %s, want 2/0/1/1", census)
	}
}

func TestR0bUserSaveRefusalsWriteNothing(t *testing.T) {
	u := newUserSaveFixture(t, "org_b4_user_refusals")
	api := u.apiConn(t)
	empty := u.census(t)
	if empty != "1/0/0/0" {
		t.Fatalf("fixture census = %s, want 1/0/0/0", empty)
	}

	base := func() userProof {
		return userProof{RequestID: "req-b4-refuse", BaseHash: u.baseHash, ContentHash: hex64("b4-refuse"),
			Class: "local_only", Bytes: 700, BaseNo: 1}
	}
	// Each case gets its own client_request_id so the dedupe table is never what refused it.
	cases := []struct {
		name     string
		localRef string
		proof    func(i int) userProof
		want     string
		state    string
	}{
		{"expired proof", "local/x.md", func(i int) userProof {
			p := base()
			p.RequestID = "req-b4-expired"
			p.Nonce = "nonce-b4-expired" + strconv.Itoa(i)
			p.Expires = time.Now().UTC().Add(-time.Minute)
			return p
		}, "local_proof_expired", "P0001"},
		{"auth_epoch differs", "local/x.md", func(i int) userProof {
			p := base()
			p.RequestID = "req-b4-epoch"
			p.Over = map[string]string{"auth_epoch": "999"}
			return p
		}, "unauthorized", "P0001"},
		{"device in proof differs", "local/x.md", func(i int) userProof {
			p := base()
			p.RequestID = "req-b4-device"
			p.Over = map[string]string{"device_id": jstr(newUUID(t))}
			return p
		}, "unauthorized", "P0001"},
		{"subject in proof differs", "local/x.md", func(i int) userProof {
			p := base()
			p.RequestID = "req-b4-subject"
			p.Over = map[string]string{"subject_id": jstr("sub_someone_else")}
			return p
		}, "unauthorized", "P0001"},
		{"client_request_id in proof differs", "local/x.md", func(i int) userProof {
			p := base()
			p.RequestID = "req-b4-crid"
			p.Over = map[string]string{"client_request_id": jstr("req-b4-something-else")}
			return p
		}, "unauthorized", "P0001"},
		{"signature inside the payload", "local/x.md", func(i int) userProof {
			p := base()
			p.RequestID = "req-b4-22keys"
			p.Over = map[string]string{"+extra": `"signature":` + jstr("sha256:"+strings.Repeat("a", 64))}
			return p
		}, "invalid_request", "22023"},
		{"missing base_hash", "local/x.md", func(i int) userProof {
			p := base()
			p.RequestID = "req-b4-20keys"
			p.Over = map[string]string{"base_hash": "-"}
			return p
		}, "invalid_request", "22023"},
		{"nonce too short", "local/x.md", func(i int) userProof {
			p := base()
			p.RequestID = "req-b4-nonce"
			p.Over = map[string]string{"nonce": jstr("abc")}
			return p
		}, "invalid_request", "22023"},
		{"base_version_no zero", "local/x.md", func(i int) userProof {
			p := base()
			p.RequestID = "req-b4-zerobase"
			p.Over = map[string]string{"base_version_no": "0"}
			return p
		}, "invalid_request", "22023"},
		{"negative bytes", "local/x.md", func(i int) userProof {
			p := base()
			p.RequestID = "req-b4-negbytes"
			p.Over = map[string]string{"bytes": "-5"}
			return p
		}, "invalid_request", "22023"},
		{"clipboard ids not an array", "local/x.md", func(i int) userProof {
			p := base()
			p.RequestID = "req-b4-clipshape"
			p.Over = map[string]string{"clipboard_source_version_ids": `"not-an-array"`}
			return p
		}, "invalid_request", "22023"},
		{"clipboard ids hold a non-uuid", "local/x.md", func(i int) userProof {
			p := base()
			p.RequestID = "req-b4-clipuuid"
			p.Over = map[string]string{"clipboard_source_version_ids": `["nope"]`}
			return p
		}, "invalid_request", "22023"},
		{"classification outside the closed set", "local/x.md", func(i int) userProof {
			p := base()
			p.RequestID = "req-b4-class"
			p.Class = "public"
			return p
		}, "classification_unknown", "P0001"},
		{"looser than the base", "local/x.md", func(i int) userProof {
			p := base()
			p.RequestID = "req-b4-floor"
			p.Class = "remote_excerpt_allowed"
			return p
		}, "classification_floor_required", "P0001"},
		{"bytes over the output limit", "local/x.md", func(i int) userProof {
			p := base()
			p.RequestID = "req-b4-large"
			p.Bytes = 262145
			return p
		}, "artifact_too_large", "P0001"},
		{"empty local_ref", "", func(i int) userProof {
			p := base()
			p.RequestID = "req-b4-emptyref"
			return p
		}, "invalid_request", "22023"},
		{"proof plane differs from the scalar", "local/x.md", func(i int) userProof {
			p := base()
			p.RequestID = "req-b4-plane"
			p.Over = map[string]string{"auth_plane": `"cookie"`}
			return p
		}, "unauthorized", "P0001"},
	}
	for i, c := range cases {
		p := c.proof(i)
		u.refuseSave(t, api, p.RequestID, "bearer", c.localRef, u.proof(t, p), c.want, c.state)
		if census := u.census(t); census != empty {
			t.Fatalf("case %q left side effects: census %s, want %s", c.name, census, empty)
		}
	}

	// :704's own branch is the SCALAR plane, which the case above cannot reach: it changes
	// the proof's copy and therefore lands on :766's mismatch instead. The two arms are
	// adjacent in the body and raise different codes, so both are pinned separately.
	u.refuseSave(t, api, "req-b4-plane-scalar", "cookie", "local/x.md",
		u.proof(t, userProof{RequestID: "req-b4-plane-scalar", BaseNo: 1, BaseHash: u.baseHash,
			ContentHash: hex64("b4-plane-scalar"), Class: "local_only", Bytes: 700}),
		"invalid_request", "22023")

	// The request-key shape is owned by lock_request_key (:726), not re-checked here, and it
	// arrives as the same 22023 class.
	u.refuseSave(t, api, "", "bearer", "local/x.md",
		u.proof(t, userProof{RequestID: "", BaseNo: 1, BaseHash: u.baseHash,
			ContentHash: hex64("b4-keyshape"), Class: "local_only", Bytes: 700}),
		"invalid_client_request_id", "22023")

	// Every refusal above must leave the nonce table empty: the spend at :804 sits after the
	// expiry check, and a raise anywhere later takes the insert down with it.
	if got := countRows(t, u.admin, "SELECT count(*) FROM work.consumed_possession_nonce WHERE org_id = "+
		quoteLiteral(u.org)); got != 0 {
		t.Fatalf("nonce rows after the refusals = %d, want 0", got)
	}

	// The two gate branches are literal codes in the body, and each is reachable from the
	// organization's own policy row. J20's first branch is "no mapping, or a default nobody
	// confirmed", and only the second half of that sentence is writable here: un-confirming
	// an already-confirmed row is itself refused (local_execution_policy_content_immutable,
	// 0020:195), so the branch is reached through the empty rule set instead.
	mustExec(t, u.admin, `UPDATE work.local_execution_policy SET classification_rules = '[]'::jsonb WHERE org_id = `+
		quoteLiteral(u.org))
	u.refuseSave(t, api, "req-b4-gate1", "bearer", "local/x.md",
		u.proof(t, userProof{RequestID: "req-b4-gate1", BaseNo: 1, BaseHash: u.baseHash,
			ContentHash: hex64("b4-gate1"), Class: "local_only", Bytes: 700}),
		"local_policy_not_configured", "P0001")
	mustExec(t, u.admin, `UPDATE work.local_execution_policy SET classification_rules = `+
		`'[{"matcher":{"path_prefix":"docs"},"classification":"local_only","max_confirmable":"local_only"},`+
		`{"matcher":{"path_prefix":"public"},"classification":"remote_excerpt_allowed","max_confirmable":"remote_excerpt_allowed"}]'::jsonb, `+
		"allowed_destinations = '{}' WHERE org_id = "+quoteLiteral(u.org))
	u.refuseSave(t, api, "req-b4-gate2", "bearer", "local/x.md",
		u.proof(t, userProof{RequestID: "req-b4-gate2", BaseNo: 1, BaseHash: u.baseHash,
			ContentHash: hex64("b4-gate2"), Class: "local_only", Bytes: 700}),
		"local_policy_incomplete", "P0001")
	mustExec(t, u.admin, "UPDATE work.local_execution_policy SET allowed_destinations = ARRAY['device_local'] WHERE org_id = "+
		quoteLiteral(u.org))

	// A viewer seat is refused before any of the proof's own content matters, and a revoked
	// device loses the path through its device row.
	mustExec(t, u.admin, "UPDATE work.member SET role = 'viewer' WHERE org_id = "+quoteLiteral(u.org)+
		" AND subject_id = "+quoteLiteral(u.subject))
	u.refuseSave(t, api, "req-b4-seat", "bearer", "local/x.md",
		u.proof(t, userProof{RequestID: "req-b4-seat", BaseNo: 1, BaseHash: u.baseHash,
			ContentHash: hex64("b4-seat"), Class: "local_only", Bytes: 700}),
		"work_seat_required", "P0001")
	mustExec(t, u.admin, "UPDATE work.member SET role = 'owner' WHERE org_id = "+quoteLiteral(u.org)+
		" AND subject_id = "+quoteLiteral(u.subject))
	callJSON(t, api, `SELECT work.revoke_device($1,$2,$3::uuid,$4,'b4')`, u.org, u.subject, u.deviceID, "req-b4-revoke")
	u.refuseSave(t, api, "req-b4-revoked", "bearer", "local/x.md",
		u.proof(t, userProof{RequestID: "req-b4-revoked", BaseNo: 1, BaseHash: u.baseHash,
			ContentHash: hex64("b4-revoked"), Class: "local_only", Bytes: 700}),
		"device_revoked", "P0001")
	if census := u.census(t); census != empty {
		t.Fatalf("census at the end of the refusals = %s, want %s", census, empty)
	}
}

func TestR0bUserSaveBaseReconciliationAndQuiescence(t *testing.T) {
	u := newUserSaveFixture(t, "org_b4_user_base")
	api := u.apiConn(t)
	save := func(requestID, class string, baseNo int, baseHash string) refusal {
		return u.saveRefused(t, api, requestID, "local/edit/v2.md",
			u.proof(t, userProof{RequestID: requestID, BaseNo: baseNo, BaseHash: baseHash,
				ContentHash: hex64("b4-" + requestID), Class: class, Bytes: 700}))
	}

	// Every case below reads a BASE fact, and 0017:223 froze all of them
	// (location/local_ref/device_id/classification/content_hash/provenance/version_no), so
	// none of the arms can be reached by rewriting the fixture's v1. They are reached by
	// SEEDING a newer version: :839 selects the highest published version_no as the base, so
	// each row takes over that slot with the shape its own case needs.
	//
	// wantLatest is what keeps each seeded row honest. A seed that landed on the wrong
	// artifact, with the wrong state, or not at all would leave :843 refusing for a reason
	// that has nothing to do with the arm under test, and the refusal would still read as a
	// pass.
	wantLatest := func(no int) {
		t.Helper()
		if got := mustScalar(t, u.admin, "SELECT coalesce(max(version_no), 0)::text FROM work.artifact_version "+
			"WHERE org_id = "+quoteLiteral(u.org)+" AND artifact_id = "+quoteLiteral(u.artifactID)+
			" AND state = 'published'"); got != strconv.Itoa(no) {
			t.Fatalf("latest published version_no = %s, want %d (the case below would not be about its arm)", got, no)
		}
	}
	wantLatest(1)

	// The hash arm first, and it needs no new row at all: only the PROOF's base_hash is
	// wrong. It is also what makes the two seeded cases attributable - if a disagreeing hash
	// alone did not refuse, a refusal below could not be pinned to location or device_id.
	if got := save("req-b4-wrong-hash", "local_only", 1, hex64("other-base")); got.code != "content_on_original_device" {
		t.Fatalf("base hash differs = %q, want content_on_original_device", got.code)
	}

	// A base on another device is the same refusal: a local_only version is not portable. The
	// device row has to be real - 0040:1119 bound artifact_version.device_id to work.device,
	// so an invented uuid is refused by the FK long before the command runs.
	foreignJWK := `{"kty":"EC","crv":"P-256","x":"` + strings.Repeat("c", 43) +
		`","y":"` + strings.Repeat("d", 43) + `"}`
	foreignID := newUUID(t)
	mustExec(t, u.admin, "INSERT INTO work.device (id, org_id, owner_subject_id, status, device_name, "+
		"platform, public_key_jwk, public_key_thumbprint, auth_plane, auth_epoch) VALUES ("+quoteLiteral(foreignID)+
		", "+quoteLiteral(u.org)+", "+quoteLiteral(u.subject)+", 'active', 'other', 'windows-x64', "+
		quoteLiteral(foreignJWK)+"::jsonb, work.device_key_thumbprint("+quoteLiteral(foreignJWK)+"::jsonb), "+
		"'bearer', "+u.authEpoch+")")
	u.seedVersion(t, 2, "local_only", hex64("b4-foreign-base"), "local/edit/other.md", foreignID,
		"local_only", "'{}'::jsonb")
	wantLatest(2)
	if got := save("req-b4-other-device", "local_only", 2, hex64("b4-foreign-base")); got.code != "content_on_original_device" {
		t.Fatalf("base on another device = %q, want content_on_original_device", got.code)
	}

	// A cloud base: the bytes are not on any device, so a local append is not what this is.
	u.seedVersion(t, 3, "cloud", hex64("b4-cloud-base"), "", "", "remote_excerpt_allowed", "'{}'::jsonb")
	wantLatest(3)
	if got := save("req-b4-cloud-base", "local_only", 3, hex64("b4-cloud-base")); got.code != "content_on_original_device" {
		t.Fatalf("cloud base = %q, want content_on_original_device", got.code)
	}

	// J17's replacement for "the latest Run is not failed": the base's OWN Run must be
	// reconciled. :853 reads the Run out of the base's provenance, which is another frozen
	// column, so the version that carries one has to be seeded with it. The base above it is
	// local_only on this device with the hash its proof names, which is what leaves :853 as
	// the only arm that can refuse.
	//
	// u.runID is that Run. The admission trigger for a new Operation is INSERT-only and needs
	// the Task to point at a non-terminal Run, so the operation lands with active_run_id set
	// and the Task is released again before the call - :832's Task-level branch raises the
	// same code one step earlier, and leaving it set would make this case evidence about the
	// wrong arm.
	mustExec(t, u.admin, "UPDATE work.task SET active_run_id = "+quoteLiteral(u.runID)+" WHERE id = "+quoteLiteral(u.taskID))
	flight := newUUID(t)
	mustExec(t, u.admin, "INSERT INTO work.operation (id, org_id, run_id, logical_key, kind, request_hash, state) VALUES ("+
		quoteLiteral(flight)+", "+quoteLiteral(u.org)+", "+quoteLiteral(u.runID)+", 'tool:5#0', 'tool', '"+
		hex64("flight")+"', 'unknown')")
	mustExec(t, u.admin, "UPDATE work.task SET active_run_id = NULL WHERE id = "+quoteLiteral(u.taskID))
	u.seedVersion(t, 4, "local_only", hex64("b4-run-base"), "local/edit/v4.md", u.deviceID,
		"local_only", "jsonb_build_object('source','run','run_id', "+quoteLiteral(u.runID)+"::text)")
	wantLatest(4)
	if got := mustScalar(t, u.admin, "SELECT count(*)::text FROM work.operation WHERE org_id = "+
		quoteLiteral(u.org)+" AND run_id = "+quoteLiteral(u.runID)+" AND state = 'unknown'"); got != "1" {
		t.Fatalf("in-flight operations on the base's Run = %s, want 1", got)
	}
	if got := save("req-b4-inflight", "local_only", 4, hex64("b4-run-base")); got.code != "run_not_quiescent" {
		t.Fatalf("base Run mid-flight = %q, want run_not_quiescent", got.code)
	}
	// unknown -> reconciled is one of the shipped transitions, and clearing it is what lets
	// the OTHER arm of the same code be seen: with the base's Run clean, the only thing that
	// can refuse is a Task still running something. That ordering is what makes the case
	// above evidence about the base-Run arm specifically.
	mustExec(t, u.admin, "UPDATE work.operation SET state = 'reconciled' WHERE id = "+quoteLiteral(flight))
	mustExec(t, u.admin, "UPDATE work.task SET active_run_id = "+quoteLiteral(u.runID)+" WHERE id = "+quoteLiteral(u.taskID))
	if got := save("req-b4-active-run", "local_only", 4, hex64("b4-run-base")); got.code != "run_not_quiescent" {
		t.Fatalf("Task with an active Run = %q, want run_not_quiescent", got.code)
	}
	// Both arms clear and the append re-opens, which is the whole point of J17: one wrongly
	// clicked reject used to freeze an already-written local result forever.
	mustExec(t, u.admin, "UPDATE work.task SET active_run_id = NULL WHERE id = "+quoteLiteral(u.taskID))
	out := u.save(t, api, "req-b4-after-reconcile", "local/edit/v2.md",
		u.proof(t, userProof{RequestID: "req-b4-after-reconcile", BaseNo: 4, BaseHash: hex64("b4-run-base"),
			ContentHash: hex64("b4-after-reconcile"), Class: "local_only", Bytes: 700}))
	if out["version_no"] != float64(5) {
		t.Fatalf("save after reconciling the base Run = %#v, want version 5", out)
	}
	wantLatest(5)
	// Now the base is v5, so a proof naming v4 is refused with the number it has to move to.
	if got := save("req-b4-stale-again", "local_only", 4, hex64("b4-run-base")); got.code != "version_conflict" || got.detail != "5" {
		t.Fatalf("stale base = %q detail %q, want version_conflict/5", got.code, got.detail)
	}

	// An artifact with no published version at all cannot be the base of a UserVersionProof:
	// this command appends, it does not start.
	orphan := newUserSaveFixture(t, "org_b4_user_orphan")
	mustExec(t, orphan.admin, "DELETE FROM work.artifact_version WHERE org_id = "+quoteLiteral(orphan.org))
	orphAPI := orphan.apiConn(t)
	refuse2 := orphan.refuseSave(t, orphAPI, "req-b4-orphan", "bearer", "local/x.md",
		orphan.proof(t, userProof{RequestID: "req-b4-orphan", BaseNo: 1, BaseHash: orphan.baseHash,
			ContentHash: hex64("b4-orphan"), Class: "local_only", Bytes: 700}), "", "")
	if refuse2.code != "version_conflict" || refuse2.detail != "0" {
		t.Fatalf("no-published-version base = %q detail %q, want version_conflict/0", refuse2.code, refuse2.detail)
	}
	// A finished Task is read-only.
	mustExec(t, orphan.admin, "UPDATE work.task SET state = 'completed' WHERE id = "+quoteLiteral(orphan.taskID))
	orphan.refuseSave(t, orphAPI, "req-b4-readonly", "bearer", "local/x.md",
		orphan.proof(t, userProof{RequestID: "req-b4-readonly", BaseNo: 1, BaseHash: orphan.baseHash,
			ContentHash: hex64("b4-readonly"), Class: "local_only", Bytes: 700}),
		"artifact_read_only", "P0001")
}

func TestR0bUserSaveClipboardFloorAndSameDeviceSources(t *testing.T) {
	u := newUserSaveFixture(t, "org_b4_user_clip")
	api := u.apiConn(t)

	// Three clipboard sources and then the base. Every one of them is a published version of
	// this artifact, because :875's join reads work.artifact_version and :890's floor is a
	// MAX over the same table.
	//
	// The source shapes are chosen so that each refusal is the clipboard arm (:888/:896) and
	// not an earlier one:
	//   * sourceLocal - same device, local_only. Raises the floor above the base's own value.
	//   * sourceForeign - a real second device row, because the join compares device_id.
	//   * sourceCloud - location 'cloud', whose device_id is NULL, so it fails the same
	//     join the way §7.1 intends rather than by not existing.
	//   * the base itself is location 'local_only' (else :862's content_on_original_device
	//     would refuse every case here) but classification 'remote_excerpt_allowed', which is
	//     what leaves room for a clipboard source to be STRICTER than the base. A base at
	//     local_only would make :872's base-floor arm fire first and the clipboard block
	//     would never be the thing under test.
	sourceLocal := u.seedVersion(t, 2, "local_only", hex64("b4-clip-local"), "local/src/a.md", u.deviceID,
		"local_only", "'{}'::jsonb")
	jwk := `{"kty":"EC","crv":"P-256","x":"` + strings.Repeat("a", 43) +
		`","y":"` + strings.Repeat("b", 43) + `"}`
	foreignID := newUUID(t)
	mustExec(t, u.admin, "INSERT INTO work.device (id, org_id, owner_subject_id, status, device_name, "+
		"platform, public_key_jwk, public_key_thumbprint, auth_plane, auth_epoch) VALUES ("+quoteLiteral(foreignID)+
		", "+quoteLiteral(u.org)+", "+quoteLiteral(u.subject)+", 'active', 'other', 'windows-x64', "+
		quoteLiteral(jwk)+"::jsonb, work.device_key_thumbprint("+quoteLiteral(jwk)+"::jsonb), 'bearer', "+
		u.authEpoch+")")
	sourceForeign := u.seedVersion(t, 3, "local_only", hex64("b4-clip-foreign"), "local/src/b.md", foreignID,
		"local_only", "'{}'::jsonb")
	sourceCloud := u.seedVersion(t, 4, "cloud", hex64("b4-clip-cloud"), "", "", "remote_excerpt_allowed",
		"'{}'::jsonb")
	baseID := u.seedVersion(t, 5, "local_only", hex64("b4-clip-base"), "local/src/base.md", u.deviceID,
		"remote_excerpt_allowed", "'{}'::jsonb")

	baseHash := hex64("b4-clip-base")
	baseNo := 5
	if got := mustScalar(t, u.admin, "SELECT version_no::text || '|' || classification || '|' || location "+
		"FROM work.artifact_version WHERE org_id = "+quoteLiteral(u.org)+" AND version_id = "+quoteLiteral(baseID)); got !=
		"5|remote_excerpt_allowed|local_only" {
		t.Fatalf("fixture base row = %q", got)
	}

	save := func(requestID, class string, clip []string) refusal {
		return u.saveRefused(t, api, requestID, "local/edit/clip.md",
			u.proof(t, userProof{RequestID: requestID, BaseNo: baseNo, BaseHash: baseHash,
				ContentHash: hex64("b4-clip-" + requestID), Class: class, Clipboard: clip, Bytes: 700}))
	}
	// The base is the looser value, so a local_only source has to raise the floor above it:
	// :872's base comparison passes (1 >= 1) and :896's GREATEST(base, clip) is what refuses.
	got := save("req-b4-clip-floor", "remote_excerpt_allowed", []string{sourceLocal})
	if got.code != "classification_floor_required" {
		t.Fatalf("clipboard floor case = %q, want classification_floor_required", got.code)
	}
	// A source on another device is refused on the join, not on the rank - and the claim is
	// the strictest value, so no rank comparison could have refused it.
	if got := save("req-b4-clip-device", "local_only", []string{sourceForeign}); got.code != "classification_floor_required" {
		t.Fatalf("foreign-device source = %q, want classification_floor_required", got.code)
	}
	// A cloud source has no device at all, so §7.1's same-device rule refuses it too.
	if got := save("req-b4-clip-cloud", "local_only", []string{sourceCloud}); got.code != "classification_floor_required" {
		t.Fatalf("cloud source = %q, want classification_floor_required", got.code)
	}
	// A source that does not exist cannot be a clipboard input either: the join's first arm
	// (av.version_id IS NULL) is the total one, and an empty array is legal but a
	// non-parsing element is refused by the validator long before here.
	if got := save("req-b4-clip-missing", "local_only", []string{newUUID(t)}); got.code != "classification_floor_required" {
		t.Fatalf("missing source = %q, want classification_floor_required", got.code)
	}
	// Claiming the strictest value with a same-device source lands: this is the positive
	// control for the four refusals above.
	out := u.save(t, api, "req-b4-clip-ok", "local/edit/clip.md",
		u.proof(t, userProof{RequestID: "req-b4-clip-ok", BaseNo: baseNo, BaseHash: baseHash,
			ContentHash: hex64("b4-clip-ok"), Class: "local_only", Clipboard: []string{sourceLocal}, Bytes: 700}))
	if out["version_no"] != float64(baseNo+1) || out["classification"] != "local_only" {
		t.Fatalf("clipboard positive = %#v", out)
	}
	if got := countRows(t, u.admin, "SELECT count(*) FROM work.artifact_replica WHERE org_id = "+quoteLiteral(u.org)); got != 0 {
		t.Fatalf("replica rows = %d, want 0 on every user-save path", got)
	}
	if got := countRows(t, u.admin, "SELECT count(*) FROM work.consumed_possession_nonce WHERE org_id = "+
		quoteLiteral(u.org)); got != 1 {
		t.Fatalf("nonce rows = %d, want 1 (only the landed save spent one)", got)
	}
}

// ---------------------------------------------------------------------------
// rebind_run_workspace restatement (O-17 = yi)
// ---------------------------------------------------------------------------

func TestR0bRebindConsumesItsNonceOnceAndRollsItBackOnRefusal(t *testing.T) {
	l := newLocalArtifactFixture(t, "org_b4_rebind_nonce")
	api := l.apiConn(t)

	// Two more grants on the fixture grant's root, so the succession edge holds and the
	// rebind can be run twice in a row. register_workspace_grant does not touch its
	// siblings, so all three stay active until a rebind succeeds over one of them.
	register := func(requestID string) string {
		out := callJSON(t, api,
			`SELECT work.register_workspace_grant($1,$2,'bearer',7,$3::uuid,$4::uuid,$5,$6::jsonb)`,
			l.org, l.subject, l.deviceID, l.sessionID, requestID,
			`{"root_identity_hash":"`+strings.Repeat("8", 64)+
				`","allowed_tools":["workspace.read"],"matched_rule_index":0,"user_selected_ttl_seconds":3600}`)
		id, _ := out["grant_id"].(string)
		if id == "" {
			t.Fatalf("grant %s not registered: %#v", requestID, out)
		}
		return id
	}
	second := register("req-b4-rebind-grant2")
	third := register("req-b4-rebind-grant3")
	mustExec(t, l.admin, "UPDATE work.run SET state = 'waiting', wait_reason = 'input' WHERE id = "+quoteLiteral(l.runID))

	rebindSQL := `SELECT work.rebind_run_workspace($1,$2,'bearer',7,$3::uuid,$4,$5::uuid,$6::uuid,$7::jsonb)`
	proof := func(oldGrant, newGrant, nonce, root string) string {
		return `{"old_grant_id":"` + oldGrant + `","new_grant_id":"` + newGrant + `","run_id":"` + l.runID +
			`","root_identity_hash":"` + root + `","session_id":"` + l.sessionID +
			`","auth_plane":"bearer","auth_epoch":7,"nonce":"` + nonce +
			`","signature":"sha256:` + strings.Repeat("e", 64) + `"}`
	}
	nonceRows := func(where string) int {
		return countRows(t, l.admin, "SELECT count(*) FROM work.consumed_possession_nonce WHERE org_id = "+
			quoteLiteral(l.org)+where)
	}
	successions := func() int {
		return countRows(t, l.admin, "SELECT count(*) FROM work.workspace_grant_succession WHERE org_id = "+
			quoteLiteral(l.org))
	}

	// FIRST, a rebind that refuses AFTER the spend, so nothing above it has moved yet: the
	// proof names a root the new grant does not have, and :1117 is three statements past the
	// insert at :1075. The rollback has to take the nonce row with it - that is the property
	// that makes "spend before any business write" safe rather than a one-shot lock on the
	// Run.
	lateNonce := "nonce-b4-rebind-late"
	if got := successions(); got != 0 {
		t.Fatalf("succession rows before any rebind = %d, want 0", got)
	}
	expectRefused(t, api, "workspace_identity_changed", "P0001", rebindSQL,
		l.org, l.subject, l.runID, "req-b4-rebind-1", l.grantID, second,
		proof(l.grantID, second, lateNonce, strings.Repeat("1", 64)))
	if got := nonceRows(" AND nonce = " + quoteLiteral(lateNonce)); got != 0 {
		t.Fatalf("nonce rows for the refused rebind = %d, want 0 (the rollback takes the insert)", got)
	}
	if got := successions(); got != 0 {
		t.Fatalf("succession rows after the refused rebind = %d, want 0", got)
	}

	// The same request with the correct root now lands, which proves the refusal above was
	// the identity check and not the nonce.
	nonce := "nonce-b4-rebind-2"
	first := callJSON(t, api, rebindSQL, l.org, l.subject, l.runID, "req-b4-rebind-2", l.grantID, second,
		proof(l.grantID, second, nonce, strings.Repeat("8", 64)))
	if first["binding_revision"] != float64(2) || first["replayed"] != false {
		t.Fatalf("rebind = %#v", first)
	}
	if got := mustScalar(t, l.admin, "SELECT purpose FROM work.consumed_possession_nonce WHERE org_id = "+
		quoteLiteral(l.org)+" AND nonce = "+quoteLiteral(nonce)); got != "workspace_rebind" {
		t.Fatalf("nonce purpose = %q, want workspace_rebind", got)
	}
	if got := nonceRows(""); got != 1 {
		t.Fatalf("nonce rows = %d, want 1", got)
	}
	if got := successions(); got != 1 {
		t.Fatalf("succession rows = %d, want 1", got)
	}

	// The ordinary retry returns the original answer and never reaches the consumption, which
	// is why the spend sits after the audit-receipt replay branch.
	replay := callJSON(t, api, rebindSQL, l.org, l.subject, l.runID, "req-b4-rebind-2", l.grantID, second,
		proof(l.grantID, second, nonce, strings.Repeat("8", 64)))
	if replay["replayed"] != true || replay["binding_revision"] != float64(2) {
		t.Fatalf("rebind replay = %#v", replay)
	}
	if got := nonceRows(""); got != 1 {
		t.Fatalf("nonce rows after replay = %d, want 1", got)
	}

	// The same proof under a FRESH request id is the replay 0041 accepted - it got as far as
	// a second succession row. Now it is a permission failure, and no second row lands.
	expectRefused(t, api, "unauthorized", "42501", rebindSQL,
		l.org, l.subject, l.runID, "req-b4-rebind-3", l.grantID, second,
		proof(l.grantID, second, nonce, strings.Repeat("8", 64)))
	if got := successions(); got != 1 {
		t.Fatalf("succession rows after the refused replay = %d, want 1", got)
	}

	// A different nonce re-opens the Run: the table spends nonces, not runs. This is also
	// the control that keeps the case above from being read as "rebind is now locked".
	next := callJSON(t, api, rebindSQL, l.org, l.subject, l.runID, "req-b4-rebind-4", second, third,
		proof(second, third, "nonce-b4-rebind-4", strings.Repeat("8", 64)))
	if next["binding_revision"] != float64(3) || next["replayed"] != false {
		t.Fatalf("second rebind = %#v, want binding revision 3", next)
	}
	if got := nonceRows(""); got != 2 {
		t.Fatalf("nonce rows = %d, want 2 (one per landed rebind)", got)
	}
}
