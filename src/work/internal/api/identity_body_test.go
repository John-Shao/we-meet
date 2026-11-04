package api

// D2' declares org_id, subject_id, role and scopes as fields a request body may never
// carry (identity comes from the verified session and is pushed into the database session
// context). Nothing asserted that on this surface: the refusal was a property of
// decodeStrictJSONBody's DisallowUnknownFields, exercised only as a generic "bad body"
// case. These two tests pin the invariant itself, over every mutation body, without a
// database.

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

var forbiddenIdentityFields = []string{"org_id", "subject_id", "role", "scopes"}

// mutationRequestTypes lists every body type a /work/v1 mutation decodes, by hand: the
// handlers name these types at their decode site. A new request struct is covered only
// once it appears here, and no automated check notices its absence.
func mutationRequestTypes() []any {
	return []any{
		&inputRequest{},
		&previewRequest{},
		&submitRequest{},
		&taskTitleRequest{},
		&acceptanceRequest{},
		&retryTaskRequest{},
		&cancelRunRequest{},
		&artifactVersionCreateRequest{},
		&createAuditExportRequest{},
		&governanceCursorRequest{},
		&localPolicyWriteRequest{},
		&providerRevokeRequest{},
		&providerConfigSetRequest{},
		&providerCredentialCreateRequest{},
		&providerCredentialRotateRequest{},
	}
}

func requestTypeName(t *testing.T, target any) string {
	t.Helper()
	typ := reflect.TypeOf(target)
	if typ.Kind() != reflect.Pointer || typ.Elem().Kind() != reflect.Struct {
		t.Fatalf("%T is not a pointer to a struct", target)
	}
	return typ.Elem().Name()
}

// declaredJSONFields walks one level of struct tags. Embedded structs and non-struct
// kinds beyond that are not present in any mutation body today; if one is added, the
// baseline decode in the sibling test still exercises the real decoder.
func declaredJSONFields(target any) []string {
	fields := []string{}
	typ := reflect.TypeOf(target).Elem()
	for i := 0; i < typ.NumField(); i++ {
		name := strings.Split(typ.Field(i).Tag.Get("json"), ",")[0]
		if name == "" || name == "-" {
			continue
		}
		fields = append(fields, name)
	}
	return fields
}

func TestNoMutationBodyDeclaresAnIdentityField(t *testing.T) {
	for _, target := range mutationRequestTypes() {
		name := requestTypeName(t, target)
		for _, declared := range declaredJSONFields(target) {
			for _, forbidden := range forbiddenIdentityFields {
				if declared == forbidden {
					t.Errorf("%s declares json:%q; identity must come from the session only",
						name, forbidden)
				}
			}
		}
	}
}

func TestMutationBodiesRefuseInjectedIdentityFields(t *testing.T) {
	for _, target := range mutationRequestTypes() {
		name := requestTypeName(t, target)
		baseline, err := json.Marshal(target)
		if err != nil {
			t.Fatalf("%s: marshal baseline body: %v", name, err)
		}
		var fields map[string]any
		if err := json.Unmarshal(baseline, &fields); err != nil {
			t.Fatalf("%s: baseline body is not an object: %v", name, err)
		}
		// Positive control. Without this, a body the decoder rejects no matter what is
		// injected would read as "identity fields are refused" while proving nothing.
		probe := reflect.New(reflect.TypeOf(target).Elem()).Interface()
		if err := decodeStrictJSONBody(strings.NewReader(string(baseline)), probe); err != nil {
			t.Fatalf("%s: its own declared fields fail to decode (%v); the negative case below "+
				"would be a false green", name, err)
		}

		for _, forbidden := range forbiddenIdentityFields {
			canary := "canary-" + forbidden + "-value"
			injected := map[string]any{}
			for key, value := range fields {
				injected[key] = value
			}
			injected[forbidden] = canary
			body, err := json.Marshal(injected)
			if err != nil {
				t.Fatalf("%s: marshal injected body: %v", name, err)
			}
			reject := reflect.New(reflect.TypeOf(target).Elem()).Interface()
			err = decodeStrictJSONBody(strings.NewReader(string(body)), reject)
			if err == nil {
				t.Errorf("%s accepted a body carrying %q; the handler would act on an identity "+
					"the caller asserted rather than the session's", name, forbidden)
				continue
			}
			// The refusal names the offending key but must not echo its value: that is how
			// a title or content fragment ends up in an error string, a log line or a span.
			if strings.Contains(err.Error(), canary) {
				t.Errorf("%s: refusal for %q echoed the rejected value: %v", name, forbidden, err)
			}
		}
	}
}
