// Command work-provider-setup configures an organization's provider access
// configuration and sealed provider credential for the pilot.
//
// The command talks to PostgreSQL only through the signed domain functions
// work.create_provider_credential, work.set_provider_config,
// work.get_provider_credential_view, and work.resolve_provider_context. The
// provider API key is read from a file named by -secret-file and never from
// argv or the environment. Only the credential id, fingerprint, and redacted
// resolution summary are printed.
package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/signal"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/we-meet/work/internal/content"
	"github.com/we-meet/work/internal/credentials"
	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/providerctx"
)

const usageText = `usage:
  work-provider-setup credential -org ORG -provider aliyun|volcengine|deepseek \
      -secret-file PATH -actor SUBJECT [-mode managed_key] [-key-version 1] [-dry-run]
  work-provider-setup config -org ORG -credential-id UUID -provider PROVIDER \
      -model MODEL -region REGION -endpoint https://... -actor SUBJECT [-dry-run]
  work-provider-setup status -org ORG

The provider API key is read only from -secret-file. Never pass it in argv or
the environment.

Environment:
  WORK_DATABASE_URL        work_api login for credential/config; status needs a
                           login that may SET ROLE work_worker (worker login)
  WORK_CONTENT_MASTER_KEY  32-byte provider credential master key as hex or base64
`

var errHelp = errors.New("help requested")

type app struct {
	stdout     io.Writer
	stderr     io.Writer
	getenv     func(string) string
	readFile   func(string) ([]byte, error)
	newBackend func(context.Context, string, []byte) (backend, error)
}

func newDefaultApp() *app {
	return &app{
		stdout:     os.Stdout,
		stderr:     os.Stderr,
		getenv:     os.Getenv,
		readFile:   os.ReadFile,
		newBackend: newPGScopedBackend,
	}
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	if err := newDefaultApp().execute(ctx, os.Args[1:]); err != nil {
		os.Exit(1)
	}
}

// execute runs the command and reports a sanitized error on stderr. Backend
// errors are reduced to enumeration codes before they reach this writer.
func (a *app) execute(ctx context.Context, args []string) error {
	err := a.run(ctx, args)
	if err != nil {
		fmt.Fprintf(a.stderr, "work-provider-setup: %v\n", err)
	}
	return err
}

func (a *app) run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return errors.New("missing command (credential, config, or status)")
	}
	switch args[0] {
	case "credential":
		return a.runCredential(ctx, args[1:])
	case "config":
		return a.runConfig(ctx, args[1:])
	case "status":
		return a.runStatus(ctx, args[1:])
	case "help", "-h", "--help":
		fmt.Fprint(a.stdout, usageText)
		return nil
	default:
		return errors.New("unknown command")
	}
}

func newFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs
}

func parseFlags(fs *flag.FlagSet, args []string) error {
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return errHelp
		}
		// Never echo flag values: an operator may have pasted a secret by
		// mistake, and flag errors quote their argument.
		return errors.New("invalid flags; run with -h for usage")
	}
	if fs.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	return nil
}

func (a *app) runCredential(ctx context.Context, args []string) error {
	fs := newFlagSet("credential")
	org := fs.String("org", "", "organization id")
	provider := fs.String("provider", "", "provider: aliyun, volcengine, or deepseek")
	mode := fs.String("mode", "managed_key", "credential mode")
	keyVersion := fs.Int("key-version", 1, "credential key version")
	secretFile := fs.String("secret-file", "", "file containing the provider API key")
	actor := fs.String("actor", "", "owner subject performing the change")
	dryRun := fs.Bool("dry-run", false, "validate inputs and print the plan without writing")
	if err := parseFlags(fs, args); err != nil {
		if errors.Is(err, errHelp) {
			fmt.Fprint(a.stdout, usageText)
			return nil
		}
		return err
	}

	orgID, err := validateIdentity("org", *org)
	if err != nil {
		return err
	}
	subject, err := validateIdentity("actor", *actor)
	if err != nil {
		return err
	}
	prov, err := validateProvider(*provider)
	if err != nil {
		return err
	}
	if *mode != "managed_key" {
		return errors.New("-mode must be managed_key: the sealed-secret flow has no role reference for sts_role")
	}
	// work.create_provider_credential has no key_version parameter and always
	// inserts key version 1; rotation is work.rotate_provider_credential.
	if *keyVersion != 1 {
		return errors.New("-key-version must be 1: work.create_provider_credential always creates key version 1; use work.rotate_provider_credential to rotate")
	}
	if strings.TrimSpace(*secretFile) == "" {
		return errors.New("-secret-file is required")
	}
	master, err := a.masterKey()
	if err != nil {
		return err
	}
	databaseURL, err := a.databaseURL()
	if err != nil {
		return err
	}

	plaintext, err := a.readFile(*secretFile)
	if err != nil {
		// Do not echo the path or the underlying error.
		return errors.New("cannot read -secret-file")
	}
	plaintext = bytes.TrimSpace(plaintext)
	if len(plaintext) == 0 {
		return errors.New("-secret-file contains no key material")
	}
	ciphertext, fingerprint, err := credentials.Seal(master, orgID, plaintext)
	if err != nil {
		return errors.New("seal provider credential failed")
	}

	if *dryRun {
		fmt.Fprintln(a.stdout, "dry_run=true")
		fmt.Fprintf(a.stdout, "org=%s\nprovider=%s\nmode=%s\nkey_version=%d\nactor=%s\nfingerprint=%s\n",
			orgID, prov, *mode, *keyVersion, subject, fingerprint)
		return nil
	}

	b, err := a.newBackend(ctx, databaseURL, master)
	if err != nil {
		return mapBackendError(err)
	}
	defer b.Close()

	result, err := b.CreateCredential(ctx,
		workdb.Identity{OrgID: orgID, SubjectID: subject},
		credentialPlan{
			Provider:    prov,
			Mode:        *mode,
			KeyVersion:  *keyVersion,
			Ciphertext:  ciphertext,
			Fingerprint: fingerprint,
		},
	)
	if err != nil {
		return mapBackendError(err)
	}
	// Only the id and fingerprint. The secret is never written anywhere.
	fmt.Fprintf(a.stdout, "credential_id=%s\nfingerprint=%s\n", result.CredentialID, fingerprint)
	return nil
}

func (a *app) runConfig(ctx context.Context, args []string) error {
	fs := newFlagSet("config")
	org := fs.String("org", "", "organization id")
	credentialID := fs.String("credential-id", "", "provider credential id")
	provider := fs.String("provider", "", "provider: aliyun, volcengine, or deepseek")
	model := fs.String("model", "", "model id")
	region := fs.String("region", "", "provider region")
	endpoint := fs.String("endpoint", "", "provider endpoint URL")
	actor := fs.String("actor", "", "owner subject performing the change")
	dryRun := fs.Bool("dry-run", false, "validate inputs and print the plan without writing")
	if err := parseFlags(fs, args); err != nil {
		if errors.Is(err, errHelp) {
			fmt.Fprint(a.stdout, usageText)
			return nil
		}
		return err
	}

	orgID, err := validateIdentity("org", *org)
	if err != nil {
		return err
	}
	subject, err := validateIdentity("actor", *actor)
	if err != nil {
		return err
	}
	prov, err := validateProvider(*provider)
	if err != nil {
		return err
	}
	modelID := strings.TrimSpace(*model)
	if len(modelID) == 0 || len(modelID) > 120 {
		return errors.New("-model must be 1 to 120 bytes")
	}
	regionID := strings.TrimSpace(*region)
	if regionID == "" {
		return errors.New("-region is required")
	}
	endpointURL := strings.TrimSpace(*endpoint)
	if err := validateEndpoint(endpointURL); err != nil {
		return err
	}
	credential := strings.TrimSpace(*credentialID)
	if credential == "" {
		return errors.New("-credential-id is required")
	}
	var parsedCredential pgtype.UUID
	if err := parsedCredential.Scan(credential); err != nil {
		return errors.New("-credential-id must be a UUID")
	}

	master, err := a.masterKey()
	if err != nil {
		return err
	}
	databaseURL, err := a.databaseURL()
	if err != nil {
		return err
	}

	b, err := a.newBackend(ctx, databaseURL, master)
	if err != nil {
		return mapBackendError(err)
	}
	defer b.Close()

	plan := configPlan{
		Provider:     prov,
		Model:        modelID,
		Region:       regionID,
		Endpoint:     endpointURL,
		CredentialID: credential,
	}
	result, err := b.SetConfig(ctx, workdb.Identity{OrgID: orgID, SubjectID: subject}, plan, *dryRun)
	if err != nil {
		return mapBackendError(err)
	}

	if *dryRun {
		fmt.Fprintln(a.stdout, "dry_run=true")
		fmt.Fprintf(a.stdout, "org=%s\nprovider=%s\nmodel=%s\nregion=%s\nendpoint=%s\ncredential_id=%s\ncredential_mode=%s\nactor=%s\n",
			orgID, prov, modelID, regionID, endpointURL, credential, result.CredentialMode, subject)
		return nil
	}
	fmt.Fprintf(a.stdout, "config_id=%s\n", result.ConfigID)
	return nil
}

func (a *app) runStatus(ctx context.Context, args []string) error {
	fs := newFlagSet("status")
	org := fs.String("org", "", "organization id")
	if err := parseFlags(fs, args); err != nil {
		if errors.Is(err, errHelp) {
			fmt.Fprint(a.stdout, usageText)
			return nil
		}
		return err
	}

	orgID, err := validateIdentity("org", *org)
	if err != nil {
		return err
	}
	master, err := a.masterKey()
	if err != nil {
		return err
	}
	databaseURL, err := a.databaseURL()
	if err != nil {
		return err
	}

	b, err := a.newBackend(ctx, databaseURL, master)
	if err != nil {
		return mapStatusError(err)
	}
	defer b.Close()

	resolved, err := b.ResolveProvider(ctx, orgID)
	if err != nil {
		return mapStatusError(err)
	}

	fmt.Fprintf(a.stdout, "provider=%s\nmodel=%s\nmode=%s\nendpoint=%s\n",
		resolved.Provider, resolved.Model, resolved.Mode, resolved.Endpoint)
	switch resolved.Mode {
	case "managed_key":
		// Resolve only succeeds after credentials.Open succeeded, so a non-empty
		// plaintext means the stored ciphertext decrypted for this organization.
		fmt.Fprintf(a.stdout, "secret_decrypts=%t\n", len(resolved.Secret) > 0)
	case "sts_role":
		fmt.Fprintln(a.stdout, "secret_decrypts=n/a")
	default:
		fmt.Fprintln(a.stdout, "secret_decrypts=n/a")
	}
	return nil
}

func validateIdentity(name, value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", fmt.Errorf("-%s is required", name)
	}
	if len(value) > 128 {
		return "", fmt.Errorf("-%s must be at most 128 bytes", name)
	}
	if strings.ContainsRune(value, '\x00') {
		return "", fmt.Errorf("-%s must not contain NUL", name)
	}
	return value, nil
}

func validateProvider(value string) (string, error) {
	switch strings.TrimSpace(value) {
	case "aliyun":
		return "aliyun", nil
	case "volcengine":
		return "volcengine", nil
	case "deepseek":
		return "deepseek", nil
	default:
		return "", errors.New("-provider must be aliyun, volcengine, or deepseek")
	}
}

func validateEndpoint(value string) error {
	if value == "" {
		return errors.New("-endpoint is required")
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return errors.New("-endpoint must be an https URL")
	}
	return nil
}

func (a *app) masterKey() ([]byte, error) {
	value := strings.TrimSpace(a.getenv("WORK_CONTENT_MASTER_KEY"))
	if value == "" {
		return nil, errors.New("WORK_CONTENT_MASTER_KEY is required")
	}
	key, err := content.EncodeMasterKey(value)
	if err != nil {
		return nil, errors.New("WORK_CONTENT_MASTER_KEY must be a 32-byte hex or base64 key")
	}
	return key, nil
}

func (a *app) databaseURL() (string, error) {
	value := strings.TrimSpace(a.getenv("WORK_DATABASE_URL"))
	if value == "" {
		return "", errors.New("WORK_DATABASE_URL is required")
	}
	return value, nil
}

// mapBackendError keeps only enumeration codes produced by the PostgreSQL
// adapter. Arbitrary errors (including a fake or future backend that echoes its
// arguments) become a static failure so key material cannot reach stderr.
func mapBackendError(err error) error {
	if err == nil {
		return nil
	}
	var coded *commandError
	if errors.As(err, &coded) && coded != nil {
		return coded
	}
	return errors.New("provider setup backend failed")
}

func mapStatusError(err error) error {
	if err == nil {
		return nil
	}
	// providerctx.Error carries only an enumeration code.
	var coded *providerctx.Error
	if errors.As(err, &coded) && coded != nil {
		return coded
	}
	return errors.New("provider context unavailable")
}
