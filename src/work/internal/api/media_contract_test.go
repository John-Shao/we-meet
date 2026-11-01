package api_test

import (
	"encoding/json"
	"net/http"
	"testing"
)

type mediaInputReply struct {
	InputRef    string `json:"input_ref"`
	MediaType   string `json:"media_type"`
	ExpiresAt   string `json:"expires_at"`
	ContentType string `json:"content_type"`
}

// InputCreateRequest enumerates media_type and InputObject requires it back on
// the 201 response; both sides used to be missing, so a contract-legal request
// was refused with 400 and a successful reply omitted a required field.
func TestCreateInputMediaFieldContract(t *testing.T) {
	pool, _ := newBootstrapDB(t, true, true)
	server := newHTTPServerWithContent(t, pool, newTestContentStore(t))
	token := bootstrapCSRF(t, server.URL)

	declined := postInput(t, server.URL, token,
		`{"client_request_id":"input-media-0001","goal":"目标","media_type":"application/pdf"}`)
	assertAPICode(t, declined, http.StatusBadRequest, "invalid_request")

	undeclared := postInput(t, server.URL, token,
		`{"client_request_id":"input-media-0002","goal":"目标"}`)
	if undeclared.StatusCode != http.StatusCreated {
		t.Fatalf("default media status = %d", undeclared.StatusCode)
	}
	var reply mediaInputReply
	if err := json.NewDecoder(undeclared.Body).Decode(&reply); err != nil {
		t.Fatal(err)
	}
	undeclared.Body.Close()
	if reply.MediaType != "text/markdown" || reply.InputRef == "" || reply.ExpiresAt == "" {
		t.Fatalf("default reply = %#v", reply)
	}

	declared := postInput(t, server.URL, token,
		`{"client_request_id":"input-media-0003","goal":"目标","media_type":"text/markdown"}`)
	if declared.StatusCode != http.StatusCreated {
		t.Fatalf("declared media status = %d", declared.StatusCode)
	}
	var declaredReply mediaInputReply
	if err := json.NewDecoder(declared.Body).Decode(&declaredReply); err != nil {
		t.Fatal(err)
	}
	declared.Body.Close()
	if declaredReply.MediaType != "text/markdown" {
		t.Fatalf("declared reply = %#v", declaredReply)
	}
}

// TaskRunRequest declares additionalProperties:false, so an extra key must not
// be silently accepted and forwarded to the domain function.
func TestRetryTaskRejectsUnknownFields(t *testing.T) {
	pool, _ := newBootstrapDB(t, true, true)
	server := newHTTPServerWithContent(t, pool, newTestContentStore(t))
	token := bootstrapCSRF(t, server.URL)

	status, body := retryCall(t, server.URL, token, activeTaskID,
		`{"client_request_id":"retry-unknown-0001","expected_revision":1,`+
			`"target":{"kind":"cloud","profile":"text-v1"},"unexpected":"value"}`)
	// A strict decoder reports the unknown key through the JSON decode error,
	// which the catalog maps to 400 invalid_json.
	if status != http.StatusBadRequest || body["code"] != "invalid_json" {
		t.Fatalf("unknown retry field = %d %#v", status, body)
	}
}
