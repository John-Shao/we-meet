package main

import "testing"

func TestIsOrphan(t *testing.T) {
	for status, want := range map[string]bool{
		"Running":        false,
		"Unavailable":    false,
		"Completed":      true,
		"Failed":         true,
		"Canceled":       true,
		"Terminated":     true,
		"ContinuedAsNew": true,
		"TimedOut":       true,
		"NotFound":       true,
		"Missing":        true,
		"Unspecified":    true,
	} {
		if got := isOrphan(status); got != want {
			t.Fatalf("isOrphan(%q) = %t, want %t", status, got, want)
		}
	}
}

func TestValidateAction(t *testing.T) {
	cases := []struct {
		name string
		cfg  config
		want string
	}{
		{name: "sent_succeeded requires evidence", cfg: config{resolution: "sent_succeeded"}, want: "-evidence-ref is required"},
		{name: "rejected requires evidence", cfg: config{resolution: "rejected_not_executed"}, want: "requires -evidence-ref"},
		{name: "rejected rejects settlement", cfg: config{resolution: "rejected_not_executed", evidenceRef: "receipt", settledTokens: 1}, want: "zero -settled-tokens"},
		{name: "unresolved rejects resume", cfg: config{resolution: "unresolved", resume: true}, want: "not allowed for unresolved"},
		{name: "unknown resolution", cfg: config{resolution: "other"}, want: "-resolution must be"},
		{name: "valid rejected", cfg: config{resolution: "rejected_not_executed", evidenceRef: "receipt"}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			cfg := testCase.cfg
			err := validateAction(&cfg)
			if testCase.want == "" {
				if err != nil {
					t.Fatalf("validateAction() = %v", err)
				}
				return
			}
			if err == nil || !contains(err.Error(), testCase.want) {
				t.Fatalf("validateAction() = %v, want %q", err, testCase.want)
			}
		})
	}
}

func contains(value, part string) bool {
	if len(part) > len(value) {
		return false
	}
	for index := 0; index+len(part) <= len(value); index++ {
		if value[index:index+len(part)] == part {
			return true
		}
	}
	return false
}
