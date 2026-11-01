package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/we-meet/work/internal/apierr"
	workdb "github.com/we-meet/work/internal/db"
)

const (
	MeUsagePath    = "/work/v1/me/usage"
	AdminUsagePath = "/work/v1/admin/usage"

	maxUsageSpanDays = 366
)

type usageRow struct {
	Provider          string `json:"provider"`
	Model             string `json:"model"`
	UsageDate         string `json:"usage_date"`
	InputTokens       int64  `json:"input_tokens"`
	OutputTokens      int64  `json:"output_tokens"`
	CachedInputTokens int64  `json:"cached_input_tokens"`
	RunCount          int64  `json:"run_count"`
}

type orgUsageRow struct {
	Provider          string `json:"provider"`
	Model             string `json:"model"`
	InputTokens       int64  `json:"input_tokens"`
	OutputTokens      int64  `json:"output_tokens"`
	CachedInputTokens int64  `json:"cached_input_tokens"`
	RunCount          int64  `json:"run_count"`
}

const usageNote = "仅供参考：Work 只统计 token 事实，费用以客户云厂商账单为准。"

func parseUsageRange(r *http.Request) (time.Time, time.Time, *apierr.Error) {
	query := r.URL.Query()
	fromValue := strings.TrimSpace(query.Get("from"))
	toValue := strings.TrimSpace(query.Get("to"))
	if fromValue == "" || toValue == "" {
		return time.Time{}, time.Time{}, apierr.New("invalid_request")
	}
	from, err := time.Parse("2006-01-02", fromValue)
	if err != nil {
		return time.Time{}, time.Time{}, apierr.New("invalid_request")
	}
	to, err := time.Parse("2006-01-02", toValue)
	if err != nil {
		return time.Time{}, time.Time{}, apierr.New("invalid_request")
	}
	if to.Before(from) || to.Sub(from) > time.Duration(maxUsageSpanDays)*24*time.Hour {
		return time.Time{}, time.Time{}, apierr.New("invalid_request")
	}
	return from, to, nil
}

func (s *Server) meUsage(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	from, to, invalid := parseUsageRange(r)
	if invalid != nil {
		writeAPIError(w, correlationID, invalid)
		return
	}
	items := []usageRow{}
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			rows, err := tx.Query(r.Context(), `
				SELECT provider, model, usage_date, input_tokens, output_tokens,
				       cached_input_tokens, run_count
				FROM work.get_user_usage($1, $2, $3, $4)`,
				claims.OrgID, claims.SubjectID, from, to,
			)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var (
					item      usageRow
					usageDate time.Time
				)
				if err := rows.Scan(&item.Provider, &item.Model, &usageDate,
					&item.InputTokens, &item.OutputTokens,
					&item.CachedInputTokens, &item.RunCount); err != nil {
					return err
				}
				item.UsageDate = usageDate.Format("2006-01-02")
				items = append(items, item)
			}
			return rows.Err()
		},
	)
	if err != nil {
		s.writeAdminError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"from":  from.Format("2006-01-02"),
		"to":    to.Format("2006-01-02"),
		"note":  usageNote,
		"items": items,
	})
}

func (s *Server) adminUsage(w http.ResponseWriter, r *http.Request) {
	claims, correlationID, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	from, to, invalid := parseUsageRange(r)
	if invalid != nil {
		writeAPIError(w, correlationID, invalid)
		return
	}
	items := []orgUsageRow{}
	err := workdb.WithWorkContext(r.Context(), s.pool,
		workdb.Identity{OrgID: claims.OrgID, SubjectID: claims.SubjectID},
		workdb.RoleAPI, workdb.Options{},
		func(tx pgx.Tx) error {
			rows, err := tx.Query(r.Context(), `
				SELECT provider, model, input_tokens, output_tokens,
				       cached_input_tokens, run_count
				FROM work.get_org_usage_by_model($1, $2, $3, $4)`,
				claims.OrgID, claims.SubjectID, from, to,
			)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var item orgUsageRow
				if err := rows.Scan(&item.Provider, &item.Model,
					&item.InputTokens, &item.OutputTokens,
					&item.CachedInputTokens, &item.RunCount); err != nil {
					return err
				}
				items = append(items, item)
			}
			return rows.Err()
		},
	)
	if err != nil {
		s.writeAdminError(w, correlationID, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"from":  from.Format("2006-01-02"),
		"to":    to.Format("2006-01-02"),
		"note":  usageNote,
		"items": items,
	})
}
