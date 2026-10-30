package capability_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/we-meet/work/internal/capability"
)

// These tests need no database: they pin the local input contract and the
// enumeration-only error surface.

func codeOf(t *testing.T, err error) string {
	t.Helper()
	var capabilityErr *capability.Error
	if !errors.As(err, &capabilityErr) {
		t.Fatalf("error = %v, want a capability enumeration error", err)
	}
	return capabilityErr.Code
}

func TestIssueValidatesInputBeforeTouchingTheDatabase(t *testing.T) {
	ctx := context.Background()
	issuer := capability.NewIssuer(nil)

	for name, call := range map[string]func() error{
		"zero ttl": func() error {
			_, _, err := issuer.Issue(ctx, "org", "exec", "holder", capability.AudienceContent, 0)
			return err
		},
		"negative ttl": func() error {
			_, _, err := issuer.Issue(ctx, "org", "exec", "holder", capability.AudienceContent, -time.Second)
			return err
		},
		"unknown audience": func() error {
			_, _, err := issuer.Issue(ctx, "org", "exec", "holder", "work-admin", time.Second)
			return err
		},
		"missing org": func() error {
			_, _, err := issuer.Issue(ctx, "", "exec", "holder", capability.AudienceContent, time.Second)
			return err
		},
		"missing execution": func() error {
			_, _, err := issuer.Issue(ctx, "org", "", "holder", capability.AudienceContent, time.Second)
			return err
		},
		"missing holder": func() error {
			_, _, err := issuer.Issue(ctx, "org", "exec", "", capability.AudienceContent, time.Second)
			return err
		},
	} {
		if err := call(); err == nil || codeOf(t, err) != "invalid_request" {
			t.Fatalf("%s: error = %v, want invalid_request", name, err)
		}
	}

	if _, _, err := issuer.Issue(ctx, "org", "exec", "holder", capability.AudienceContent, time.Second); codeOf(t, err) != "pool_required" {
		t.Fatalf("nil pool error = %v", err)
	}
}

func TestAuthorizeAndRevokeValidateLocally(t *testing.T) {
	ctx := context.Background()
	issuer := capability.NewIssuer(nil)

	if _, err := issuer.Authorize(ctx, "org", "exec", capability.AudienceContent, 1, "token"); codeOf(t, err) != "pool_required" {
		t.Fatalf("authorize nil pool error = %v", err)
	}
	if _, err := issuer.Revoke(ctx, "org", "exec", ""); codeOf(t, err) != "invalid_request" {
		t.Fatalf("revoke empty reason error = %v", err)
	}
	if _, err := issuer.Revoke(ctx, "org", "exec", "session_ended"); codeOf(t, err) != "pool_required" {
		t.Fatalf("revoke nil pool error = %v", err)
	}
}
