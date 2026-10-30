package main

import "testing"

func TestNewRuntimeOnlyAllowsReference(t *testing.T) {
	for _, mode := range []string{"", "reference"} {
		if _, err := newRuntime(mode); err != nil {
			t.Fatalf("mode %q: %v", mode, err)
		}
	}
	for _, mode := range []string{"openai_compatible", "openai", "provider"} {
		if _, err := newRuntime(mode); err == nil {
			t.Fatalf("mode %q must be rejected until the signed Node/Pi boundary exists", mode)
		}
	}
}
