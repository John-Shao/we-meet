package api_test

import (
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"
)

// artifact_versions.go:23 states the rule in prose: max_artifact_bytes "counts characters, so the
// handler checks runes and the stored bytes may be larger for a non-ASCII text", and the 2 MiB
// transport ceiling is deliberately a separate number because one JSON escape can turn a character
// into six bytes. Every size case written so far is a refusal ("oversized content" is 262145 runes,
// which is refused under either reading), so the accepted side of that promise is unproven: switch
// the handler to a byte count and the whole suite stays green while a 2000-page Chinese artifact
// starts failing for real users - the same byte/character confusion the input limits were just
// pinned on, in the opposite direction.
//
// This publishes a version whose content is exactly at the character limit and is 3x larger in
// bytes, then one character over it, and reads the advertised number off /work/v1/bootstrap rather
// than repeating the constant.

const avSizeArtifact = "00000000-0000-4000-8000-0000000000f1"

func TestArtifactVersionContentLimitCountsCharactersNotBytes(t *testing.T) {
	pool, dbName := newBootstrapDB(t, true, true)
	seedTaskGraph(t, dbName)
	store := newTestContentStore(t)
	avSeedArtifact(t, dbName, avEditableTaskID, avSizeArtifact, store, "# 第一版")
	server := newHTTPServerWithContent(t, pool, store)
	token := bootstrapCSRF(t, server.URL)

	maxChars, _, artifactLimit := advertisedInputLimits(t, server.URL)
	// All three ceilings come off /work/v1/bootstrap rather than from constants in this file, so
	// a change on either face shows up as a refusal of a body the app still advertises as legal.
	if artifactLimit <= maxChars {
		t.Fatalf("advertised max_artifact_bytes = %d but max_goal_chars = %d; the fixture below "+
			"assumes the artifact ceiling is the larger one, so this test would be proving nothing",
			artifactLimit, maxChars)
	}

	char := "字" // three bytes in UTF-8
	atLimit := strings.Repeat(char, artifactLimit)
	overLimit := strings.Repeat(char, artifactLimit+1)
	if utf8.RuneCountInString(atLimit) != artifactLimit || len(atLimit) != 3*artifactLimit {
		t.Fatalf("fixture is not what the test claims: runes=%d bytes=%d, want %d runes at 3 bytes",
			utf8.RuneCountInString(atLimit), len(atLimit), artifactLimit)
	}

	publish := func(requestID, content string) *http.Response {
		return taskRequest(t, http.MethodPost, avVersionsURL(server.URL, avSizeArtifact), token,
			avBody(requestID, 1, content))
	}

	accepted := publish("avsize-ok-000000001", atLimit)
	if accepted.StatusCode != http.StatusCreated {
		body := readBody(accepted)
		accepted.Body.Close()
		t.Fatalf("a content of exactly %d characters (%d UTF-8 bytes) was refused: %s. The doc "+
			"promise is that the limit counts characters; if it is ever changed to bytes this line "+
			"is where a Chinese artifact starts failing", artifactLimit, len(atLimit), body)
	}
	accepted.Body.Close()
	if got := avVersionCount(t, dbName, avSizeArtifact); got != 2 {
		t.Fatalf("version rows = %d, want 2: the accepted publication must actually be stored", got)
	}

	refused := publish("avsize-over-0000001", overLimit)
	assertAPICode(t, refused, http.StatusBadRequest, "invalid_request")
	if got := avVersionCount(t, dbName, avSizeArtifact); got != 2 {
		t.Fatalf("version rows = %d, want 2: the refused publication must not have been stored", got)
	}
	t.Logf("artifact limit as advertised: %d characters; accepted %d UTF-8 bytes, refused %d at %d "+
		"characters", artifactLimit, len(atLimit), len(overLimit), artifactLimit+1)
}
