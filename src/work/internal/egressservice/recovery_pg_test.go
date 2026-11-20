package egressservice

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/we-meet/work/internal/authz"
	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/contentref"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/egress"
	"github.com/we-meet/work/internal/testpg"
)

type failingRegistration struct {
	ReferenceResolver
	kind contentref.Kind
}

func (r failingRegistration) Register(ctx context.Context, ref contentref.Reference) error {
	if ref.Kind == r.kind {
		return errors.New("injected registration outage")
	}
	return r.ReferenceResolver.Register(ctx, ref)
}

type lostStageAck struct{ egress.OutputStager }

func (s lostStageAck) Stage(ctx context.Context, org, operation string, m egress.OutputManifest) error {
	if err := s.OutputStager.Stage(ctx, org, operation, m); err != nil {
		return err
	}
	return errors.New("injected lost stage acknowledgement")
}

type failedAttach struct {
	EgressCommands
	committed bool
}

func (c failedAttach) Attach(ctx context.Context, r authz.ReceiptRequest) error {
	if c.committed {
		if err := c.EgressCommands.Attach(ctx, r); err != nil {
			return err
		}
	}
	return errors.New("injected attach outage")
}

func TestOutputRecoveryChild(t *testing.T) {
	if os.Getenv("WORK_RECOVERY_CHILD") != "1" {
		t.Skip("subprocess-only recovery entry")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, os.Getenv("WORK_RECOVERY_DB"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	store, err := content.NewLocal(bytes.Repeat([]byte{0x42}, 32), os.Getenv("WORK_RECOVERY_DIR"), 1)
	if err != nil {
		t.Fatal(err)
	}
	r := egress.OutputRecovery{Pool: pool, Content: store}
	for i := 0; i < 2; i++ {
		if err := r.Restore(ctx, os.Getenv("WORK_RECOVERY_ORG"), os.Getenv("WORK_RECOVERY_OPERATION")); err != nil {
			t.Fatal(err)
		}
	}
}

func runRecoveryProcess(t *testing.T, tenant *pgTenant) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestOutputRecoveryChild$", "-test.v")
	cmd.Env = append(os.Environ(), "WORK_RECOVERY_CHILD=1", "WORK_RECOVERY_DB="+testpg.WorkerURL(pgDBName), "WORK_RECOVERY_DIR="+pgContentDir, "WORK_RECOVERY_ORG="+tenant.org, "WORK_RECOVERY_OPERATION="+tenant.opID)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("recovery process: %v\n%s", err, out)
	}
	if !bytes.Contains(out, []byte("--- PASS: TestOutputRecoveryChild")) {
		t.Fatalf("missing child proof: %s", out)
	}
}

func recoveryManifest(t *testing.T, tenant *pgTenant) egress.OutputManifest {
	t.Helper()
	var body []byte
	if err := pgAdmin.QueryRow(pgContext(t), `SELECT manifest FROM work.egress_output_recovery WHERE org_id=$1 AND operation_id=$2`, tenant.org, tenant.opID).Scan(&body); err != nil {
		t.Fatal(err)
	}
	var m egress.OutputManifest
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

type lostResponse struct {
	http.ResponseWriter
	closed bool
}

func (w *lostResponse) WriteHeader(_ int) {
	if w.closed {
		return
	}
	w.closed = true
	conn, _, err := w.ResponseWriter.(http.Hijacker).Hijack()
	if err == nil {
		_ = conn.Close()
	}
}
func (w *lostResponse) Write(b []byte) (int, error) { w.WriteHeader(200); return len(b), nil }

func TestOutputRecoveryAcrossProcessAfterCommitFailures(t *testing.T) {
	requirePG(t)
	for _, mode := range []string{"answer_registration", "receipt_registration", "stage_ack", "attach_before_commit", "attach_ack", "response_lost"} {
		t.Run(mode, func(t *testing.T) {
			tenant := seedExecuteTenant(t, "org_output_"+mode)
			token, generation := issueEgressCapability(t, tenant)
			var handler http.Handler
			h := newPGHarness(t, func(s *Server) {
				handler = s.Handler()
				switch mode {
				case "answer_registration":
					s.references = failingRegistration{s.references, contentref.KindAnswer}
				case "receipt_registration":
					s.references = failingRegistration{s.references, contentref.KindReceipt}
				case "stage_ack":
					s.outputs = lostStageAck{s.outputs}
				case "attach_before_commit":
					s.commands = failedAttach{s.commands, false}
				case "attach_ack":
					s.commands = failedAttach{s.commands, true}
				}
			})
			if mode == "response_lost" {
				dropped := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handler.ServeHTTP(&lostResponse{ResponseWriter: w}, r) }))
				defer dropped.Close()
				body, _ := json.Marshal(invokeEnvelope{ExecutionID: tenant.execID, RequestRef: referenceEnvelope{RefID: tenant.docRef, Hash: tenant.docHash, Object: true}, RequestHash: tenant.docHash})
				request, err := http.NewRequest(http.MethodPost, dropped.URL+InvokePath, bytes.NewReader(body))
				if err != nil {
					t.Fatal(err)
				}
				request.Header.Set(HeaderAuthorization, "Bearer "+token)
				request.Header.Set(HeaderOrg, tenant.org)
				request.Header.Set(HeaderExecution, tenant.execID)
				request.Header.Set(HeaderGeneration, fmt.Sprint(generation))
				response, err := http.DefaultClient.Do(request)
				if err == nil {
					response.Body.Close()
					t.Fatal("expected lost HTTP response")
				}
			} else {
				response := postInvoke(t, h.server.URL, tenant, token, generation, tenant.docRef, tenant.docHash)
				requireOutcome(t, response, "succeeded")
			}
			m := recoveryManifest(t, tenant)
			if m.AnswerRefID == "" || m.ReceiptLocator == "" {
				t.Fatal("empty durable proof")
			}
			if mode == "answer_registration" || mode == "stage_ack" || mode == "attach_before_commit" || mode == "attach_ack" {
				if _, err := contentref.NewRegistry(pgPool).Resolve(pgContext(t), tenant.org, m.AnswerRefID); !errors.Is(err, contentref.ErrNotFound) {
					t.Fatalf("missing answer precondition: %v", err)
				}
			}
			if mode == "stage_ack" || mode == "attach_before_commit" {
				state, _, _, _ := gateFacts(t, tenant.org, tenant.opID)
				if state != "consumed" {
					t.Fatalf("expected unattached gate, got %s", state)
				}
				for _, locator := range []string{m.AnswerLocator, m.ReceiptLocator} {
					u, err := url.Parse(locator)
					if err != nil {
						t.Fatal(err)
					}
					parts := strings.Split(strings.Trim(u.Path, "/"), "/")
					id := parts[len(parts)-1]
					var n int
					if err := workdb.WithWorkerOrgContext(pgContext(t), pgPool, tenant.org, func(tx pgx.Tx) error {
						return tx.QueryRow(pgContext(t), `SELECT count(*) FROM work.list_content_refs($1) id WHERE id=$2`, tenant.org, id).Scan(&n)
					}); err != nil || n != 1 {
						t.Fatalf("stage-only inventory count=%d err=%v", n, err)
					}
				}
			}
			h.server.Close()
			runRecoveryProcess(t, tenant)
			r := egress.OutputRecovery{Pool: pgPool, Content: pgContent}
			var wg sync.WaitGroup
			results := make(chan error, 2)
			for i := 0; i < 2; i++ {
				wg.Add(1)
				go func() { defer wg.Done(); results <- r.Restore(context.Background(), tenant.org, tenant.opID) }()
			}
			wg.Wait()
			close(results)
			for err := range results {
				if err != nil {
					t.Fatal(err)
				}
			}
			answer, err := contentref.NewRegistry(pgPool).Resolve(pgContext(t), tenant.org, m.AnswerRefID)
			if err != nil {
				t.Fatal(err)
			}
			body, err := pgContent.Get(pgContext(t), tenant.org, answer.ContentRef)
			if err != nil || !bytes.Equal(body, egressSuccess().Answer) {
				t.Fatalf("restored answer: %v", err)
			}
			state, slot, _, hash := gateFacts(t, tenant.org, tenant.opID)
			if state != "receipt_recorded" || slot != m.ReceiptSlotID || hash != m.ReceiptHash {
				t.Fatal("gate proof mismatch")
			}
			var count int
			if err := pgAdmin.QueryRow(pgContext(t), `SELECT count(*) FROM work.content_reference WHERE org_id=$1 AND execution_id=$2 AND kind IN ('answer','receipt')`, tenant.org, tenant.execID).Scan(&count); err != nil || count != 2 {
				t.Fatalf("reference count=%d err=%v", count, err)
			}
			if h.provider.calls != 1 {
				t.Fatalf("provider calls=%d", h.provider.calls)
			}
		})
	}
}

func TestOutputRecoveryRefusesTamperingAndTombstones(t *testing.T) {
	requirePG(t)
	tenant := seedExecuteTenant(t, "org_output_reject")
	token, generation := issueEgressCapability(t, tenant)
	h := newPGHarness(t)
	requireOutcome(t, postInvoke(t, h.server.URL, tenant, token, generation, tenant.docRef, tenant.docHash), "succeeded")
	m := recoveryManifest(t, tenant)
	for _, key := range []string{"execution_id", "attempt_id", "request_hash", "gateway_invocation_id", "writer_gateway_id", "receipt_slot_id", "answer_ref_id", "answer_locator", "answer_hash", "answer_bytes", "receipt_locator", "receipt_hash", "receipt_body_hash", "receipt_bytes", "logical_key"} {
		t.Run(key, func(t *testing.T) {
			raw, _ := json.Marshal(m)
			var doc map[string]any
			json.Unmarshal(raw, &doc)
			switch key {
			case "answer_bytes", "receipt_bytes":
				doc[key] = doc[key].(float64) + 1
			case "execution_id", "attempt_id", "writer_gateway_id", "receipt_slot_id", "answer_ref_id":
				doc[key] = pgUUID(t)
			case "request_hash", "answer_hash", "receipt_hash", "receipt_body_hash":
				doc[key] = "sha256:" + fmt.Sprintf("%064d", 0)
			default:
				doc[key] = doc[key].(string) + "x"
			}
			raw, _ = json.Marshal(doc)
			err := workdb.WithWorkerOrgContext(pgContext(t), pgPool, tenant.org, func(tx pgx.Tx) error {
				_, err := tx.Exec(pgContext(t), `SELECT work.stage_egress_output($1,$2,$3::jsonb)`, tenant.org, tenant.opID, raw)
				return err
			})
			var pe *pgconn.PgError
			if !errors.As(err, &pe) || (pe.Code != "P0001" && pe.Code != "22023") {
				t.Fatalf("expected binding/conflict refusal, got %v", err)
			}
		})
	}
	var foreignCount int
	if err := workdb.WithWorkerOrgContext(pgContext(t), pgPool, "foreign_org", func(tx pgx.Tx) error {
		return tx.QueryRow(pgContext(t), `SELECT count(*) FROM work.egress_output_recovery WHERE operation_id=$1`, tenant.opID).Scan(&foreignCount)
	}); err != nil || foreignCount != 0 {
		t.Fatalf("RLS leaked %d: %v", foreignCount, err)
	}
	changed, err := contentref.NewRegistry(pgPool).Tombstone(pgContext(t), tenant.org, m.AnswerRefID, "retention_expired")
	if err != nil || !changed {
		t.Fatalf("tombstone: %v", err)
	}
	r := egress.OutputRecovery{Pool: pgPool, Content: pgContent}
	if err := r.Restore(pgContext(t), tenant.org, tenant.opID); !errors.Is(err, egress.ErrOutputRecoveryInvalid) {
		t.Fatalf("tombstone restored: %v", err)
	}
	if _, err := contentref.NewRegistry(pgPool).Resolve(pgContext(t), tenant.org, m.AnswerRefID); !errors.Is(err, contentref.ErrNotFound) {
		t.Fatal("tombstone resurrected")
	}
	var selectAllowed, writeAllowed, publicExecute bool
	if err := pgAdmin.QueryRow(pgContext(t), `SELECT has_table_privilege('work_worker','work.egress_output_recovery','SELECT'), has_table_privilege('work_worker','work.egress_output_recovery','INSERT,UPDATE,DELETE'), EXISTS(SELECT 1 FROM pg_proc p,LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='work.stage_egress_output(text,uuid,jsonb)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE')`).Scan(&selectAllowed, &writeAllowed, &publicExecute); err != nil || !selectAllowed || writeAllowed || publicExecute {
		t.Fatalf("ACL select=%t write=%t public=%t err=%v", selectAllowed, writeAllowed, publicExecute, err)
	}
}
