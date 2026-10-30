package canonical

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestParseRejectsIndeterminateInput(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want error
	}{
		{"duplicate key", `{"a":1,"a":2}`, ErrDuplicateKey},
		{"duplicate key after escape decoding", `{"a":1,"\u0061":2}`, ErrDuplicateKey},
		{"duplicate key in nested object", `{"outer":{"b":true,"b":false}}`, ErrDuplicateKey},
		{"duplicate key with different values", `{"revision":0,"revision":1}`, ErrDuplicateKey},
		{"float", `{"a":1.5}`, ErrInvalidNumber},
		{"integral float spelling", `{"a":1.0}`, ErrInvalidNumber},
		{"exponent spelling", `{"a":1e2}`, ErrInvalidNumber},
		{"negative zero", `{"a":-0}`, ErrNegativeZero},
		{"negative zero with fraction", `{"a":-0.0}`, ErrInvalidNumber},
		{"NaN", `{"a":NaN}`, ErrNonFiniteNumber},
		{"Infinity", `{"a":Infinity}`, ErrNonFiniteNumber},
		{"negative Infinity", `{"a":-Infinity}`, ErrNonFiniteNumber},
		{"undefined", `{"a":undefined}`, ErrInvalidValue},
		{"unsafe integer above 2^53", `{"a":9007199254740992}`, ErrInvalidNumber},
		{"unsafe integer below -2^53", `{"a":-9007199254740992}`, ErrInvalidNumber},
		{"int64 overflow", `{"a":92233720368547758070}`, ErrInvalidNumber},
		{"lone high surrogate escape", `{"a":"\ud800"}`, ErrInvalidUnicode},
		{"lone low surrogate escape", `{"a":"\udc00"}`, ErrInvalidUnicode},
		{"high surrogate followed by plain escape", `{"a":"\ud800\u0041"}`, ErrInvalidUnicode},
		{"invalid utf-8 byte", "{\"a\":\"\xff\"}", ErrInvalidUnicode},
		{"truncated utf-8 sequence", "{\"a\":\"\xe4\xb8\"}", ErrInvalidUnicode},
		{"surrogate encoded as utf-8", "{\"a\":\"\xed\xa0\x80\"}", ErrInvalidUnicode},
		{"unescaped control character", "{\"a\":\"line\nbreak\"}", ErrSyntax},
		{"single quoted key", `{'a':1}`, ErrSyntax},
		{"unquoted key", `{a:1}`, ErrSyntax},
		{"trailing comma", `{"a":1,}`, ErrSyntax},
		{"leading zero", `{"a":01}`, ErrSyntax},
		{"plus sign", `{"a":+1}`, ErrSyntax},
		{"comment", `{"a":1}/*x*/`, ErrTrailingData},
		{"two documents", `{"a":1} {"a":2}`, ErrTrailingData},
		{"empty input", ``, ErrSyntax},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Parse([]byte(tc.raw)); !errors.Is(err, tc.want) {
				t.Fatalf("Parse(%q) error = %v, want %v", tc.raw, err, tc.want)
			}
		})
	}
}

// TestEncodingJSONWouldAcceptIndeterminateInput records why this package has
// its own reader: encoding/json silently applies last-key-wins and silently
// rewrites broken Unicode, both of which §8.1 item 1 forbids.
func TestEncodingJSONWouldAcceptIndeterminateInput(t *testing.T) {
	var duplicate struct {
		Revision int64 `json:"revision"`
	}
	if err := json.Unmarshal([]byte(`{"revision":0,"revision":1}`), &duplicate); err != nil {
		t.Fatalf("encoding/json unexpectedly rejected duplicates: %v", err)
	}
	if duplicate.Revision != 1 {
		t.Fatalf("encoding/json revision = %d, expected the last-key-wins value 1", duplicate.Revision)
	}
	if _, err := Parse([]byte(`{"revision":0,"revision":1}`)); !errors.Is(err, ErrDuplicateKey) {
		t.Fatalf("Parse must reject what encoding/json accepted, got %v", err)
	}

	var broken struct {
		A string `json:"a"`
	}
	if err := json.Unmarshal([]byte(`{"a":"\ud800"}`), &broken); err != nil {
		t.Fatalf("encoding/json unexpectedly rejected a lone surrogate: %v", err)
	}
	if broken.A != "\uFFFD" {
		t.Fatalf("encoding/json produced %q, expected the silent U+FFFD replacement", broken.A)
	}
}

func TestParseAcceptsCanonicalInput(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"nested document", `{"b":[1,{"d":null,"c":true}],"a":"x"}`, `{"a":"x","b":[1,{"c":true,"d":null}]}`},
		{"escapes decode then re-encode canonically", `{"a":"\u0041\/\u00e9"}`, `{"a":"A/é"}`},
		{"valid surrogate pair", `{"a":"\ud83d\ude00"}`, `{"a":"😀"}`},
		{"whitespace is dropped", "{\n  \"a\" : [ 1 , 2 ]\t}", `{"a":[1,2]}`},
		{"empty containers", `{"a":[],"b":{}}`, `{"a":[],"b":{}}`},
		{"safe integer bounds", `{"a":9007199254740991,"b":-9007199254740991,"c":0}`, `{"a":9007199254740991,"b":-9007199254740991,"c":0}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v, err := Parse([]byte(tc.raw))
			if err != nil {
				t.Fatalf("Parse(%q) failed: %v", tc.raw, err)
			}
			got, err := Encode(v)
			if err != nil {
				t.Fatalf("Encode failed: %v", err)
			}
			if string(got) != tc.want {
				t.Fatalf("canonical form = %s, want %s", got, tc.want)
			}
		})
	}
}

func TestParseRejectsOversizedRawInput(t *testing.T) {
	filler := strings.Repeat("x", MaxDocumentBytes)
	raw := []byte(`{"a":"` + filler + `"}`)
	if len(raw) <= MaxDocumentBytes {
		t.Fatalf("fixture is not oversized")
	}
	if _, err := Parse(raw); !errors.Is(err, ErrDocumentTooLarge) {
		t.Fatalf("Parse oversized error = %v, want %v", err, ErrDocumentTooLarge)
	}

	fits := []byte(`{"a":"` + strings.Repeat("x", MaxDocumentBytes-8) + `"}`)
	if len(fits) != MaxDocumentBytes {
		t.Fatalf("boundary fixture is %d bytes, want %d", len(fits), MaxDocumentBytes)
	}
	if _, err := Parse(fits); err != nil {
		t.Fatalf("Parse at the %d byte boundary failed: %v", MaxDocumentBytes, err)
	}
}

func TestParseRejectsExcessiveNesting(t *testing.T) {
	deep := strings.Repeat(`[`, maxParseDepth+2) + strings.Repeat(`]`, maxParseDepth+2)
	if _, err := Parse([]byte(deep)); !errors.Is(err, ErrDepthExceeded) {
		t.Fatalf("Parse deeply nested error = %v, want %v", err, ErrDepthExceeded)
	}
}
