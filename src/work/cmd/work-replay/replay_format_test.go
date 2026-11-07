package main

// The format contract between the two legs of §5.32's preflight.
//
// Exporting a history and replaying a history are two halves of one check, and until this file the
// tree only had the consumer half - so nothing proved the file the exporter writes is the file the
// replayer parses. The replayer's own reader is SDK-internal (extractHistoryFromFile unmarshals into
// historypb.History with DiscardUnknown), so the honest way to test agreement is to hand the written
// file to the consumer and compare *which kind* of failure comes back: a file the parser cannot read
// fails differently from a file it read but cannot replay. The truncated control below is what makes
// that distinction worth asserting.
//
// What this does NOT claim: that a real production history replays. That needs a real history, which
// needs the export run against the pilot host's Temporal frontend - recorded as the remaining step in
// §5.32, not pretended away with a hand-written event stream that would only prove my own fixture.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	commonpb "go.temporal.io/api/common/v1"
	apienum "go.temporal.io/api/enums/v1"
	historypb "go.temporal.io/api/history/v1"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/we-meet/work/internal/runflow"
)

func syntheticHistory() *historypb.History {
	start := &historypb.HistoryEvent{
		EventId:   1,
		EventType: apienum.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED,
		EventTime: timestamppb.New(time.Unix(1730000000, 0).UTC()),
	}
	start.Attributes = &historypb.HistoryEvent_WorkflowExecutionStartedEventAttributes{
		WorkflowExecutionStartedEventAttributes: &historypb.WorkflowExecutionStartedEventAttributes{
			WorkflowType: &commonpb.WorkflowType{Name: runflow.WorkflowAdvanceName},
		},
	}
	complete := &historypb.HistoryEvent{
		EventId:   2,
		EventType: apienum.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED,
		EventTime: timestamppb.New(time.Unix(1730000060, 0).UTC()),
	}
	return &historypb.History{Events: []*historypb.HistoryEvent{start, complete}}
}

func replayFailureText(t *testing.T, path string) string {
	t.Helper()
	err := newReplayer().ReplayWorkflowHistoryFromJSONFile(nil, path)
	// Logged, because the point of this file is that operators and reviewers can see which layer
	// complained rather than being told "an error came back".
	t.Logf("replay %s => %v", filepath.Base(path), err)
	if err == nil {
		t.Fatalf("replaying a two-event stub %s succeeded; it cannot, so the fixture changed shape - "+
			"re-read what this test is claiming before trusting any assertion below", path)
	}
	return err.Error()
}

func TestWrittenHistoryReachesTheReplayerParser(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "history.json")

	events, size, err := writeHistoryFile(path, syntheticHistory())
	if err != nil {
		t.Fatalf("writeHistoryFile: %v", err)
	}
	if events != 2 || size == 0 {
		t.Fatalf("export reported events=%d bytes=%d, want 2 events and a non-empty file", events, size)
	}

	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	// The field names and the int64-as-string encoding are the contract: a reader that expects
	// historypb.History wants "events" with camelCase attribute keys and quoted ids. Swapping
	// protojson for encoding/json would produce "Events" and bare numbers and still "look like JSON",
	// so this pins the shape rather than trusting the writer's own library.
	for _, needle := range []string{`"events"`, `"eventId":"1"`, `"eventType":"EVENT_TYPE_WORKFLOW_EXECUTION_STARTED"`,
		`"workflowExecutionStartedEventAttributes"`, `"eventTime"`} {
		if !strings.Contains(text, needle) {
			t.Fatalf("exported file does not carry %q; the replayer parses historypb.History with protojson, "+
				"so this is the format it expects:\n%s", needle, text)
		}
	}

	// Control: a file the parser genuinely cannot read must fail differently, or the assertion below
	// would pass on any error at all.
	broken := filepath.Join(dir, "truncated.json")
	if err := os.WriteFile(broken, []byte(`{"events": [`), 0o644); err != nil {
		t.Fatal(err)
	}
	parseFailure := replayFailureText(t, broken)
	if !mentionsParseFailure(parseFailure) {
		t.Fatalf("a truncated JSON file failed with %q, which does not read as a parse failure - "+
			"this test's distinction between parsed-and-not would be meaningless", parseFailure)
	}

	// Forward leg: the exported file must be readable, so whatever the consumer complains about next is
	// about the history's content, not its encoding.
	replayFailure := replayFailureText(t, path)
	if mentionsParseFailure(replayFailure) {
		t.Fatalf("the replayer could not parse the file the exporter wrote: %q\nfile:\n%s",
			replayFailure, text)
	}
	// Stronger than "not a parse error": with two events written, the engine answers that it needs at
	// least three. It could only count them by decoding the file, so that single message proves the
	// exporter's output reaches the replay engine with the number and shape of events it claims.
	if !strings.Contains(replayFailure, "event") {
		t.Fatalf("replay failure %q does not read as the engine counting decoded events, so the forward "+
			"leg of this test no longer proves the file parsed", replayFailure)
	}
}

// mentionsParseFailure recognises the encoding side of the failure surface. The SDK unmarshals the
// file with its own protojson wrapper, so a file it cannot read comes back prefixed
// "temporalproto:" - observed text is "temporalproto: unexpected EOF". Anything without that marker
// (unknown workflow type, missing workflow task, determinism) is the replay engine talking, which is
// the half that proves the file was readable.
func mentionsParseFailure(message string) bool {
	lower := strings.ToLower(message)
	for _, needle := range []string{"temporalproto", "protojson", "unexpected eof", "unexpected end",
		"invalid character", "unexpected token", "cannot parse", "malformed", "syntax"} {
		if strings.Contains(lower, needle) {
			return true
		}
	}
	return false
}

func TestEmptyExportIsRefused(t *testing.T) {
	// An export that returned no events means the read failed or the id was wrong. Writing it as a file
	// would hand the preflight a green-looking nothing, which is the exact failure §5.32 warns about.
	if _, err := historyFileBody(&historypb.History{}); err == nil ||
		!strings.Contains(err.Error(), "empty history") {
		t.Fatalf("empty history accepted (err=%v); the exporter must refuse it", err)
	}
	var nilHistory *historypb.History
	if _, err := historyFileBody(nilHistory); err == nil {
		t.Fatal("nil history accepted")
	}
}

func TestExportRefusesBeforeDialing(t *testing.T) {
	t.Setenv("WORK_TEMPORAL_ADDRESS", "")
	if err := runExport("run:1", "", time.Minute); err == nil ||
		!strings.Contains(err.Error(), "-out FILE") {
		t.Fatalf("missing -out error = %v, want the -out requirement named before anything else", err)
	}
	err := runExport("", "history.json", time.Minute)
	if err == nil || !strings.Contains(err.Error(), "workflow id") {
		t.Fatalf("empty workflow id error = %v, want it rejected", err)
	}
	// No address: the export must fail on configuration, not hang or dial a default endpoint.
	err = runExport("run:1", filepath.Join(t.TempDir(), "h.json"), time.Minute)
	if err == nil || !strings.Contains(err.Error(), "WORK_TEMPORAL_ADDRESS") {
		t.Fatalf("no-address error = %v, want the env var named", err)
	}
}

func TestUsageNamesBothLegs(t *testing.T) {
	// §5.32 tells the operator to "export, then replay"; if a mode disappears from the usage text the
	// runbook instruction becomes a dead end, so the two halves are pinned together here.
	for _, needle := range []string{"HISTORY.json", "-export", "-out", "WORK_TEMPORAL_ADDRESS", "read-only"} {
		if !strings.Contains(usage, needle) {
			t.Fatalf("usage text no longer mentions %q:\n%s", needle, usage)
		}
	}
	if !strings.Contains(usage, "work-reconcile -scan") {
		t.Fatal("usage must name the tool whose env knobs -export reuses, or the operator guesses")
	}
}
