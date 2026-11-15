package devicesig

import "github.com/we-meet/work/internal/canonical"

// Canonicalize renders raw JSON as RFC 8785 JCS bytes: object keys sorted by
// UTF-16 code unit order, array order preserved, minimal string escaping, no
// whitespace, UTF-8. It reuses the cross-language-proven R0a canonical codec
// (internal/canonical), whose Encode is byte-identical to the Rust device's
// serde_jcs for the JSON subset device frames use. Device frames carry only
// integers and strings — uint64 fields cross the boundary as decimal strings
// (device-design §3.1) — so the codec's safe-integer/no-float subset is exactly
// the frame contract; a body outside that subset fails closed rather than
// canonicalizing to bytes the device did not sign.
func Canonicalize(raw []byte) ([]byte, error) {
	v, err := canonical.Parse(raw)
	if err != nil {
		return nil, err
	}
	return canonical.Encode(v)
}
