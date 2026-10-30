package canonical

import (
	"sort"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"
)

// Kind enumerates the only JSON value kinds the canonical form allows:
// null, bool, string, finite safe integer, array and object (§8.1 item 2).
// Floats, negative zero, NaN/Infinity and undefined have no Kind on purpose.
type Kind uint8

const (
	KindInvalid Kind = iota
	KindNull
	KindBool
	KindString
	KindInt
	KindArray
	KindObject
)

func (k Kind) String() string {
	switch k {
	case KindNull:
		return "null"
	case KindBool:
		return "bool"
	case KindString:
		return "string"
	case KindInt:
		return "integer"
	case KindArray:
		return "array"
	case KindObject:
		return "object"
	default:
		return "invalid"
	}
}

// Member is one object entry. Input order is preserved in the tree so the
// reader can report duplicates and the writer can sort independently of it.
type Member struct {
	Key   string
	Value Value
}

// Value is an immutable canonical JSON value.
type Value struct {
	kind    Kind
	boolean bool
	str     string
	integer int64
	array   []Value
	object  []Member
}

// NullValue returns the JSON null value.
func NullValue() Value { return Value{kind: KindNull} }

// BoolValue returns a JSON boolean.
func BoolValue(b bool) Value { return Value{kind: KindBool, boolean: b} }

// StringValue returns a JSON string. The string is kept byte-exact; Encode
// rejects it later if it is not well-formed UTF-8.
func StringValue(s string) Value { return Value{kind: KindString, str: s} }

// IntValue returns a JSON integer. Encode rejects values outside the safe
// integer range.
func IntValue(i int64) Value { return Value{kind: KindInt, integer: i} }

// ArrayValue returns a JSON array; order is significant and preserved.
func ArrayValue(items ...Value) Value {
	if items == nil {
		items = []Value{}
	}
	return Value{kind: KindArray, array: items}
}

// ObjectValue returns a JSON object. Member order is irrelevant: Encode sorts
// keys by UTF-16 code unit order.
func ObjectValue(members ...Member) Value {
	if members == nil {
		members = []Member{}
	}
	return Value{kind: KindObject, object: members}
}

// Field is shorthand for a Member.
func Field(key string, value Value) Member { return Member{Key: key, Value: value} }

// Kind reports the value kind.
func (v Value) Kind() Kind { return v.kind }

// Bool returns the boolean payload.
func (v Value) Bool() bool { return v.boolean }

// Str returns the string payload.
func (v Value) Str() string { return v.str }

// Int returns the integer payload.
func (v Value) Int() int64 { return v.integer }

// Items returns the array elements.
func (v Value) Items() []Value { return v.array }

// Members returns the object members in input order.
func (v Value) Members() []Member { return v.object }

// Lookup returns the first member with the given key. A well-formed parsed
// document never has a second one, because Parse rejects duplicate keys.
func (v Value) Lookup(key string) (Value, bool) {
	if v.kind != KindObject {
		return Value{}, false
	}
	for _, m := range v.object {
		if m.Key == key {
			return m.Value, true
		}
	}
	return Value{}, false
}

// CompareUTF16 orders two strings by UTF-16 code unit sequence, which is what
// JavaScript's Array.prototype.sort does for default string comparison and
// therefore what runtime-recovery.model.mjs produces.
//
// This is NOT Go's byte-wise string order. A code point >= U+10000 is a
// surrogate pair starting at U+D800..U+DBFF, so it sorts BEFORE U+E000..U+FFFF
// in UTF-16 order, while its UTF-8 encoding (0xF0...) sorts AFTER the UTF-8
// encoding of U+E000 (0xEE...). Using Go's default order would make the Go
// control plane disagree with the Node runtime on such keys.
func CompareUTF16(a, b string) int {
	au := utf16.Encode([]rune(a))
	bu := utf16.Encode([]rune(b))
	n := len(au)
	if len(bu) < n {
		n = len(bu)
	}
	for i := 0; i < n; i++ {
		if au[i] != bu[i] {
			if au[i] < bu[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(au) < len(bu):
		return -1
	case len(au) > len(bu):
		return 1
	default:
		return 0
	}
}

// Encode renders the canonical JSON form: object keys sorted by UTF-16 code
// unit order, array order preserved, strings byte-exact, no whitespace, UTF-8.
func Encode(v Value) ([]byte, error) {
	buf, err := appendValue(make([]byte, 0, 256), v, 0)
	if err != nil {
		return nil, err
	}
	return buf, nil
}

func appendValue(dst []byte, v Value, depth int) ([]byte, error) {
	if depth > maxParseDepth {
		return nil, wrapf(ErrDepthExceeded, "value nested deeper than %d levels", maxParseDepth)
	}
	switch v.kind {
	case KindNull:
		return append(dst, "null"...), nil
	case KindBool:
		if v.boolean {
			return append(dst, "true"...), nil
		}
		return append(dst, "false"...), nil
	case KindString:
		return appendString(dst, v.str)
	case KindInt:
		if v.integer > MaxSafeInteger || v.integer < MinSafeInteger {
			return nil, wrapf(ErrInvalidNumber, "%d is outside the safe integer range", v.integer)
		}
		return strconv.AppendInt(dst, v.integer, 10), nil
	case KindArray:
		dst = append(dst, '[')
		for i, item := range v.array {
			if i > 0 {
				dst = append(dst, ',')
			}
			var err error
			if dst, err = appendValue(dst, item, depth+1); err != nil {
				return nil, err
			}
		}
		return append(dst, ']'), nil
	case KindObject:
		order := make([]int, len(v.object))
		keys := make([][]uint16, len(v.object))
		for i, m := range v.object {
			if !wellFormed(m.Key) {
				return nil, wrapf(ErrInvalidUnicode, "object key is not well-formed UTF-8")
			}
			order[i] = i
			keys[i] = utf16.Encode([]rune(m.Key))
		}
		sort.SliceStable(order, func(x, y int) bool {
			return compareCodeUnits(keys[order[x]], keys[order[y]]) < 0
		})
		dst = append(dst, '{')
		for position, index := range order {
			if position > 0 {
				if v.object[order[position-1]].Key == v.object[index].Key {
					return nil, wrapf(ErrDuplicateKey, "object key %q appears more than once", v.object[index].Key)
				}
				dst = append(dst, ',')
			}
			var err error
			if dst, err = appendString(dst, v.object[index].Key); err != nil {
				return nil, err
			}
			dst = append(dst, ':')
			if dst, err = appendValue(dst, v.object[index].Value, depth+1); err != nil {
				return nil, err
			}
		}
		return append(dst, '}'), nil
	default:
		return nil, wrapf(ErrInvalidValue, "value kind %s cannot be canonicalized", v.kind)
	}
}

func compareCodeUnits(a, b []uint16) int {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		if a[i] != b[i] {
			if a[i] < b[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(a) < len(b):
		return -1
	case len(a) > len(b):
		return 1
	default:
		return 0
	}
}

// wellFormed reports whether s is valid UTF-8 without surrogate code points.
// utf8.ValidString already rejects CESU-8 style surrogate encodings.
func wellFormed(s string) bool { return utf8.ValidString(s) }

const hexDigits = "0123456789abcdef"

// appendString writes a JSON string exactly as JSON.stringify would: only
// the quote, the backslash and C0 control characters are escaped, with the
// short forms where they exist and lowercase \u00xx otherwise. Everything
// else, including U+2028/U+2029 and all non-ASCII text, is emitted verbatim
// as UTF-8. Go's encoding/json would additionally escape <, >, & and the line
// separators, which would not match the Node reference bytes.
func appendString(dst []byte, s string) ([]byte, error) {
	if !wellFormed(s) {
		return nil, wrapf(ErrInvalidUnicode, "string is not well-formed UTF-8")
	}
	dst = append(dst, '"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '"':
			dst = append(dst, '\\', '"')
		case c == '\\':
			dst = append(dst, '\\', '\\')
		case c >= 0x20:
			dst = append(dst, c)
		default:
			switch c {
			case '\b':
				dst = append(dst, '\\', 'b')
			case '\t':
				dst = append(dst, '\\', 't')
			case '\n':
				dst = append(dst, '\\', 'n')
			case '\f':
				dst = append(dst, '\\', 'f')
			case '\r':
				dst = append(dst, '\\', 'r')
			default:
				dst = append(dst, '\\', 'u', '0', '0', hexDigits[c>>4], hexDigits[c&0x0f])
			}
		}
	}
	return append(dst, '"'), nil
}
