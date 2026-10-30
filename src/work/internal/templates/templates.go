// Package templates holds the frozen builtin task templates shared by the API
// and the worker. The API lists them; the worker materialises the same bytes
// for an execution-bound template reference, so both sides must compute the
// same content hash.
package templates

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/we-meet/work/internal/execbinding"
)

type Template struct {
	ID          string   `json:"id"`
	Version     int      `json:"version"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Sections    []string `json:"sections"`
	ContentHash string   `json:"content_hash"`
}

var builtin = []Template{
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
	for i := range builtin {
		body, _ := json.Marshal(struct {
			ID          string   `json:"id"`
			Version     int      `json:"version"`
			Name        string   `json:"name"`
			Description string   `json:"description"`
			Sections    []string `json:"sections"`
		}{builtin[i].ID, builtin[i].Version, builtin[i].Name,
			builtin[i].Description, builtin[i].Sections})
		digest := sha256.Sum256(body)
		builtin[i].ContentHash = "sha256:" + hex.EncodeToString(digest[:])
	}
}

// Builtin returns the frozen template list. Callers must not mutate it.
func Builtin() []Template { return builtin }

// ByID returns one template by id.
func ByID(id string) (Template, bool) {
	for _, template := range builtin {
		if template.ID == id {
			return template, true
		}
	}
	return Template{}, false
}

// Source implements execbinding.TemplateSource for the builtin assets.
type Source struct{}

var _ execbinding.TemplateSource = Source{}

// Lookup returns the stored template bytes and their sha256 digest.
func (Source) Lookup(id string, version int) ([]byte, string, bool) {
	template, ok := ByID(id)
	if !ok || template.Version != version {
		return nil, "", false
	}
	body, err := json.Marshal(struct {
		ID          string   `json:"id"`
		Version     int      `json:"version"`
		Name        string   `json:"name"`
		Description string   `json:"description"`
		Sections    []string `json:"sections"`
	}{template.ID, template.Version, template.Name,
		template.Description, template.Sections})
	if err != nil {
		return nil, "", false
	}
	digest := sha256.Sum256(body)
	return body, "sha256:" + hex.EncodeToString(digest[:]), true
}
