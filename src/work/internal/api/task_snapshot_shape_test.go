package api

// D2' fixes the task-detail snapshot to six fields and forbids nine names inside that
// subtree (goal, background, prompt, messages, runtime_version, provider, model,
// checkpoint_ref, request_hash), with additionalProperties and free-form maps both off -
// task_detail_snapshot_shape is one of the five questions its
// openQuestionsResolvedAtSignoff says the re-sign must settle. TaskSnapshot's own shape
// matched that list, and task_detail_test.go:43-56 pins the key sets of the detail,
// summary and latest_run objects, but nothing pinned the snapshot subtree. These tests
// read the Go types, so they need no database.

import (
	"reflect"
	"strings"
	"testing"
)

var d2PrimeSnapshotRequired = []string{
	"snapshot_id", "snapshot_revision", "template", "limits", "permission_mode", "created_at",
}

var d2PrimeSnapshotForbidden = []string{
	"goal", "background", "prompt", "messages", "runtime_version",
	"provider", "model", "checkpoint_ref", "request_hash",
}

type jsonField struct {
	path string
	name string
}

// walkJSONTypes lists the JSON fields of a struct and everything it nests. Pointers,
// slices and arrays are followed to their element; a map is recorded instead of followed,
// because a free-form map is exactly the hole D2' closes with freeFormMapAllowed=false.
// Direct self-reference is refused by the base != typ check; a longer cycle would need a
// visited set, and no request or response type in this package has one today.
func walkJSONTypes(typ reflect.Type, prefix string, fields *[]jsonField, maps *[]string) {
	for typ.Kind() == reflect.Pointer || typ.Kind() == reflect.Slice || typ.Kind() == reflect.Array {
		typ = typ.Elem()
	}
	if typ.Kind() != reflect.Struct {
		return
	}
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		name := strings.Split(field.Tag.Get("json"), ",")[0]
		if name == "" || name == "-" {
			continue
		}
		path := name
		if prefix != "" {
			path = prefix + "." + name
		}
		element := field.Type
		for element.Kind() == reflect.Pointer || element.Kind() == reflect.Slice ||
			element.Kind() == reflect.Array {
			element = element.Elem()
		}
		if element.Kind() == reflect.Map {
			*maps = append(*maps, path)
		} else {
			*fields = append(*fields, jsonField{path: path, name: name})
			if element.Kind() == reflect.Struct && element != typ {
				walkJSONTypes(element, path, fields, maps)
			}
		}
	}
}

func TestTaskSnapshotCarriesExactlyTheDeclaredFields(t *testing.T) {
	var fields []jsonField
	var maps []string
	walkJSONTypes(reflect.TypeOf(TaskSnapshot{}), "", &fields, &maps)

	top := []string{}
	for _, field := range fields {
		if !strings.Contains(field.path, ".") {
			top = append(top, field.name)
		}
	}
	// Both directions: dropping a declared field breaks the client, and adding one moves
	// the published surface without anyone deciding it.
	for _, want := range d2PrimeSnapshotRequired {
		found := false
		for _, got := range top {
			if got == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("TaskSnapshot is missing declared field %q", want)
		}
	}
	for _, got := range top {
		declared := false
		for _, want := range d2PrimeSnapshotRequired {
			if got == want {
				declared = true
				break
			}
		}
		if !declared {
			t.Errorf("TaskSnapshot declares %q, which D2' does not list for the snapshot", got)
		}
	}
}

func TestTaskSnapshotSubtreeNeverCarriesAForbiddenName(t *testing.T) {
	var fields []jsonField
	var maps []string
	walkJSONTypes(reflect.TypeOf(TaskSnapshot{}), "", &fields, &maps)

	for _, field := range fields {
		for _, forbidden := range d2PrimeSnapshotForbidden {
			if field.name == forbidden {
				t.Errorf("snapshot subtree leaks %q at %s; that name is prompt or runtime "+
					"content, and D2' forbids it inside the snapshot", forbidden, field.path)
			}
		}
	}
	// freeFormMapAllowed=false: an untyped map would let any of the names above arrive
	// without ever appearing in a struct declaration, so no key-set test could see it.
	for _, path := range maps {
		t.Errorf("snapshot subtree declares a free-form map at %s; it would carry any field "+
			"D2' forbids without tripping a struct-level check", path)
	}
}
