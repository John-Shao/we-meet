package main

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestDefaultRelayIDIsUniquePerProcess(t *testing.T) {
	t.Setenv("WORK_RELAY_ID", "")
	first := defaultRelayID()
	second := defaultRelayID()
	if first == second {
		t.Fatalf("relay ids must differ: %q", first)
	}
	if !strings.HasPrefix(first, "work-relay-") {
		t.Fatalf("relay id = %q", first)
	}
}

func TestDefaultRelayIDHonorsOverride(t *testing.T) {
	t.Setenv("WORK_RELAY_ID", "relay-a")
	first, second := defaultRelayID(), defaultRelayID()
	if first == second {
		t.Fatalf("configured relay ids must differ: %q", first)
	}
	for _, got := range []string{first, second} {
		if !strings.HasPrefix(got, "relay-a-") {
			t.Fatalf("relay id = %q", got)
		}
		if _, err := uuid.Parse(strings.TrimPrefix(got, "relay-a-")); err != nil {
			t.Fatalf("relay id must have a UUID suffix: %q: %v", got, err)
		}
	}
}
