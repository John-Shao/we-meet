package api

import (
	"net/http"

	"github.com/we-meet/work/internal/templates"
)

const TemplatesPath = "/work/v1/templates"

type Template = templates.Template

var builtinTemplates = templates.Builtin()

func templateByID(id string) (Template, bool) {
	return templates.ByID(id)
}

func (s *Server) listTemplates(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := s.authenticate(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": builtinTemplates})
}
