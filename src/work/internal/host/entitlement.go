package host

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/we-meet/work/internal/devicesig"
)

const (
	executionEntitlementApplyPath = "/work-host/v3/organizations/%s/work-entitlement-commands"
	executionEntitlementGetPath   = "/work-host/v3/work-entitlement-commands/%s"
	maxEntitlementResponseBytes   = 16 << 10
)

var executionEntitlementReceiptKeys = []string{
	"command_id", "org_id", "status", "payload_hash", "enabled", "seat_limit",
	"operator_suspended", "revision", "occupied_seats", "applied_at",
}

type ExecutionEntitlementCommand struct {
	CommandID                   string
	OrgID                       string
	ExpectedEntitlementRevision int64
	TargetEntitlementRevision   int64
	Enabled                     bool
	SeatLimit                   int
	OperatorSuspended           bool
	OperatorAuthorizationRef    string
}

type ExecutionEntitlementReceipt struct {
	CommandID         string
	OrgID             string
	Status            string
	PayloadHash       string
	Enabled           bool
	SeatLimit         int
	OperatorSuspended bool
	Revision          int64
	OccupiedSeats     int
	AppliedAt         time.Time
}

func (c *Client) ApplyExecutionEntitlement(
	ctx context.Context,
	command ExecutionEntitlementCommand,
	correlationID string,
) (ExecutionEntitlementReceipt, error) {
	body, payloadHash, err := command.requestBody()
	if err != nil {
		return ExecutionEntitlementReceipt{}, err
	}
	path := fmt.Sprintf(executionEntitlementApplyPath, url.PathEscape(command.OrgID))
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return ExecutionEntitlementReceipt{}, newError("entitlement_unavailable", "build Host entitlement request", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	if correlationID != "" {
		request.Header.Set("X-Work-Request-ID", correlationID)
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return ExecutionEntitlementReceipt{}, newError("entitlement_unavailable", "call Host entitlement command", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return ExecutionEntitlementReceipt{}, entitlementStatusError(response)
	}
	receipt, err := decodeExecutionEntitlementReceipt(response.Body)
	if err != nil {
		return ExecutionEntitlementReceipt{}, err
	}
	if receipt.CommandID != command.CommandID || receipt.OrgID != command.OrgID ||
		receipt.PayloadHash != payloadHash || receipt.Enabled != command.Enabled ||
		receipt.SeatLimit != command.SeatLimit || receipt.OperatorSuspended != command.OperatorSuspended ||
		receipt.Revision != command.TargetEntitlementRevision {
		return ExecutionEntitlementReceipt{}, newError("entitlement_protocol_invalid", "Host entitlement receipt does not match the command", nil)
	}
	return receipt, nil
}

func (c *Client) GetExecutionEntitlementCommand(
	ctx context.Context,
	commandID string,
	correlationID string,
) (ExecutionEntitlementReceipt, error) {
	if _, err := uuid.Parse(commandID); err != nil {
		return ExecutionEntitlementReceipt{}, newError("invalid_request", "command_id must be a UUID", err)
	}
	path := fmt.Sprintf(executionEntitlementGetPath, url.PathEscape(commandID))
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return ExecutionEntitlementReceipt{}, newError("entitlement_unavailable", "build Host entitlement query", err)
	}
	request.Header.Set("Accept", "application/json")
	if correlationID != "" {
		request.Header.Set("X-Work-Request-ID", correlationID)
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return ExecutionEntitlementReceipt{}, newError("entitlement_unavailable", "query Host entitlement command", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return ExecutionEntitlementReceipt{}, newError("command_not_found", "Host entitlement command was not found", nil)
	}
	if response.StatusCode != http.StatusOK {
		return ExecutionEntitlementReceipt{}, entitlementStatusError(response)
	}
	receipt, err := decodeExecutionEntitlementReceipt(response.Body)
	if err != nil {
		return ExecutionEntitlementReceipt{}, err
	}
	if receipt.CommandID != commandID || receipt.Status != "applied" {
		return ExecutionEntitlementReceipt{}, newError("entitlement_protocol_invalid", "Host entitlement query returned another command", nil)
	}
	return receipt, nil
}

func (command ExecutionEntitlementCommand) requestBody() ([]byte, string, error) {
	if _, err := uuid.Parse(command.OrgID); err != nil {
		return nil, "", newError("invalid_request", "org_id must be a UUID", err)
	}
	if _, err := uuid.Parse(command.CommandID); err != nil {
		return nil, "", newError("invalid_request", "command_id must be a UUID", err)
	}
	if command.ExpectedEntitlementRevision < 0 || command.TargetEntitlementRevision < 1 ||
		command.TargetEntitlementRevision <= command.ExpectedEntitlementRevision {
		return nil, "", newError("invalid_request", "entitlement revisions must be non-negative and strictly increasing", nil)
	}
	if command.SeatLimit < 1 {
		return nil, "", newError("invalid_request", "seat_limit must be positive", nil)
	}
	authorizationRef := strings.TrimSpace(command.OperatorAuthorizationRef)
	if authorizationRef == "" || len(authorizationRef) > 200 {
		return nil, "", newError("invalid_request", "operator_authorization_ref must be between 1 and 200 bytes", nil)
	}
	payload := map[string]any{
		"org_id":                        command.OrgID,
		"expected_entitlement_revision": command.ExpectedEntitlementRevision,
		"target_entitlement_revision":   command.TargetEntitlementRevision,
		"enabled":                       command.Enabled,
		"seat_limit":                    command.SeatLimit,
		"operator_suspended":            command.OperatorSuspended,
		"operator_authorization_ref":    authorizationRef,
	}
	rawPayload, err := json.Marshal(payload)
	if err != nil {
		return nil, "", newError("invalid_request", "encode Host entitlement payload", err)
	}
	canonicalPayload, err := devicesig.Canonicalize(rawPayload)
	if err != nil {
		return nil, "", newError("invalid_request", "canonicalize Host entitlement payload", err)
	}
	digest := sha256.Sum256(canonicalPayload)
	payloadHash := "sha256:" + hex.EncodeToString(digest[:])
	body := map[string]any{
		"command_id":                    command.CommandID,
		"expected_entitlement_revision": command.ExpectedEntitlementRevision,
		"target_entitlement_revision":   command.TargetEntitlementRevision,
		"enabled":                       command.Enabled,
		"seat_limit":                    command.SeatLimit,
		"operator_suspended":            command.OperatorSuspended,
		"operator_authorization_ref":    authorizationRef,
		"payload_hash":                  payloadHash,
	}
	rawBody, err := json.Marshal(body)
	if err != nil {
		return nil, "", newError("invalid_request", "encode Host entitlement command", err)
	}
	return rawBody, payloadHash, nil
}

func decodeExecutionEntitlementReceipt(body io.Reader) (ExecutionEntitlementReceipt, error) {
	raw, err := io.ReadAll(io.LimitReader(body, maxEntitlementResponseBytes+1))
	if err != nil {
		return ExecutionEntitlementReceipt{}, newError("entitlement_protocol_invalid", "read Host entitlement response", err)
	}
	if len(raw) > maxEntitlementResponseBytes {
		return ExecutionEntitlementReceipt{}, newError("entitlement_protocol_invalid", "Host entitlement response exceeds the size limit", nil)
	}
	if err := rejectDuplicateJSONKeys(raw); err != nil {
		return ExecutionEntitlementReceipt{}, newError("entitlement_protocol_invalid", "Host entitlement JSON has duplicate keys", err)
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil || len(object) != len(executionEntitlementReceiptKeys) {
		return ExecutionEntitlementReceipt{}, newError("entitlement_protocol_invalid", "Host entitlement response is not a closed object", err)
	}
	for _, key := range executionEntitlementReceiptKeys {
		if _, ok := object[key]; !ok {
			return ExecutionEntitlementReceipt{}, newError("host_field_gap", "Host entitlement response is missing "+key, nil)
		}
	}
	var wire struct {
		CommandID         *string `json:"command_id"`
		OrgID             *string `json:"org_id"`
		Status            *string `json:"status"`
		PayloadHash       *string `json:"payload_hash"`
		Enabled           *bool   `json:"enabled"`
		SeatLimit         *int    `json:"seat_limit"`
		OperatorSuspended *bool   `json:"operator_suspended"`
		Revision          *int64  `json:"revision"`
		OccupiedSeats     *int    `json:"occupied_seats"`
		AppliedAt         *string `json:"applied_at"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		return ExecutionEntitlementReceipt{}, newError("entitlement_protocol_invalid", "decode Host entitlement response", err)
	}
	if wire.CommandID == nil || wire.OrgID == nil || wire.Status == nil || wire.PayloadHash == nil ||
		wire.Enabled == nil || wire.SeatLimit == nil || wire.OperatorSuspended == nil ||
		wire.Revision == nil || wire.OccupiedSeats == nil || wire.AppliedAt == nil {
		return ExecutionEntitlementReceipt{}, newError("host_field_gap", "Host entitlement response has a null required field", nil)
	}
	if _, err := uuid.Parse(*wire.CommandID); err != nil {
		return ExecutionEntitlementReceipt{}, newError("entitlement_protocol_invalid", "Host entitlement command_id is not a UUID", err)
	}
	if _, err := uuid.Parse(*wire.OrgID); err != nil {
		return ExecutionEntitlementReceipt{}, newError("entitlement_protocol_invalid", "Host entitlement org_id is not a UUID", err)
	}
	if *wire.Status != "applied" && *wire.Status != "replayed" {
		return ExecutionEntitlementReceipt{}, newError("entitlement_protocol_invalid", "Host entitlement status is not allowed", nil)
	}
	if !governancePayloadHashRE.MatchString(*wire.PayloadHash) {
		return ExecutionEntitlementReceipt{}, newError("entitlement_protocol_invalid", "Host entitlement payload_hash is invalid", nil)
	}
	if *wire.SeatLimit < 1 || *wire.Revision < 1 || *wire.OccupiedSeats < 0 {
		return ExecutionEntitlementReceipt{}, newError("entitlement_protocol_invalid", "Host entitlement numeric fields are invalid", nil)
	}
	appliedAt, err := time.Parse(time.RFC3339Nano, *wire.AppliedAt)
	if err != nil {
		return ExecutionEntitlementReceipt{}, newError("entitlement_protocol_invalid", "Host entitlement applied_at is not RFC3339", err)
	}
	return ExecutionEntitlementReceipt{
		CommandID: *wire.CommandID, OrgID: *wire.OrgID, Status: *wire.Status,
		PayloadHash: *wire.PayloadHash, Enabled: *wire.Enabled, SeatLimit: *wire.SeatLimit,
		OperatorSuspended: *wire.OperatorSuspended, Revision: *wire.Revision,
		OccupiedSeats: *wire.OccupiedSeats, AppliedAt: appliedAt,
	}, nil
}

func entitlementStatusError(response *http.Response) error {
	if response.StatusCode == http.StatusConflict || response.StatusCode == http.StatusUnprocessableEntity {
		raw, err := io.ReadAll(io.LimitReader(response.Body, 4096))
		if err == nil {
			var wire struct {
				Code *string `json:"code"`
			}
			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.DisallowUnknownFields()
			if decoder.Decode(&wire) == nil && wire.Code != nil {
				switch *wire.Code {
				case "idempotency_key_conflict", "governance_revision_conflict":
					return newError(*wire.Code, "Host rejected the entitlement command", nil)
				case "invalid_request":
					return newError("invalid_request", "Host rejected the entitlement command", nil)
				}
			}
		}
	}
	switch response.StatusCode {
	case http.StatusForbidden:
		return newError("client_identity_invalid", "Host rejected the operator identity", nil)
	case http.StatusNotFound:
		return newError("org_not_found", "Host entitlement organization was not found", nil)
	case http.StatusConflict:
		return newError("governance_revision_conflict", "Host rejected the entitlement revision or payload", nil)
	case http.StatusUnprocessableEntity:
		return newError("invalid_request", "Host rejected the entitlement command", nil)
	default:
		return newError("entitlement_unavailable", fmt.Sprintf("Host entitlement returned status %d", response.StatusCode), nil)
	}
}
