package canonical

import (
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Parse reads untrusted document bytes into a canonical Value.
//
// It is deliberately not built on encoding/json: that reader keeps the last
// occurrence of a duplicate object key, silently rewrites invalid UTF-8 and
// invalid \u escapes to U+FFFD, and accepts floats. §8.1 item 1 forbids
// "last key wins" for indeterminate input, so duplicate keys, invalid Unicode,
// floats, negative zero, non-finite literals, undefined, trailing data and
// oversized input are all hard rejections here.
func Parse(raw []byte) (Value, error) {
	if len(raw) > MaxDocumentBytes {
		return Value{}, wrapf(ErrDocumentTooLarge, "%d raw bytes exceeds the %d byte limit", len(raw), MaxDocumentBytes)
	}
	p := &parser{src: raw}
	p.skipSpace()
	v, err := p.parseValue(0)
	if err != nil {
		return Value{}, err
	}
	p.skipSpace()
	if p.pos != len(p.src) {
		return Value{}, p.fail(ErrTrailingData, "unexpected byte after the top-level value")
	}
	return v, nil
}

type parser struct {
	src []byte
	pos int
}

func (p *parser) fail(sentinel error, format string, args ...any) error {
	suffix := make([]any, 0, len(args)+1)
	suffix = append(suffix, args...)
	suffix = append(suffix, p.pos)
	return wrapf(sentinel, format+" at offset %d", suffix...)
}

func (p *parser) skipSpace() {
	for p.pos < len(p.src) {
		switch p.src[p.pos] {
		case ' ', '\t', '\n', '\r':
			p.pos++
		default:
			return
		}
	}
}

func (p *parser) literal(word string) bool {
	if strings.HasPrefix(string(p.src[p.pos:]), word) {
		p.pos += len(word)
		return true
	}
	return false
}

func (p *parser) parseValue(depth int) (Value, error) {
	if depth > maxParseDepth {
		return Value{}, p.fail(ErrDepthExceeded, "value nested deeper than %d levels", maxParseDepth)
	}
	if p.pos >= len(p.src) {
		return Value{}, p.fail(ErrSyntax, "unexpected end of input")
	}
	switch c := p.src[p.pos]; {
	case c == 'n':
		if p.literal("null") {
			return NullValue(), nil
		}
		return Value{}, p.fail(ErrSyntax, "invalid literal")
	case c == 't':
		if p.literal("true") {
			return BoolValue(true), nil
		}
		return Value{}, p.fail(ErrSyntax, "invalid literal")
	case c == 'f':
		if p.literal("false") {
			return BoolValue(false), nil
		}
		return Value{}, p.fail(ErrSyntax, "invalid literal")
	case c == 'N':
		if p.literal("NaN") {
			return Value{}, p.fail(ErrNonFiniteNumber, "NaN is not a canonical value")
		}
		return Value{}, p.fail(ErrSyntax, "invalid literal")
	case c == 'I':
		if p.literal("Infinity") {
			return Value{}, p.fail(ErrNonFiniteNumber, "Infinity is not a canonical value")
		}
		return Value{}, p.fail(ErrSyntax, "invalid literal")
	case c == 'u':
		if p.literal("undefined") {
			return Value{}, p.fail(ErrInvalidValue, "undefined is not a canonical value")
		}
		return Value{}, p.fail(ErrSyntax, "invalid literal")
	case c == '"':
		s, err := p.parseString()
		if err != nil {
			return Value{}, err
		}
		return StringValue(s), nil
	case c == '[':
		return p.parseArray(depth)
	case c == '{':
		return p.parseObject(depth)
	case c == '-' || (c >= '0' && c <= '9'):
		if p.literal("-Infinity") {
			return Value{}, p.fail(ErrNonFiniteNumber, "-Infinity is not a canonical value")
		}
		return p.parseNumber()
	default:
		return Value{}, p.fail(ErrSyntax, "unexpected byte %q", string(rune(c)))
	}
}

func (p *parser) parseArray(depth int) (Value, error) {
	p.pos++ // consume '['
	items := []Value{}
	p.skipSpace()
	if p.pos < len(p.src) && p.src[p.pos] == ']' {
		p.pos++
		return ArrayValue(items...), nil
	}
	for {
		p.skipSpace()
		item, err := p.parseValue(depth + 1)
		if err != nil {
			return Value{}, err
		}
		items = append(items, item)
		p.skipSpace()
		if p.pos >= len(p.src) {
			return Value{}, p.fail(ErrSyntax, "unterminated array")
		}
		switch p.src[p.pos] {
		case ',':
			p.pos++
		case ']':
			p.pos++
			return ArrayValue(items...), nil
		default:
			return Value{}, p.fail(ErrSyntax, "expected %q or %q in array", ",", "]")
		}
	}
}

func (p *parser) parseObject(depth int) (Value, error) {
	p.pos++ // consume '{'
	members := []Member{}
	seen := make(map[string]struct{})
	p.skipSpace()
	if p.pos < len(p.src) && p.src[p.pos] == '}' {
		p.pos++
		return ObjectValue(members...), nil
	}
	for {
		p.skipSpace()
		if p.pos >= len(p.src) || p.src[p.pos] != '"' {
			return Value{}, p.fail(ErrSyntax, "expected a quoted object key")
		}
		key, err := p.parseString()
		if err != nil {
			return Value{}, err
		}
		// Duplicate detection runs on the decoded key, so {"a":1,"\u0061":2}
		// is a duplicate too. There is no last-key-wins path.
		if _, dup := seen[key]; dup {
			return Value{}, p.fail(ErrDuplicateKey, "object key %q appears more than once", key)
		}
		seen[key] = struct{}{}
		p.skipSpace()
		if p.pos >= len(p.src) || p.src[p.pos] != ':' {
			return Value{}, p.fail(ErrSyntax, "expected %q after an object key", ":")
		}
		p.pos++
		p.skipSpace()
		value, err := p.parseValue(depth + 1)
		if err != nil {
			return Value{}, err
		}
		members = append(members, Member{Key: key, Value: value})
		p.skipSpace()
		if p.pos >= len(p.src) {
			return Value{}, p.fail(ErrSyntax, "unterminated object")
		}
		switch p.src[p.pos] {
		case ',':
			p.pos++
		case '}':
			p.pos++
			return ObjectValue(members...), nil
		default:
			return Value{}, p.fail(ErrSyntax, "expected %q or %q in object", ",", "}")
		}
	}
}

func (p *parser) parseNumber() (Value, error) {
	start := p.pos
	if p.src[p.pos] == '-' {
		p.pos++
	}
	if p.pos >= len(p.src) {
		return Value{}, p.fail(ErrSyntax, "truncated number")
	}
	switch c := p.src[p.pos]; {
	case c == '0':
		p.pos++
	case c >= '1' && c <= '9':
		for p.pos < len(p.src) && p.src[p.pos] >= '0' && p.src[p.pos] <= '9' {
			p.pos++
		}
	default:
		return Value{}, p.fail(ErrSyntax, "expected a digit in number")
	}
	fractional := false
	if p.pos < len(p.src) && p.src[p.pos] == '.' {
		fractional = true
		p.pos++
		if p.pos >= len(p.src) || p.src[p.pos] < '0' || p.src[p.pos] > '9' {
			return Value{}, p.fail(ErrSyntax, "expected a digit after the decimal point")
		}
		for p.pos < len(p.src) && p.src[p.pos] >= '0' && p.src[p.pos] <= '9' {
			p.pos++
		}
	}
	if p.pos < len(p.src) && (p.src[p.pos] == 'e' || p.src[p.pos] == 'E') {
		fractional = true
		p.pos++
		if p.pos < len(p.src) && (p.src[p.pos] == '+' || p.src[p.pos] == '-') {
			p.pos++
		}
		if p.pos >= len(p.src) || p.src[p.pos] < '0' || p.src[p.pos] > '9' {
			return Value{}, p.fail(ErrSyntax, "expected a digit in the exponent")
		}
		for p.pos < len(p.src) && p.src[p.pos] >= '0' && p.src[p.pos] <= '9' {
			p.pos++
		}
	}
	text := string(p.src[start:p.pos])
	if fractional {
		// 1.0 and 1e2 are integral in value but not canonical input: the
		// canonical form has exactly one spelling per integer.
		return Value{}, p.fail(ErrInvalidNumber, "%s is not an integer literal", text)
	}
	if text == "-0" {
		return Value{}, p.fail(ErrNegativeZero, "negative zero is not a canonical value")
	}
	n, err := strconv.ParseInt(text, 10, 64)
	if err != nil || n > MaxSafeInteger || n < MinSafeInteger {
		return Value{}, p.fail(ErrInvalidNumber, "%s is outside the safe integer range", text)
	}
	return IntValue(n), nil
}

func (p *parser) parseString() (string, error) {
	p.pos++ // consume opening quote
	var sb strings.Builder
	for {
		if p.pos >= len(p.src) {
			return "", p.fail(ErrSyntax, "unterminated string")
		}
		c := p.src[p.pos]
		switch {
		case c == '"':
			p.pos++
			return sb.String(), nil
		case c == '\\':
			p.pos++
			if err := p.parseEscape(&sb); err != nil {
				return "", err
			}
		case c < 0x20:
			return "", p.fail(ErrSyntax, "unescaped control character U+%04X in string", c)
		case c < utf8.RuneSelf:
			sb.WriteByte(c)
			p.pos++
		default:
			r, size := utf8.DecodeRune(p.src[p.pos:])
			if r == utf8.RuneError && size <= 1 {
				return "", p.fail(ErrInvalidUnicode, "string contains an invalid UTF-8 sequence")
			}
			sb.Write(p.src[p.pos : p.pos+size])
			p.pos += size
		}
	}
}

func (p *parser) parseEscape(sb *strings.Builder) error {
	if p.pos >= len(p.src) {
		return p.fail(ErrSyntax, "truncated escape sequence")
	}
	c := p.src[p.pos]
	p.pos++
	switch c {
	case '"', '\\', '/':
		sb.WriteByte(c)
		return nil
	case 'b':
		sb.WriteByte('\b')
		return nil
	case 'f':
		sb.WriteByte('\f')
		return nil
	case 'n':
		sb.WriteByte('\n')
		return nil
	case 'r':
		sb.WriteByte('\r')
		return nil
	case 't':
		sb.WriteByte('\t')
		return nil
	case 'u':
		unit, err := p.parseHex4()
		if err != nil {
			return err
		}
		if utf16.IsSurrogate(rune(unit)) {
			// A high surrogate must be followed by \uDC00..\uDFFF. Anything
			// else is a lone surrogate: the Node reference rejects it through
			// String.prototype.isWellFormed, and encoding/json would have
			// replaced it with U+FFFD.
			if p.pos+1 < len(p.src) && p.src[p.pos] == '\\' && p.src[p.pos+1] == 'u' {
				save := p.pos
				p.pos += 2
				low, err := p.parseHex4()
				if err != nil {
					return err
				}
				if combined := utf16.DecodeRune(rune(unit), rune(low)); combined != utf8.RuneError {
					sb.WriteRune(combined)
					return nil
				}
				p.pos = save
			}
			return p.fail(ErrInvalidUnicode, "lone surrogate U+%04X in string", unit)
		}
		sb.WriteRune(rune(unit))
		return nil
	default:
		return p.fail(ErrSyntax, "unsupported escape %q", "\\"+string(rune(c)))
	}
}

func (p *parser) parseHex4() (uint16, error) {
	if p.pos+4 > len(p.src) {
		return 0, p.fail(ErrSyntax, "truncated \\u escape")
	}
	var unit uint16
	for i := 0; i < 4; i++ {
		c := p.src[p.pos+i]
		var digit uint16
		switch {
		case c >= '0' && c <= '9':
			digit = uint16(c - '0')
		case c >= 'a' && c <= 'f':
			digit = uint16(c-'a') + 10
		case c >= 'A' && c <= 'F':
			digit = uint16(c-'A') + 10
		default:
			return 0, p.fail(ErrSyntax, "invalid hex digit in \\u escape")
		}
		unit = unit<<4 | digit
	}
	p.pos += 4
	return unit, nil
}
