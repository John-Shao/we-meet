package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/we-meet/work/internal/apierr"
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

// decodeError maps a strict-decode failure onto the code a client can act on.
//
// An oversized body is not a malformed one. 400 invalid_request tells the client to fix
// its JSON, which no edit can achieve once the body is over the cap; 413
// request_too_large tells it to send less. net/http reports the cap as *http.MaxBytesError
// and json.Decoder passes that error through unchanged, so the two are still separable
// here - every face that used to fold both into invalid_request answered 400 for a body
// it had refused to read to the end.
func decodeError(err error) *apierr.Error {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return apierr.New("request_too_large")
	}
	return apierr.New("invalid_request")
}
