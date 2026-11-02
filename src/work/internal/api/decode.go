package api

import (
	"encoding/json"
	"errors"
	"io"
)

// decodeStrictJSONBody reads exactly one JSON object and nothing after it.
//
// DisallowUnknownFields alone is not enough: a body such as `{"reason":"a"} {"reason":"b"}`
// decodes its first object cleanly and the rest is silently dropped, so the server would
// act on one object while anything that inspected the whole body — a proxy, a log, a
// client bug — saw two. The second Decode therefore has to land on io.EOF; inputs.go
// guarded this correctly while previews.go inverted the condition and accepted trailing
// content anyway.
func decodeStrictJSONBody(body io.Reader, target any) error {
	decoder := json.NewDecoder(body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON")
	}
	return nil
}
