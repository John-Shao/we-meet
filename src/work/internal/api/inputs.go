package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	"github.com/we-meet/work/internal/content"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/host"
)

const (
	InputsPath   = "/work/v1/inputs"
	maxInputBody = 64 << 10
	maxGoalRunes = 2000
	maxBgRunes   = 4000
	maxInputJSON = 64 << 10
)

type inputRequest struct {
	ClientRequestID string `json:"client_request_id"`
	Goal            string `json:"goal"`
	Background      string `json:"background"`
}

type inputResponse struct {
	InputRef    string    `json:"input_ref"`
	ContentHash string    `json:"content_hash"`
	Bytes       int64     `json:"bytes"`
	ExpiresAt   time.Time `json:"expires_at"`
	storedRef   string
}

func (s *Server) createInput(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if !s.verifyCSRF(w, r, claims, correlationID) {
		return
	}
	if s.content == nil {
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	if err := s.requireWriter(r.Context(), claims); err != nil {
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
	body, err := readInputBody(w, r)
	if err != nil {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	plaintext, err := json.Marshal(map[string]string{"goal": body.Goal, "background": body.Background})
	if err != nil || len(plaintext) > maxInputJSON {
		writeAPIError(w, correlationID, apierr.New("invalid_request"))
		return
	}
	ref, err := s.content.Put(r.Context(), claims.OrgID, plaintext)
	if err != nil {
		s.logger.Printf("work api content put failure correlation_id=%s", correlationID)
		writeAPIError(w, correlationID, apierr.New("service_degraded"))
		return
	}
	response, err := s.persistInput(r.Context(), claims, body.ClientRequestID, ref)
	if err != nil {
		_ = s.content.Delete(r.Context(), claims.OrgID, ref.ContentRef)
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
	if response.storedRef != ref.ContentRef {
		_ = s.content.Delete(r.Context(), claims.OrgID, ref.ContentRef)
	}
	writeJSON(w, http.StatusCreated, response)
}

func readInputBody(w http.ResponseWriter, r *http.Request) (inputRequest, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxInputBody)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var body inputRequest
	if err := decoder.Decode(&body); err != nil {
		return inputRequest{}, err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return inputRequest{}, fmt.Errorf("trailing JSON")
	}
	if len(body.ClientRequestID) < 8 || len(body.ClientRequestID) > 128 ||
		strings.TrimSpace(body.ClientRequestID) != body.ClientRequestID {
		return inputRequest{}, fmt.Errorf("invalid client_request_id")
	}
	if body.Goal == "" || utf8.RuneCountInString(body.Goal) > maxGoalRunes ||
		utf8.RuneCountInString(body.Background) > maxBgRunes ||
		strings.ContainsRune(body.Goal, '\x00') || strings.ContainsRune(body.Background, '\x00') {
		return inputRequest{}, fmt.Errorf("invalid input text")
	}
	return body, nil
}

func (s *Server) persistInput(
	ctx context.Context,
	claims host.Claims,
	clientRequestID string,
	ref content.Ref,
) (inputResponse, error) {
	var response inputResponse
	err := workdb.WithWorkContext(ctx, s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI,
		workdb.Options{},
		func(tx pgx.Tx) error {
			var inputID string
			if err := tx.QueryRow(ctx, `SELECT work.create_input_idempotent($1,$2,$3,$4,$5,$6,$7)`,
				claims.OrgID, claims.SubjectID, clientRequestID,
				ref.ContentRef, ref.Hash, ref.Bytes, "application/json",
			).Scan(&inputID); err != nil {
				return err
			}
			var contentRef string
			var contentHash string
			var bytes int64
			var expiresAt *time.Time
			if err := tx.QueryRow(ctx, `
				SELECT content_ref, content_hash, bytes, expires_at
				FROM work.input_object
				WHERE id = $1 AND org_id = $2 AND subject_id = $3`,
				inputID, claims.OrgID, claims.SubjectID,
			).Scan(&contentRef, &contentHash, &bytes, &expiresAt); err != nil {
				return err
			}
			if contentHash != ref.Hash || bytes != ref.Bytes {
				return fmt.Errorf("input replay does not match stored content")
			}
			if expiresAt == nil {
				return fmt.Errorf("input expiration missing")
			}
			response = inputResponse{
				InputRef:    inputID,
				ContentHash: contentHash,
				Bytes:       bytes,
				ExpiresAt:   *expiresAt,
				storedRef:   contentRef,
			}
			return nil
		},
	)
	return response, err
}
