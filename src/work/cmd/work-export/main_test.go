package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestEncodeExportCSVAndJSON(t *testing.T) {
	actor := "sub_a"
	rows := []auditRow{{
		ID:             "00000000-0000-4000-8000-000000000001",
		ActorSubjectID: &actor,
		Action:         "admin.overview_read",
		TargetType:     "org",
		TargetID:       "org_a",
		Metadata:       json.RawMessage(`{"account_key":"default"}`),
		CreatedAt:      time.Date(2026, 10, 31, 6, 0, 0, 0, time.UTC),
	}}

	csvData, mediaType, err := encodeExport(rows, "csv")
	if err != nil {
		t.Fatal(err)
	}
	if mediaType != "text/csv; charset=utf-8" {
		t.Fatalf("media type = %q", mediaType)
	}
	if !strings.Contains(string(csvData), "admin.overview_read") ||
		!strings.HasPrefix(string(csvData), "id,actor_subject_id") {
		t.Fatalf("csv = %s", csvData)
	}

	jsonData, mediaType, err := encodeExport(rows, "json")
	if err != nil {
		t.Fatal(err)
	}
	if mediaType != "application/json" {
		t.Fatalf("media type = %q", mediaType)
	}
	var decoded []auditRow
	if err := json.Unmarshal(jsonData, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded) != 1 || decoded[0].Action != "admin.overview_read" {
		t.Fatalf("json = %#v", decoded)
	}
}

func TestEncodeExportRejectsUnknownFormat(t *testing.T) {
	if _, _, err := encodeExport(nil, "xml"); err == nil {
		t.Fatal("expected an error")
	}
}
