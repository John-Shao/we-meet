package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type strictTarget struct {
	Reason string `json:"reason"`
}

// TestDecodeStrictJSONRejectsTrailingContent covers both entry points. previews.go
// had the trailing check but inverted its condition, so a body of two concatenated
// objects decoded as the first one alone and the rest was dropped silently.
func TestDecodeStrictJSONRejectsTrailingContent(t *testing.T) {
	cases := []struct {
		name      string
		body      string
		wantError bool
	}{
		{"single object", `{"reason":"切换供应商"}`, false},
		{"trailing empty object", `{"reason":"切换供应商"} {}`, true},
		{"trailing full object", `{"reason":"一"} {"reason":"二"}`, true},
		{"trailing array", `{"reason":"一"} [1,2]`, true},
		{"trailing garbage", `{"reason":"一"} nope`, true},
		{"trailing whitespace only", `{"reason":"切换供应商"}   `, false},
		{"empty body", ``, true},
		{"unknown member", `{"reason":"一","org_id":"org_a"}`, true},
	}
	for _, item := range cases {
		var target strictTarget
		err := decodeStrictJSONBody(strings.NewReader(item.body), &target)
		if item.wantError && err == nil {
			t.Errorf("%s: decodeStrictJSONBody accepted the body", item.name)
		}
		if !item.wantError && err != nil {
			t.Errorf("%s: decodeStrictJSONBody rejected a valid body: %v", item.name, err)
		}

		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/work/v1/task-previews", strings.NewReader(item.body))
		err = decodeStrictJSON(recorder, request, &strictTarget{})
		if item.wantError && err == nil {
			t.Errorf("%s: decodeStrictJSON (previews path) accepted the body", item.name)
		}
		if !item.wantError && err != nil {
			t.Errorf("%s: decodeStrictJSON rejected a valid body: %v", item.name, err)
		}
	}
}

// TestDecodeStrictJSONKeepsSizeCap pins that the previews entry point still bounds the
// body, which the shared helper deliberately does not impose on other endpoints.
func TestDecodeStrictJSONKeepsSizeCap(t *testing.T) {
	oversized := `{"reason":"` + strings.Repeat("a", (64<<10)+1) + `"}`
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/work/v1/task-previews", strings.NewReader(oversized))
	if err := decodeStrictJSON(recorder, request, &strictTarget{}); err == nil {
		t.Fatal("the 64 KiB body cap no longer rejects an oversized preview request")
	}

	var target strictTarget
	if err := decodeStrictJSONBody(strings.NewReader(oversized), &target); err != nil {
		t.Fatalf("decodeStrictJSONBody must not impose the previews size cap: %v", err)
	}
	if target.Reason == "" {
		t.Fatal("shared helper decoded nothing")
	}
}

// TestDecodeStrictJSONBodyIsTheSingleSpelling guards the drift that let the two
// spellings diverge: previews.go's inverted condition accepted trailing content, so
// every write path has to reach the helper that requires io.EOF.
func TestDecodeStrictJSONBodyIsTheSingleSpelling(t *testing.T) {
	if err := decodeStrictJSONBody(strings.NewReader(`{"reason":"一"} {}`), &strictTarget{}); err == nil {
		t.Fatal("decodeStrictJSONBody accepted trailing content")
	}
	if err := decodeStrictJSONBody(strings.NewReader(`{"reason":"一"}`), &strictTarget{}); err != nil {
		t.Fatalf("decodeStrictJSONBody rejected a lone object: %v", err)
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/work/v1/task-previews",
		strings.NewReader(`{"reason":"一"} {}`))
	if err := decodeStrictJSON(recorder, request, &strictTarget{}); err == nil {
		t.Fatal("decodeStrictJSON accepted trailing content on the previews path")
	}
}
