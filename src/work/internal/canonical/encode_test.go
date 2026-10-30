package canonical

import (
	"encoding/hex"
	"errors"
	"sort"
	"strings"
	"testing"
)

// TestKeyOrderIsUTF16NotByteWise is the divergence case §8.1 item 2 demands:
// keys must sort by UTF-16 code unit, which is what the Node reference model
// produces with Object.keys().sort(). U+10000 is the surrogate pair D800 DC00,
// so it sorts before U+E000 in UTF-16 order, while its UTF-8 encoding
// (F0 90 80 80) sorts after the UTF-8 encoding of U+E000 (EE 80 80).
//
// The expected string was produced by the signed reference model:
//
//	canonicalJson({ '\u{10000}': 1, '\uE000': 2, b: 3, A: 4 })
//	  === '{"A":4,"b":3,"\u{10000}":1,"\uE000":2}'
func TestKeyOrderIsUTF16NotByteWise(t *testing.T) {
	const surrogatePair = "\U00010000" // 𐀀, UTF-16 D800 DC00, UTF-8 F0 90 80 80
	const privateUse = "\uE000"        // UTF-16 E000, UTF-8 EE 80 80

	if strings.Compare(surrogatePair, privateUse) <= 0 {
		t.Fatalf("fixture no longer diverges: Go byte order already places the surrogate pair first")
	}
	if CompareUTF16(surrogatePair, privateUse) >= 0 {
		t.Fatalf("CompareUTF16 must place the surrogate pair before U+E000")
	}

	v := ObjectValue(
		Field(surrogatePair, IntValue(1)),
		Field(privateUse, IntValue(2)),
		Field("b", IntValue(3)),
		Field("A", IntValue(4)),
	)
	got, err := Encode(v)
	if err != nil {
		t.Fatalf("Encode failed: %v", err)
	}
	want := `{"A":4,"b":3,"` + surrogatePair + `":1,"` + privateUse + `":2}`
	if string(got) != want {
		t.Fatalf("canonical form = %s, want %s", got, want)
	}

	byteOrdered := []string{surrogatePair, privateUse, "b", "A"}
	sort.Strings(byteOrdered)
	utf16Ordered := []string{surrogatePair, privateUse, "b", "A"}
	sort.SliceStable(utf16Ordered, func(i, j int) bool { return CompareUTF16(utf16Ordered[i], utf16Ordered[j]) < 0 })
	if byteOrdered[2] == utf16Ordered[2] && byteOrdered[3] == utf16Ordered[3] {
		t.Fatalf("the two orders must differ for this fixture: byte=%q utf16=%q", byteOrdered, utf16Ordered)
	}
}

func TestCompareUTF16(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"", "", 0},
		{"", "a", -1},
		{"a", "", 1},
		{"a", "b", -1},
		{"A", "a", -1},
		{"ab", "abc", -1},
		{"\U00010000", "\uE000", -1},
		{"\uE000", "\U00010000", 1},
		{"\U00010000", "\U00010001", -1},
		{"\uFFFF", "\U00010000", 1},
		{"\u0080", "\u00FF", -1},
		{"model:1", "model:2", -1},
	}
	for _, tc := range cases {
		if got := CompareUTF16(tc.a, tc.b); got != tc.want {
			t.Fatalf("CompareUTF16(%q, %q) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestEncodeShape(t *testing.T) {
	cases := []struct {
		name string
		in   Value
		want string
	}{
		{"recursive key sort with array order kept", ObjectValue(
			Field("z", IntValue(1)),
			Field("a", ArrayValue(StringValue("b"), StringValue("a"))),
		), `{"a":["b","a"],"z":1}`},
		{"nested objects sort independently", ObjectValue(
			Field("outer", ObjectValue(Field("b", NullValue()), Field("a", BoolValue(false)))),
		), `{"outer":{"a":false,"b":null}}`},
		{"no whitespace anywhere", ObjectValue(Field("a", ArrayValue(IntValue(1), IntValue(2)))), `{"a":[1,2]}`},
		{"empty object and array", ObjectValue(Field("a", ArrayValue()), Field("b", ObjectValue())), `{"a":[],"b":{}}`},
		{"string escapes match JSON.stringify", ObjectValue(Field("s", StringValue(
			"\"\\/\b\t\n\v\f\r\x1f\x7f<>&\u2028\u2029"))), "{\"s\":\"\\\"\\\\/\\b\\t\\n\\u000b\\f\\r\\u001f\x7f<>&\u2028\u2029\"}"},
		{"unicode is not normalized or trimmed", ObjectValue(
			Field("nfc", StringValue("\u00e9")),
			Field("nfd", StringValue("e\u0301")),
			Field("padded", StringValue("  x  ")),
		), "{\"nfc\":\"\u00e9\",\"nfd\":\"e\u0301\",\"padded\":\"  x  \"}"},
		{"safe integer bounds", ObjectValue(
			Field("max", IntValue(MaxSafeInteger)),
			Field("min", IntValue(MinSafeInteger)),
			Field("zero", IntValue(0)),
		), `{"max":9007199254740991,"min":-9007199254740991,"zero":0}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Encode(tc.in)
			if err != nil {
				t.Fatalf("Encode failed: %v", err)
			}
			if string(got) != tc.want {
				t.Fatalf("Encode = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestStringEscapingMatchesNodeReferenceBytes pins the canonical string
// escaping to the exact bytes of the signed reference model:
//
//	node --input-type=module -e "
//	  import { canonicalJson } from './runtime-recovery.model.mjs';
//	  const s = String.fromCharCode(0x22,0x5c,0x2f,0x08,0x09,0x0a,0x0b,0x0c,
//	                                0x0d,0x1f,0x7f,0x3c,0x3e,0x26,0x2028,0x2029);
//	  console.log(Buffer.from(canonicalJson({ s }),'utf8').toString('hex'));"
//
// It shows that only ", \ and C0 controls are escaped (lowercase \u00xx where
// there is no short form), while /, DEL, <, >, & and U+2028/U+2029 stay
// verbatim. Go's encoding/json would escape <, >, & and the line separators
// and would therefore produce different hash input.
func TestStringEscapingMatchesNodeReferenceBytes(t *testing.T) {
	const wantHex = "7b2273223a225c225c5c2f5c625c745c6e5c75303030625c665c725c75303031667f3c3e26e280a8e280a9227d"
	v := ObjectValue(Field("s", StringValue("\"\\/\b\t\n\v\f\r\x1f\x7f<>&\u2028\u2029")))
	got, err := Encode(v)
	if err != nil {
		t.Fatalf("Encode failed: %v", err)
	}
	if hex.EncodeToString(got) != wantHex {
		t.Fatalf("escaped bytes = %s\nwant               %s\n(%s)", hex.EncodeToString(got), wantHex, got)
	}
}

func TestEncodeDoesNotConflateDistinctUnicode(t *testing.T) {
	nfc, err := Encode(StringValue("\u00e9"))
	if err != nil {
		t.Fatal(err)
	}
	nfd, err := Encode(StringValue("e\u0301"))
	if err != nil {
		t.Fatal(err)
	}
	if string(nfc) == string(nfd) {
		t.Fatalf("NFC and NFD forms must stay distinct, both encoded to %s", nfc)
	}
}

func TestEncodeRejectsNonCanonicalValues(t *testing.T) {
	cases := []struct {
		name string
		in   Value
		want error
	}{
		{"unsafe integer", IntValue(MaxSafeInteger + 1), ErrInvalidNumber},
		{"unsafe negative integer", IntValue(MinSafeInteger - 1), ErrInvalidNumber},
		{"invalid utf-8 string", StringValue("\xff"), ErrInvalidUnicode},
		{"lone surrogate string", StringValue(string([]byte{0xed, 0xa0, 0x80})), ErrInvalidUnicode},
		{"invalid utf-8 key", ObjectValue(Field("\xff", NullValue())), ErrInvalidUnicode},
		{"duplicate key built in memory", ObjectValue(Field("a", IntValue(1)), Field("a", IntValue(2))), ErrDuplicateKey},
		{"zero value kind", Value{}, ErrInvalidValue},
		{"unsafe integer nested in array", ArrayValue(IntValue(MaxSafeInteger + 1)), ErrInvalidNumber},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Encode(tc.in); !errors.Is(err, tc.want) {
				t.Fatalf("Encode error = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestEncodeIsIdempotentThroughParse(t *testing.T) {
	documents := []Document{testRequest(), testInitialState(), testReceipt()}
	for _, doc := range documents {
		first, err := doc.Canonical()
		if err != nil {
			t.Fatalf("%s canonical failed: %v", doc.DocumentKind(), err)
		}
		reparsed, err := Parse(first)
		if err != nil {
			t.Fatalf("%s reparse failed: %v", doc.DocumentKind(), err)
		}
		second, err := Encode(reparsed)
		if err != nil {
			t.Fatalf("%s re-encode failed: %v", doc.DocumentKind(), err)
		}
		if string(first) != string(second) {
			t.Fatalf("%s canonical form is not idempotent:\n%s\n%s", doc.DocumentKind(), first, second)
		}
	}
}

func TestEncodeIgnoresMemberOrder(t *testing.T) {
	forward := ObjectValue(Field("a", IntValue(1)), Field("b", IntValue(2)), Field("c", IntValue(3)))
	reversed := ObjectValue(Field("c", IntValue(3)), Field("b", IntValue(2)), Field("a", IntValue(1)))
	a, err := Encode(forward)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Encode(reversed)
	if err != nil {
		t.Fatal(err)
	}
	if string(a) != string(b) {
		t.Fatalf("member order changed the canonical form: %s vs %s", a, b)
	}
	if strings.Contains(string(a), " ") {
		t.Fatalf("canonical form must contain no whitespace: %s", a)
	}
}
