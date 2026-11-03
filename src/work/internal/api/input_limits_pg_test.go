package api_test

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/we-meet/work/internal/host"
)

// /work/v1/bootstrap advertises max_goal_chars and max_background_chars, and the input handler
// enforces them with utf8.RuneCountInString (inputs.go:140). Nothing tied the two faces together,
// and the one boundary test that exists sends ASCII, where bytes and runes are the same number, so
// a switch to a byte count would not be noticed. For a product whose primary input is Chinese that
// is the wrong kind of silent: three bytes per character puts a 2000-character goal at 6000 bytes,
// comfortably inside the 64 KiB transport cap, and a byte check would refuse input that the app
// itself advertised as legal.
//
// The limits are therefore read from the bootstrap response rather than written down again, and
// each one is crossed in both directions with three-byte runes. The NUL refusal in the same clause
// had no test either, so it is checked for both fields.

func advertisedInputLimits(t *testing.T, serverURL string) (int, int, int) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, serverURL+"/work/v1/bootstrap", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.AddCookie(&http.Cookie{Name: host.SessionCookieName, Value: "session-value"})
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("bootstrap = %d body=%s", response.StatusCode, raw)
	}
	var view struct {
		Limits struct {
			MaxGoalChars       int `json:"max_goal_chars"`
			MaxBackgroundChars int `json:"max_background_chars"`
			MaxArtifactBytes   int `json:"max_artifact_bytes"`
		} `json:"limits"`
	}
	if err := json.Unmarshal(raw, &view); err != nil {
		t.Fatal(err)
	}
	if view.Limits.MaxGoalChars <= 0 || view.Limits.MaxBackgroundChars <= 0 ||
		view.Limits.MaxArtifactBytes <= 0 {
		t.Fatalf("bootstrap advertised goal=%d background=%d artifact=%d; a limit of zero would "+
			"make every boundary probe below meaningless", view.Limits.MaxGoalChars,
			view.Limits.MaxBackgroundChars, view.Limits.MaxArtifactBytes)
	}
	return view.Limits.MaxGoalChars, view.Limits.MaxBackgroundChars, view.Limits.MaxArtifactBytes
}

func jsonString(t *testing.T, value string) string {
	t.Helper()
	// json.Marshal escapes a NUL as a u0000 sequence, which is a legal JSON string literal;
	// Go's %q would write backslash-x-0-0, which the server rejects as invalid_json and the test
	// would then be proving the wrong thing.
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestInputLimitsCountRunesNotBytesAndRefuseNUL(t *testing.T) {
	pool, _ := newBootstrapDB(t, true, true)
	server := newHTTPServerWithContent(t, pool, newTestContentStore(t))
	token := bootstrapCSRF(t, server.URL)
	maxGoal, maxBackground, _ := advertisedInputLimits(t, server.URL)

	// "目" is three bytes in UTF-8, so a rune count of N here is a byte count of 3N.
	threeByte := "目"
	goalAtLimit := strings.Repeat(threeByte, maxGoal)
	goalOver := strings.Repeat(threeByte, maxGoal+1)
	backgroundAtLimit := strings.Repeat(threeByte, maxBackground)
	backgroundOver := strings.Repeat(threeByte, maxBackground+1)
	if utf8.RuneCountInString(goalAtLimit) != maxGoal || len(goalAtLimit) != 3*maxGoal {
		t.Fatalf("the fixture is not what the test claims: runes=%d bytes=%d, want %d runes at "+
			"3 bytes each", utf8.RuneCountInString(goalAtLimit), len(goalAtLimit), maxGoal)
	}

	inputBody := func(id, goal, background string) string {
		return fmt.Sprintf(`{"client_request_id":%s,"goal":%s,"background":%s}`,
			jsonString(t, id), jsonString(t, goal), jsonString(t, background))
	}

	cases := []struct {
		id     string
		goal   string
		bg     string
		status int
		code   string
		note   string
	}{
		{"input-limit-0001", goalAtLimit, "短背景", http.StatusCreated, "",
			"a goal at exactly the advertised character limit must be accepted"},
		{"input-limit-0002", goalOver, "短背景", http.StatusBadRequest, "invalid_request",
			"one rune over the advertised goal limit must be refused"},
		{"input-limit-0003", "短目标", backgroundAtLimit, http.StatusCreated, "",
			"a background at exactly the advertised limit must be accepted"},
		{"input-limit-0004", "短目标", backgroundOver, http.StatusBadRequest, "invalid_request",
			"one rune over the advertised background limit must be refused"},
		{"input-limit-0005", goalAtLimit, backgroundAtLimit, http.StatusCreated, "",
			"both fields at their limit are one request of about 18 KB, still under the 64 KiB " +
				"transport cap, so neither limit may be read as a share of one budget"},
		{"input-limit-0006", "前" + threeByte + "\x00后", "短背景", http.StatusBadRequest,
			"invalid_request", "a NUL byte in the goal must be refused"},
		{"input-limit-0007", "短目标", "前" + threeByte + "\x00后", http.StatusBadRequest,
			"invalid_request", "a NUL byte in the background must be refused"},
	}

	for _, c := range cases {
		response := postInput(t, server.URL, token, inputBody(c.id, c.goal, c.bg))
		if c.status == http.StatusCreated {
			if response.StatusCode != http.StatusCreated {
				body, _ := io.ReadAll(response.Body)
				response.Body.Close()
				t.Fatalf("%s (%s): status = %d body=%s, want 201", c.id, c.note,
					response.StatusCode, body)
			}
			var created struct {
				InputRef    string `json:"input_ref"`
				ContentHash string `json:"content_hash"`
				Bytes       int64  `json:"bytes"`
			}
			if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
				response.Body.Close()
				t.Fatalf("%s: 201 body did not decode: %v", c.id, err)
			}
			response.Body.Close()
			if created.InputRef == "" || created.ContentHash == "" || created.Bytes <= 0 {
				t.Fatalf("%s: accepted input came back with ref=%q hash=%q bytes=%d; the response "+
					"is what the task submit call is built from", c.id, created.InputRef,
					created.ContentHash, created.Bytes)
			}
			continue
		}
		assertAPICode(t, response, c.status, c.code)
	}

	// The asymmetry that makes this more than a length check: the same 6000-byte goal is fine
	// because it is 2000 runes, while 2001 runes is refused even though both bodies are well
	// under the transport cap. If the handler ever counts bytes, the first case is the one that
	// goes red.
	if len(goalOver) <= len(goalAtLimit) {
		t.Fatalf("fixture ordering is wrong: the over-limit goal (%d bytes) is not longer than "+
			"the at-limit goal (%d bytes)", len(goalOver), len(goalAtLimit))
	}
	t.Logf("limits as advertised: goal=%d background=%d; %d cases, byte lengths %d/%d for the "+
		"accepted/refused goal boundary", maxGoal, maxBackground, len(cases),
		len(goalAtLimit), len(goalOver))
}
