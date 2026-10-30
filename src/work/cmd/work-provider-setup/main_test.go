package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/providerctx"
)

const secretMarker = "MARKER-work-provider-setup-6b7d-never-echo"

const testCredentialID = "11111111-1111-4111-8111-111111111111"

type fakeBackend struct {
	create    func(context.Context, workdb.Identity, credentialPlan) (credentialResult, error)
	rotate    func(context.Context, workdb.Identity, string, credentialPlan) (credentialResult, error)
	revoke    func(context.Context, workdb.Identity, string, string) error
	setConfig func(context.Context, workdb.Identity, configPlan, bool) (configResult, error)
	resolve   func(context.Context, string) (providerctx.Context, error)
	closed    bool
}

func (f *fakeBackend) CreateCredential(ctx context.Context, identity workdb.Identity, plan credentialPlan) (credentialResult, error) {
	if f.create == nil {
		return credentialResult{}, errors.New("unexpected CreateCredential")
	}
	return f.create(ctx, identity, plan)
}

func (f *fakeBackend) RotateCredential(ctx context.Context, identity workdb.Identity, credentialID string, plan credentialPlan) (credentialResult, error) {
	if f.rotate == nil {
		return credentialResult{}, errors.New("unexpected RotateCredential")
	}
	return f.rotate(ctx, identity, credentialID, plan)
}

func (f *fakeBackend) RevokeCredential(ctx context.Context, identity workdb.Identity, credentialID, reason string) error {
	if f.revoke == nil {
		return errors.New("unexpected RevokeCredential")
	}
	return f.revoke(ctx, identity, credentialID, reason)
}

func (f *fakeBackend) SetConfig(ctx context.Context, identity workdb.Identity, plan configPlan, dryRun bool) (configResult, error) {
	if f.setConfig == nil {
		return configResult{}, errors.New("unexpected SetConfig")
	}
	return f.setConfig(ctx, identity, plan, dryRun)
}

func (f *fakeBackend) ResolveProvider(ctx context.Context, orgID string) (providerctx.Context, error) {
	if f.resolve == nil {
		return providerctx.Context{}, errors.New("unexpected ResolveProvider")
	}
	return f.resolve(ctx, orgID)
}

func (f *fakeBackend) Close() { f.closed = true }

func validEnv() map[string]string {
	return map[string]string{
		"WORK_DATABASE_URL":       "postgres://work_api@example.invalid/work",
		"WORK_CONTENT_MASTER_KEY": strings.Repeat("ab", 32),
	}
}

func testApp(t *testing.T, env map[string]string, readFile func(string) ([]byte, error), b backend) (*app, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	if env == nil {
		env = validEnv()
	}
	if readFile == nil {
		readFile = func(string) ([]byte, error) { return []byte(secretMarker + "\n"), nil }
	}
	var stdout, stderr bytes.Buffer
	return &app{
		stdout:   &stdout,
		stderr:   &stderr,
		getenv:   func(name string) string { return env[name] },
		readFile: readFile,
		newBackend: func(context.Context, string, []byte) (backend, error) {
			if b == nil {
				return nil, errors.New("unexpected backend call")
			}
			return b, nil
		},
	}, &stdout, &stderr
}

func credentialArgs(secretPath string) []string {
	return []string{
		"credential",
		"-org", "org_unit",
		"-provider", "aliyun",
		"-actor", "subject_owner",
		"-secret-file", secretPath,
	}
}

func rotateArgs(secretPath string) []string {
	return []string{
		"rotate",
		"-org", "org_unit",
		"-credential-id", testCredentialID,
		"-actor", "subject_owner",
		"-secret-file", secretPath,
	}
}

func revokeArgs() []string {
	return []string{
		"revoke",
		"-org", "org_unit",
		"-credential-id", testCredentialID,
		"-actor", "subject_owner",
		"-reason", "operator rotation",
	}
}

func configArgs() []string {
	return []string{
		"config",
		"-org", "org_unit",
		"-credential-id", testCredentialID,
		"-provider", "aliyun",
		"-model", "qwen3-coder-plus",
		"-region", "cn-beijing",
		"-endpoint", "https://dashscope.aliyuncs.com",
		"-actor", "subject_owner",
	}
}

func with(args []string, extra ...string) []string {
	return append(append([]string{}, args...), extra...)
}

func TestCredentialArgumentValidation(t *testing.T) {
	secretPath := filepath.Join(t.TempDir(), "provider.key")
	if err := os.WriteFile(secretPath, []byte(secretMarker+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	missingDB := validEnv()
	delete(missingDB, "WORK_DATABASE_URL")
	missingKey := validEnv()
	delete(missingKey, "WORK_CONTENT_MASTER_KEY")
	badKey := validEnv()
	badKey["WORK_CONTENT_MASTER_KEY"] = "not-a-master-key"

	tests := []struct {
		name     string
		args     []string
		env      map[string]string
		readFile func(string) ([]byte, error)
		want     string
	}{
		{name: "missing org", args: []string{"credential", "-provider", "aliyun", "-actor", "a", "-secret-file", secretPath}, want: "-org is required"},
		{name: "missing actor", args: []string{"credential", "-org", "o", "-provider", "aliyun", "-secret-file", secretPath}, want: "-actor is required"},
		{name: "missing provider", args: []string{"credential", "-org", "o", "-actor", "a", "-secret-file", secretPath}, want: "-provider must be"},
		{name: "unknown provider", args: with(credentialArgs(secretPath), "-provider", "openai"), want: "-provider must be"},
		{name: "sts_role mode", args: with(credentialArgs(secretPath), "-mode", "sts_role"), want: "-mode must be managed_key"},
		{name: "key version 2", args: with(credentialArgs(secretPath), "-key-version", "2"), want: "-key-version must be 1"},
		{name: "missing secret file", args: []string{"credential", "-org", "o", "-provider", "aliyun", "-actor", "a"}, want: "-secret-file is required"},
		{
			name: "unreadable secret file",
			args: credentialArgs(secretPath),
			readFile: func(string) ([]byte, error) {
				return nil, fmt.Errorf("disk error for %s", secretMarker)
			},
			want: "cannot read -secret-file",
		},
		{
			name:     "empty secret file",
			args:     credentialArgs(secretPath),
			readFile: func(string) ([]byte, error) { return []byte(" \r\n\t"), nil },
			want:     "contains no key material",
		},
		{name: "missing database url", args: credentialArgs(secretPath), env: missingDB, want: "WORK_DATABASE_URL is required"},
		{name: "missing master key", args: credentialArgs(secretPath), env: missingKey, want: "WORK_CONTENT_MASTER_KEY is required"},
		{name: "bad master key", args: credentialArgs(secretPath), env: badKey, want: "32-byte hex or base64"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			a, stdout, stderr := testApp(t, tc.env, tc.readFile, nil)
			err := a.execute(context.Background(), tc.args)
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %q, want substring %q", err.Error(), tc.want)
			}
			if strings.Contains(err.Error()+stdout.String()+stderr.String(), secretMarker) {
				t.Fatalf("secret marker leaked from validation: %q", err.Error())
			}
		})
	}
}

func TestConfigArgumentValidation(t *testing.T) {
	missingOrg := configArgs()
	missingOrg = append(missingOrg[:1], missingOrg[5:]...) // drop "-org org_unit"

	tests := []struct {
		name string
		args []string
		env  map[string]string
		want string
	}{
		{name: "missing org", args: missingOrg, want: "-org is required"},
		{name: "missing credential id", args: with(configArgs(), "-credential-id", ""), want: "-credential-id is required"},
		{name: "bad credential id", args: with(configArgs(), "-credential-id", "not-a-uuid"), want: "-credential-id must be a UUID"},
		{name: "missing provider", args: with(configArgs(), "-provider", ""), want: "-provider must be"},
		{name: "missing model", args: with(configArgs(), "-model", ""), want: "-model must be 1 to 120 bytes"},
		{name: "long model", args: with(configArgs(), "-model", strings.Repeat("m", 121)), want: "-model must be 1 to 120 bytes"},
		{name: "missing region", args: with(configArgs(), "-region", ""), want: "-region is required"},
		{name: "missing endpoint", args: with(configArgs(), "-endpoint", ""), want: "-endpoint is required"},
		{name: "http endpoint", args: with(configArgs(), "-endpoint", "http://example.test"), want: "-endpoint must be an https URL"},
		{name: "endpoint without host", args: with(configArgs(), "-endpoint", "https:///path"), want: "-endpoint must be an https URL"},
		{name: "missing actor", args: with(configArgs(), "-actor", ""), want: "-actor is required"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			a, _, _ := testApp(t, tc.env, nil, nil)
			err := a.execute(context.Background(), tc.args)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want substring %q", err, tc.want)
			}
			if strings.Contains(err.Error(), secretMarker) {
				t.Fatalf("secret marker leaked from validation: %q", err.Error())
			}
		})
	}
}

func TestStatusArgumentValidation(t *testing.T) {
	a, _, _ := testApp(t, validEnv(), nil, nil)
	if err := a.execute(context.Background(), []string{"status"}); err == nil || !strings.Contains(err.Error(), "-org is required") {
		t.Fatalf("status missing org error = %v", err)
	}

	missingDB := validEnv()
	delete(missingDB, "WORK_DATABASE_URL")
	a, _, _ = testApp(t, missingDB, nil, nil)
	if err := a.execute(context.Background(), []string{"status", "-org", "org_unit"}); err == nil || !strings.Contains(err.Error(), "WORK_DATABASE_URL is required") {
		t.Fatalf("status missing database URL error = %v", err)
	}
}

func TestFlagErrorsNeverEchoValues(t *testing.T) {
	a, stdout, stderr := testApp(t, validEnv(), nil, nil)
	err := a.execute(context.Background(), []string{"credential", "-key-version", secretMarker})
	if err == nil {
		t.Fatal("expected a flag error")
	}
	combined := err.Error() + stdout.String() + stderr.String()
	if strings.Contains(combined, secretMarker) {
		t.Fatalf("flag error echoed a flag value: %q", combined)
	}
}

func TestValidateProviderNeverEchoesValue(t *testing.T) {
	a, stdout, stderr := testApp(t, validEnv(), nil, nil)
	err := a.execute(context.Background(), with(credentialArgs("ignored"), "-provider", secretMarker))
	if err == nil {
		t.Fatal("expected a provider validation error")
	}
	combined := err.Error() + stdout.String() + stderr.String()
	if strings.Contains(combined, secretMarker) {
		t.Fatalf("provider error echoed the value: %q", combined)
	}
}

func TestCredentialDryRunNeverPrintsSecret(t *testing.T) {
	a, stdout, stderr := testApp(t, validEnv(), func(string) ([]byte, error) {
		return []byte("  " + secretMarker + "\r\n"), nil
	}, nil)

	if err := a.execute(context.Background(), with(credentialArgs("ignored"), "-dry-run")); err != nil {
		t.Fatalf("dry run: %v", err)
	}
	out := stdout.String()
	if strings.Contains(out+stderr.String(), secretMarker) {
		t.Fatalf("dry run leaked the secret: %q", out)
	}
	for _, want := range []string{"dry_run=true", "org=org_unit", "provider=aliyun", "mode=managed_key", "key_version=1", "actor=subject_owner"} {
		if !strings.Contains(out, want) {
			t.Fatalf("dry run output missing %q: %q", want, out)
		}
	}
	fields := parseFields(t, out)
	if len(fields["fingerprint"]) != 16 {
		t.Fatalf("fingerprint = %q, want 16 hex characters", fields["fingerprint"])
	}
}

func TestCredentialApplyPrintsOnlyIDAndFingerprint(t *testing.T) {
	var captured credentialPlan
	fake := &fakeBackend{create: func(_ context.Context, identity workdb.Identity, plan credentialPlan) (credentialResult, error) {
		if identity.OrgID != "org_unit" || identity.SubjectID != "subject_owner" {
			t.Fatalf("identity = %+v", identity)
		}
		captured = plan
		return credentialResult{CredentialID: "cred-123", KeyVersion: 1}, nil
	}}
	a, stdout, stderr := testApp(t, validEnv(), func(string) ([]byte, error) {
		return []byte(secretMarker + "\n"), nil
	}, fake)

	if err := a.execute(context.Background(), credentialArgs("ignored")); err != nil {
		t.Fatalf("credential: %v", err)
	}
	if captured.Provider != "aliyun" || captured.Mode != "managed_key" || captured.KeyVersion != 1 {
		t.Fatalf("captured plan = %+v", captured)
	}
	if len(captured.Ciphertext) == 0 || captured.Fingerprint == "" {
		t.Fatalf("captured plan has no sealed material: %+v", captured)
	}
	out := stdout.String()
	if strings.Contains(out+stderr.String(), secretMarker) {
		t.Fatalf("apply leaked the secret: %q", out)
	}
	if !strings.Contains(out, "credential_id=cred-123") || !strings.Contains(out, "fingerprint="+captured.Fingerprint) {
		t.Fatalf("apply output = %q", out)
	}
	if strings.Contains(out, "secret") || strings.Contains(out, "ciphertext") {
		t.Fatalf("apply output contains extra credential material: %q", out)
	}
}

func TestRotateArgumentValidation(t *testing.T) {
	secretPath := filepath.Join(t.TempDir(), "provider.key")
	if err := os.WriteFile(secretPath, []byte(secretMarker+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	missingDB := validEnv()
	delete(missingDB, "WORK_DATABASE_URL")
	missingKey := validEnv()
	delete(missingKey, "WORK_CONTENT_MASTER_KEY")

	tests := []struct {
		name     string
		args     []string
		env      map[string]string
		readFile func(string) ([]byte, error)
		want     string
	}{
		{name: "missing org", args: with(rotateArgs(secretPath), "-org", ""), want: "-org is required"},
		{name: "missing actor", args: with(rotateArgs(secretPath), "-actor", ""), want: "-actor is required"},
		{name: "missing credential id", args: with(rotateArgs(secretPath), "-credential-id", ""), want: "-credential-id is required"},
		{name: "bad credential id", args: with(rotateArgs(secretPath), "-credential-id", "not-a-uuid"), want: "-credential-id must be a UUID"},
		{name: "missing secret file", args: with(rotateArgs(secretPath), "-secret-file", ""), want: "-secret-file is required"},
		{
			name: "unreadable secret file",
			args: rotateArgs(secretPath),
			readFile: func(string) ([]byte, error) {
				return nil, fmt.Errorf("disk error for %s", secretMarker)
			},
			want: "cannot read -secret-file",
		},
		{
			name:     "empty secret file",
			args:     rotateArgs(secretPath),
			readFile: func(string) ([]byte, error) { return []byte(" \r\n\t"), nil },
			want:     "contains no key material",
		},
		{name: "missing database url", args: rotateArgs(secretPath), env: missingDB, want: "WORK_DATABASE_URL is required"},
		{name: "missing master key", args: rotateArgs(secretPath), env: missingKey, want: "WORK_CONTENT_MASTER_KEY is required"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			a, stdout, stderr := testApp(t, tc.env, tc.readFile, nil)
			err := a.execute(context.Background(), tc.args)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want substring %q", err, tc.want)
			}
			if strings.Contains(err.Error()+stdout.String()+stderr.String(), secretMarker) {
				t.Fatalf("secret marker leaked from validation: %q", err.Error())
			}
		})
	}
}

func TestRotateDryRunNeverPrintsSecret(t *testing.T) {
	fake := &fakeBackend{}
	a, stdout, stderr := testApp(t, validEnv(), func(string) ([]byte, error) {
		return []byte("  " + secretMarker + "\r\n"), nil
	}, fake)

	if err := a.execute(context.Background(), with(rotateArgs("ignored"), "-dry-run")); err != nil {
		t.Fatalf("dry run: %v", err)
	}
	out := stdout.String()
	if strings.Contains(out+stderr.String(), secretMarker) {
		t.Fatalf("dry run leaked the secret: %q", out)
	}
	for _, want := range []string{"dry_run=true", "org=org_unit", "credential_id=" + testCredentialID, "actor=subject_owner"} {
		if !strings.Contains(out, want) {
			t.Fatalf("dry run output missing %q: %q", want, out)
		}
	}
	if len(parseFields(t, out)["fingerprint"]) != 16 {
		t.Fatalf("fingerprint = %q, want 16 hex characters", parseFields(t, out)["fingerprint"])
	}
	if fake.closed {
		t.Fatal("dry run opened a backend")
	}
}

func TestRotateApplyPrintsOnlyVersionAndFingerprint(t *testing.T) {
	var captured credentialPlan
	fake := &fakeBackend{rotate: func(_ context.Context, identity workdb.Identity, credentialID string, plan credentialPlan) (credentialResult, error) {
		if identity.OrgID != "org_unit" || identity.SubjectID != "subject_owner" {
			t.Fatalf("identity = %+v", identity)
		}
		if credentialID != testCredentialID {
			t.Fatalf("credential id = %q", credentialID)
		}
		captured = plan
		return credentialResult{CredentialID: credentialID, KeyVersion: 2, Fingerprint: plan.Fingerprint}, nil
	}}
	a, stdout, stderr := testApp(t, validEnv(), func(string) ([]byte, error) {
		return []byte(secretMarker + "\n"), nil
	}, fake)

	if err := a.execute(context.Background(), rotateArgs("ignored")); err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if captured.Mode != "managed_key" || len(captured.Ciphertext) == 0 || captured.Fingerprint == "" {
		t.Fatalf("captured plan = %+v", captured)
	}
	out := stdout.String()
	if strings.Contains(out+stderr.String(), secretMarker) {
		t.Fatalf("rotate leaked the secret: %q", out)
	}
	if !strings.Contains(out, "key_version=2") || !strings.Contains(out, "fingerprint="+captured.Fingerprint) {
		t.Fatalf("rotate output = %q", out)
	}
	if strings.Contains(out, "secret") || strings.Contains(out, "ciphertext") {
		t.Fatalf("rotate output contains extra credential material: %q", out)
	}
}

func TestRotateBackendErrorIsSanitized(t *testing.T) {
	fake := &fakeBackend{rotate: func(context.Context, workdb.Identity, string, credentialPlan) (credentialResult, error) {
		return credentialResult{}, fmt.Errorf("database rejected plaintext %s", secretMarker)
	}}
	a, stdout, stderr := testApp(t, validEnv(), func(string) ([]byte, error) {
		return []byte(secretMarker), nil
	}, fake)

	err := a.execute(context.Background(), rotateArgs("ignored"))
	if err == nil || err.Error() != "provider setup backend failed" {
		t.Fatalf("error = %v, want the static backend failure", err)
	}
	if strings.Contains(err.Error()+stdout.String()+stderr.String(), secretMarker) {
		t.Fatalf("backend error leaked the secret")
	}
}

func TestRevokeArgumentValidation(t *testing.T) {
	missingDB := validEnv()
	delete(missingDB, "WORK_DATABASE_URL")

	tests := []struct {
		name string
		args []string
		env  map[string]string
		want string
	}{
		{name: "missing org", args: with(revokeArgs(), "-org", ""), want: "-org is required"},
		{name: "missing actor", args: with(revokeArgs(), "-actor", ""), want: "-actor is required"},
		{name: "missing credential id", args: with(revokeArgs(), "-credential-id", ""), want: "-credential-id is required"},
		{name: "bad credential id", args: with(revokeArgs(), "-credential-id", "not-a-uuid"), want: "-credential-id must be a UUID"},
		{name: "missing reason", args: with(revokeArgs(), "-reason", " "), want: "-reason is required"},
		{name: "missing database url", args: revokeArgs(), env: missingDB, want: "WORK_DATABASE_URL is required"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			a, stdout, stderr := testApp(t, tc.env, nil, nil)
			err := a.execute(context.Background(), tc.args)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want substring %q", err, tc.want)
			}
			if strings.Contains(err.Error()+stdout.String()+stderr.String(), secretMarker) {
				t.Fatalf("secret marker leaked from validation")
			}
		})
	}
}

func TestRevokeDryRunDoesNotWrite(t *testing.T) {
	fake := &fakeBackend{}
	a, stdout, stderr := testApp(t, validEnv(), nil, fake)

	if err := a.execute(context.Background(), with(revokeArgs(), "-dry-run")); err != nil {
		t.Fatalf("dry run: %v", err)
	}
	out := stdout.String()
	if strings.Contains(out+stderr.String(), secretMarker) {
		t.Fatalf("dry run leaked a secret: %q", out)
	}
	for _, want := range []string{"dry_run=true", "org=org_unit", "credential_id=" + testCredentialID, "reason=operator rotation"} {
		if !strings.Contains(out, want) {
			t.Fatalf("dry run output missing %q: %q", want, out)
		}
	}
	if fake.closed {
		t.Fatal("dry run opened a backend")
	}
}

func TestRevokeApplyWithoutMasterKey(t *testing.T) {
	env := validEnv()
	delete(env, "WORK_CONTENT_MASTER_KEY")
	var capturedReason string
	fake := &fakeBackend{revoke: func(_ context.Context, identity workdb.Identity, credentialID, reason string) error {
		if identity.OrgID != "org_unit" || identity.SubjectID != "subject_owner" {
			t.Fatalf("identity = %+v", identity)
		}
		if credentialID != testCredentialID {
			t.Fatalf("credential id = %q", credentialID)
		}
		capturedReason = reason
		return nil
	}}
	a, stdout, stderr := testApp(t, env, nil, fake)

	if err := a.execute(context.Background(), revokeArgs()); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if capturedReason != "operator rotation" {
		t.Fatalf("reason = %q", capturedReason)
	}
	out := stdout.String()
	if strings.Contains(out+stderr.String(), secretMarker) {
		t.Fatalf("revoke leaked a secret: %q", out)
	}
	if !strings.Contains(out, "revoked=true") || !strings.Contains(out, "credential_id="+testCredentialID) {
		t.Fatalf("revoke output = %q", out)
	}
}

func TestRevokeBackendErrorIsSanitized(t *testing.T) {
	fake := &fakeBackend{revoke: func(context.Context, workdb.Identity, string, string) error {
		return fmt.Errorf("database rejected plaintext %s", secretMarker)
	}}
	a, stdout, stderr := testApp(t, validEnv(), nil, fake)

	err := a.execute(context.Background(), revokeArgs())
	if err == nil || err.Error() != "provider setup backend failed" {
		t.Fatalf("error = %v, want the static backend failure", err)
	}
	if strings.Contains(err.Error()+stdout.String()+stderr.String(), secretMarker) {
		t.Fatalf("backend error leaked the secret")
	}
}

func TestCredentialBackendErrorIsSanitized(t *testing.T) {
	fake := &fakeBackend{create: func(context.Context, workdb.Identity, credentialPlan) (credentialResult, error) {
		return credentialResult{}, fmt.Errorf("database rejected plaintext %s", secretMarker)
	}}
	a, stdout, stderr := testApp(t, validEnv(), func(string) ([]byte, error) {
		return []byte(secretMarker), nil
	}, fake)

	err := a.execute(context.Background(), credentialArgs("ignored"))
	if err == nil {
		t.Fatal("expected a backend error")
	}
	if err.Error() != "provider setup backend failed" {
		t.Fatalf("error = %q, want the static backend failure", err.Error())
	}
	combined := err.Error() + stdout.String() + stderr.String()
	if strings.Contains(combined, secretMarker) {
		t.Fatalf("backend error leaked the secret: %q", combined)
	}
}

func TestConfigDryRunUsesReadOnlyPlan(t *testing.T) {
	fake := &fakeBackend{setConfig: func(_ context.Context, identity workdb.Identity, plan configPlan, dryRun bool) (configResult, error) {
		if !dryRun {
			t.Fatal("dry run did not set dryRun")
		}
		if identity.OrgID != "org_unit" || identity.SubjectID != "subject_owner" {
			t.Fatalf("identity = %+v", identity)
		}
		if plan.Provider != "aliyun" || plan.Model != "qwen3-coder-plus" ||
			plan.Region != "cn-beijing" || plan.Endpoint != "https://dashscope.aliyuncs.com" ||
			plan.CredentialID != testCredentialID {
			t.Fatalf("plan = %+v", plan)
		}
		return configResult{CredentialMode: "managed_key"}, nil
	}}
	a, stdout, stderr := testApp(t, validEnv(), nil, fake)

	if err := a.execute(context.Background(), with(configArgs(), "-dry-run")); err != nil {
		t.Fatalf("config dry run: %v", err)
	}
	out := stdout.String()
	for _, want := range []string{"dry_run=true", "credential_id=" + testCredentialID, "credential_mode=managed_key"} {
		if !strings.Contains(out, want) {
			t.Fatalf("config dry run missing %q: %q", want, out)
		}
	}
	if strings.Contains(out+stderr.String(), secretMarker) {
		t.Fatalf("config dry run leaked a secret: %q", out)
	}
}

func TestConfigApplyPrintsConfigID(t *testing.T) {
	fake := &fakeBackend{setConfig: func(context.Context, workdb.Identity, configPlan, bool) (configResult, error) {
		return configResult{ConfigID: "config-456", Revision: 3, CredentialMode: "managed_key"}, nil
	}}
	a, stdout, stderr := testApp(t, validEnv(), nil, fake)

	if err := a.execute(context.Background(), configArgs()); err != nil {
		t.Fatalf("config: %v", err)
	}
	if !strings.Contains(stdout.String(), "config_id=config-456") {
		t.Fatalf("config output = %q", stdout.String())
	}
	if strings.Contains(stdout.String()+stderr.String(), secretMarker) {
		t.Fatalf("config output leaked a secret")
	}
}

func TestConfigBackendErrorIsSanitized(t *testing.T) {
	fake := &fakeBackend{setConfig: func(context.Context, workdb.Identity, configPlan, bool) (configResult, error) {
		return configResult{}, fmt.Errorf("set failed: %s", secretMarker)
	}}
	a, stdout, stderr := testApp(t, validEnv(), nil, fake)

	err := a.execute(context.Background(), configArgs())
	if err == nil || err.Error() != "provider setup backend failed" {
		t.Fatalf("error = %v, want static backend failure", err)
	}
	if strings.Contains(err.Error()+stdout.String()+stderr.String(), secretMarker) {
		t.Fatalf("config backend error leaked the secret")
	}
}

func TestStatusNeverPrintsSecret(t *testing.T) {
	fake := &fakeBackend{resolve: func(_ context.Context, orgID string) (providerctx.Context, error) {
		if orgID != "org_unit" {
			t.Fatalf("org = %q", orgID)
		}
		return providerctx.Context{
			Provider:       "aliyun",
			Model:          "qwen3-coder-plus",
			Region:         "cn-beijing",
			Endpoint:       "https://dashscope.aliyuncs.com",
			Mode:           "managed_key",
			ConfigRevision: 1,
			Secret:         []byte(secretMarker),
		}, nil
	}}
	a, stdout, stderr := testApp(t, validEnv(), nil, fake)

	if err := a.execute(context.Background(), []string{"status", "-org", "org_unit"}); err != nil {
		t.Fatalf("status: %v", err)
	}
	out := stdout.String()
	for _, want := range []string{
		"provider=aliyun",
		"model=qwen3-coder-plus",
		"mode=managed_key",
		"endpoint=https://dashscope.aliyuncs.com",
		"secret_decrypts=true",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("status output missing %q: %q", want, out)
		}
	}
	if strings.Contains(out+stderr.String(), secretMarker) {
		t.Fatalf("status leaked the secret: %q", out)
	}
}

func TestStatusSTSReportsNoSecretCheck(t *testing.T) {
	fake := &fakeBackend{resolve: func(context.Context, string) (providerctx.Context, error) {
		return providerctx.Context{Provider: "aliyun", Model: "m", Mode: "sts_role", Endpoint: "https://e.test"}, nil
	}}
	a, stdout, _ := testApp(t, validEnv(), nil, fake)
	if err := a.execute(context.Background(), []string{"status", "-org", "org_unit"}); err != nil {
		t.Fatalf("status: %v", err)
	}
	if !strings.Contains(stdout.String(), "secret_decrypts=n/a") {
		t.Fatalf("status output = %q", stdout.String())
	}
}

func TestStatusErrorIsSanitized(t *testing.T) {
	fake := &fakeBackend{resolve: func(context.Context, string) (providerctx.Context, error) {
		return providerctx.Context{}, fmt.Errorf("resolve failed with %s", secretMarker)
	}}
	a, stdout, stderr := testApp(t, validEnv(), nil, fake)

	err := a.execute(context.Background(), []string{"status", "-org", "org_unit"})
	if err == nil || err.Error() != "provider context unavailable" {
		t.Fatalf("error = %v, want static status failure", err)
	}
	if strings.Contains(err.Error()+stdout.String()+stderr.String(), secretMarker) {
		t.Fatalf("status error leaked the secret")
	}
}

func TestStatusEnumerationErrorPreserved(t *testing.T) {
	fake := &fakeBackend{resolve: func(context.Context, string) (providerctx.Context, error) {
		return providerctx.Context{}, &providerctx.Error{Code: providerctx.CodeProviderNotConfigured}
	}}
	a, _, _ := testApp(t, validEnv(), nil, fake)
	err := a.execute(context.Background(), []string{"status", "-org", "org_unit"})
	if err == nil || !strings.Contains(err.Error(), providerctx.CodeProviderNotConfigured) {
		t.Fatalf("error = %v, want enumeration code", err)
	}
}

func TestHelpAndUnknownCommand(t *testing.T) {
	a, stdout, _ := testApp(t, validEnv(), nil, nil)
	if err := a.execute(context.Background(), []string{"-h"}); err != nil {
		t.Fatalf("help: %v", err)
	}
	if !strings.Contains(stdout.String(), "work-provider-setup credential") {
		t.Fatalf("help output = %q", stdout.String())
	}

	a, _, _ = testApp(t, validEnv(), nil, nil)
	if err := a.execute(context.Background(), []string{"unknown"}); err == nil || !strings.Contains(err.Error(), "unknown command") {
		t.Fatalf("unknown command error = %v", err)
	}
}

func parseFields(t *testing.T, output string) map[string]string {
	t.Helper()
	fields := make(map[string]string)
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		fields[key] = value
	}
	return fields
}
