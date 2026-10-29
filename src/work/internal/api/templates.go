package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
)

const TemplatesPath = "/work/v1/templates"

type Template struct {
	ID          string   `json:"id"`
	Version     int      `json:"version"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Sections    []string `json:"sections"`
	ContentHash string   `json:"content_hash"`
}

var builtinTemplates = []Template{
	{
		ID: "summary", Version: 1, Name: "总结",
		Description: "提炼目标与背景，形成简洁结论",
		Sections:    []string{"goal", "background"},
	},
	{
		ID: "analysis", Version: 1, Name: "分析",
		Description: "拆解问题、约束与可选路径",
		Sections:    []string{"goal", "background"},
	},
	{
		ID: "draft", Version: 1, Name: "起草",
		Description: "基于目标和背景产出可编辑初稿",
		Sections:    []string{"goal", "background"},
	},
}

func init() {
	for i := range builtinTemplates {
		body, _ := json.Marshal(struct {
			ID          string   `json:"id"`
			Version     int      `json:"version"`
			Name        string   `json:"name"`
			Description string   `json:"description"`
			Sections    []string `json:"sections"`
		}{builtinTemplates[i].ID, builtinTemplates[i].Version, builtinTemplates[i].Name,
			builtinTemplates[i].Description, builtinTemplates[i].Sections})
		digest := sha256.Sum256(body)
		builtinTemplates[i].ContentHash = "sha256:" + hex.EncodeToString(digest[:])
	}
}

func templateByID(id string) (Template, bool) {
	for _, template := range builtinTemplates {
		if template.ID == id {
			return template, true
		}
	}
	return Template{}, false
}

func (s *Server) listTemplates(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := s.authenticate(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": builtinTemplates})
}
