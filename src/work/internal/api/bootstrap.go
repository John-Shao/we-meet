package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/we-meet/work/internal/apierr"
	"github.com/we-meet/work/internal/content"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/host"
)

const (
	BootstrapPath = "/work/v1/bootstrap"

	permissionCreate = "work.task.create"
	permissionRead   = "work.artifact.read"
)

type BootstrapOrg struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Role     string `json:"role"`
	WorkSeat bool   `json:"work_seat"`
}

type Target struct {
	Kind    string `json:"kind"`
	Profile string `json:"profile"`
}

type Limits struct {
	MaxGoalChars       int `json:"max_goal_chars"`
	MaxBackgroundChars int `json:"max_background_chars"`
	MaxArtifactBytes   int `json:"max_artifact_bytes"`
	MaxActiveRuns      int `json:"max_active_runs"`
}

type BootstrapResponse struct {
	SubjectID              string       `json:"subject_id"`
	Org                    BootstrapOrg `json:"org"`
	Permissions            []string     `json:"permissions"`
	Phases                 []string     `json:"phases"`
	ExecutionTargets       []Target     `json:"execution_targets"`
	AllowedPermissionModes []string     `json:"allowed_permission_modes"`
	Limits                 Limits       `json:"limits"`
	CSRFToken              string       `json:"csrf_token"`
}

type bootstrapProjection struct {
	OrgName           string
	Role              string
	WorkSeat          bool
	AllowAutoReadonly bool
}

type domainError struct {
	code string
}

func (e *domainError) Error() string { return e.code }

type Server struct {
	pool           *pgxpool.Pool
	verifier       host.SessionVerifier
	csrf           *CSRF
	content        content.Store
	logger         *log.Logger
	runtimeVersion string
}

// SetRuntimeVersion records the deployment's real execution body on every
// submitted Run. The submitted value is what the runtime parent compares with
// its own WORK_RUNTIME_VERSION, so an unset value would make every execution
// fail closed.
func (s *Server) SetRuntimeVersion(version string) {
	if value := strings.TrimSpace(version); value != "" {
		s.runtimeVersion = value
	}
}

func (s *Server) executionRuntimeVersion() string {
	if s.runtimeVersion != "" {
		return s.runtimeVersion
	}
	return "r0a"
}

func NewServer(pool *pgxpool.Pool, verifier host.SessionVerifier, csrf *CSRF, logger *log.Logger) (*Server, error) {
	return NewServerWithContent(pool, verifier, csrf, nil, logger)
}

func NewServerWithContent(
	pool *pgxpool.Pool,
	verifier host.SessionVerifier,
	csrf *CSRF,
	store content.Store,
	logger *log.Logger,
) (*Server, error) {
	if pool == nil || verifier == nil || csrf == nil {
		return nil, errors.New("work api requires pool, Host verifier and CSRF")
	}
	if logger == nil {
		logger = log.Default()
	}
	return &Server{pool: pool, verifier: verifier, csrf: csrf, content: store, logger: logger}, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET "+BootstrapPath, s.bootstrap)
	mux.HandleFunc("GET "+TasksPath, s.listTasks)
	mux.HandleFunc("GET "+TaskPath, s.getTask)
	mux.HandleFunc("PATCH "+TaskPath, s.updateTask)
	mux.HandleFunc("POST "+TaskAcceptancesPath, s.createAcceptance)
	mux.HandleFunc("GET "+TaskEventsPath, s.streamTaskEvents)
	mux.HandleFunc("GET "+ArtifactVersionPath, s.getArtifactVersion)
	mux.HandleFunc("GET "+ArtifactContentPath, s.getArtifactContent)
	mux.HandleFunc("GET "+TaskArtifactPath, s.getTaskArtifact)
	mux.HandleFunc("GET "+TaskArtifactVersionPath, s.getTaskArtifactVersion)
	mux.HandleFunc("GET "+TaskArtifactContentPath, s.getTaskArtifactContent)
	mux.HandleFunc("GET "+RunPath, s.getRun)
	mux.HandleFunc("POST "+RunCancelPath, s.cancelRun)
	mux.HandleFunc("POST "+InputsPath, s.createInput)
	mux.HandleFunc("GET "+TemplatesPath, s.listTemplates)
	mux.HandleFunc("POST "+TaskPreviewsPath, s.createPreview)
	mux.HandleFunc("POST "+TasksPath, s.createTask)
	mux.HandleFunc("GET "+AdminOverviewPath, s.adminOverview)
	mux.HandleFunc("GET "+AdminSeatsPath, s.adminSeats)
	mux.HandleFunc("POST "+AdminAuditExportsPath, s.createAdminAuditExport)
	mux.HandleFunc("GET "+AdminAuditExportPath, s.getAdminAuditExport)
	mux.HandleFunc("POST "+AdminAuditExportTicketPath, s.issueAdminAuditExportTicket)
	mux.HandleFunc("GET "+AdminAuditExportContentPath, s.downloadAdminAuditExport)
	return mux
}

func (s *Server) bootstrap(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}

	view, err := s.loadBootstrap(r.Context(), claims)
	if err != nil {
		var domain *domainError
		if errors.As(err, &domain) {
			writeAPIError(w, correlationID, apierr.New(domain.code))
			return
		}
		apiError := apierr.FromDB(err)
		s.logInternal(correlationID, apiError)
		writeAPIError(w, correlationID, apiError)
		return
	}

	token, err := s.csrf.Issue(claims.SubjectID, claims.OrgID, claims.SessionRevision)
	if err != nil {
		s.logger.Printf("work api csrf issue failure correlation_id=%s", correlationID)
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	http.SetCookie(w, s.csrf.SetCookie(token))

	modes := []string{"ask_each"}
	if view.AllowAutoReadonly {
		modes = append(modes, "auto_readonly")
	}
	writeJSON(w, http.StatusOK, BootstrapResponse{
		SubjectID: claims.SubjectID,
		Org: BootstrapOrg{
			ID:       claims.OrgID,
			Name:     view.OrgName,
			Role:     view.Role,
			WorkSeat: view.WorkSeat,
		},
		Permissions:            []string{permissionCreate, permissionRead},
		Phases:                 []string{"R0a"},
		ExecutionTargets:       []Target{{Kind: "cloud", Profile: "text-v1"}},
		AllowedPermissionModes: modes,
		Limits: Limits{
			MaxGoalChars:       2000,
			MaxBackgroundChars: 4000,
			MaxArtifactBytes:   262144,
			MaxActiveRuns:      1,
		},
		CSRFToken: token,
	})
}

func (s *Server) loadBootstrap(ctx context.Context, claims host.Claims) (bootstrapProjection, error) {
	var view bootstrapProjection
	err := workdb.WithWorkContext(ctx, s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI,
		workdb.Options{ReadOnly: true},
		func(tx pgx.Tx) error {
			var status string
			err := tx.QueryRow(ctx,
				`SELECT role, work_seat, status
				 FROM work.member
				 WHERE org_id = $1 AND subject_id = $2`,
				claims.OrgID, claims.SubjectID,
			).Scan(&view.Role, &view.WorkSeat, &status)
			if errors.Is(err, pgx.ErrNoRows) || (err == nil && (status != "active" || !view.WorkSeat)) {
				return &domainError{code: "work_seat_required"}
			}
			if err != nil {
				return err
			}

			var orgName *string
			if err := tx.QueryRow(ctx,
				`SELECT name FROM work.org WHERE id = $1`,
				claims.OrgID,
			).Scan(&orgName); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return &domainError{code: "work_seat_required"}
				}
				return err
			}
			if orgName != nil {
				view.OrgName = *orgName
			}

			err = tx.QueryRow(ctx,
				`SELECT allow_auto_readonly FROM work.org_policy WHERE org_id = $1`,
				claims.OrgID,
			).Scan(&view.AllowAutoReadonly)
			if errors.Is(err, pgx.ErrNoRows) {
				view.AllowAutoReadonly = false
				return nil
			}
			return err
		},
	)
	if err != nil {
		return bootstrapProjection{}, err
	}
	return view, nil
}

func hostFailure(err error) *apierr.Error {
	var hostErr *host.Error
	if errors.As(err, &hostErr) {
		switch hostErr.Code {
		case "session_invalid", "session_stale":
			return apierr.New("unauthorized")
		}
	}
	return apierr.New("service_degraded")
}

func writeAPIError(w http.ResponseWriter, correlationID string, err *apierr.Error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(err.Status)
	_ = json.NewEncoder(w).Encode(err.Payload(correlationID))
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func sessionCookie(r *http.Request) (string, bool) {
	var values []string
	for _, cookie := range r.Cookies() {
		if cookie.Name == host.SessionCookieName {
			values = append(values, cookie.Value)
		}
	}
	if len(values) != 1 || strings.TrimSpace(values[0]) == "" {
		return "", false
	}
	return values[0], true
}

func newCorrelationID() string {
	var body [16]byte
	if _, err := rand.Read(body[:]); err != nil {
		return "correlation-unavailable"
	}
	return hex.EncodeToString(body[:])
}

func (s *Server) logInternal(correlationID string, err *apierr.Error) {
	s.logger.Printf(
		"work api error correlation_id=%s code=%s internal=%s sqlstate=%s",
		correlationID, err.Code, err.InternalCode, err.SQLState,
	)
}
