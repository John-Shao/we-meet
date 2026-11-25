package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	workdb "github.com/we-meet/work/internal/db"
	"github.com/we-meet/work/internal/devicesig"
)

type modelResultUsage struct {
	InputTokens       string `json:"input_tokens"`
	OutputTokens      string `json:"output_tokens"`
	CachedInputTokens string `json:"cached_input_tokens"`
	Estimated         bool   `json:"estimated"`
}

type modelResultBody struct {
	ModelResultID     string            `json:"model_result_id"`
	RunID             string            `json:"run_id"`
	OperationID       string            `json:"operation_id"`
	AttemptID         string            `json:"attempt_id"`
	RequestHash       string            `json:"request_hash"`
	State             string            `json:"state"`
	Outcome           *string           `json:"outcome"`
	ResultHash        *string           `json:"result_hash"`
	ProviderRequestID *string           `json:"provider_request_id"`
	Model             string            `json:"model"`
	Usage             *modelResultUsage `json:"usage"`
	ErrorCode         *string           `json:"error_code"`
	Signature         string            `json:"signature"`
}

var modelResultAckCode = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

func modelResultRejection(err error) (string, bool) {
	var dbErr *workdb.Error
	if errors.As(err, &dbErr) {
		return "", false
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "P0001", "22023", "23505", "42501":
			return pgErr.Message, true
		}
	}
	return "", false
}

func modelResultIdentity(bodyJSON []byte) (string, string, error) {
	var body modelResultBody
	if err := json.Unmarshal(bodyJSON, &body); err != nil {
		return "", "", fmt.Errorf("invalid_request: model_result body")
	}
	for _, id := range []struct{ name, value string }{
		{"model_result_id", body.ModelResultID},
		{"operation_id", body.OperationID},
	} {
		if _, err := uuid.Parse(id.value); err != nil {
			return "", "", fmt.Errorf("invalid_request: model_result %s", id.name)
		}
	}
	return body.ModelResultID, body.OperationID, nil
}

func parseModelResultBody(bodyJSON []byte) (*modelResultBody, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(bodyJSON, &fields); err != nil {
		return nil, fmt.Errorf("invalid_request: model_result body")
	}
	expected := []string{
		"model_result_id", "run_id", "operation_id", "attempt_id", "request_hash",
		"state", "outcome", "result_hash", "provider_request_id", "model", "usage",
		"error_code", "signature",
	}
	if len(fields) != len(expected) {
		return nil, fmt.Errorf("invalid_request: model_result shape")
	}
	for _, key := range expected {
		if _, ok := fields[key]; !ok {
			return nil, fmt.Errorf("invalid_request: model_result shape")
		}
	}
	var body modelResultBody
	if err := json.Unmarshal(bodyJSON, &body); err != nil {
		return nil, fmt.Errorf("invalid_request: model_result body")
	}
	for _, id := range []struct{ name, value string }{
		{"model_result_id", body.ModelResultID}, {"run_id", body.RunID},
		{"operation_id", body.OperationID}, {"attempt_id", body.AttemptID},
	} {
		if _, err := uuid.Parse(id.value); err != nil {
			return nil, fmt.Errorf("invalid_request: model_result %s", id.name)
		}
	}
	if !bareHex64.MatchString(body.RequestHash) || strings.TrimSpace(body.Model) == "" {
		return nil, fmt.Errorf("invalid_request: model_result identity")
	}
	if body.State != "completed" && body.State != "unknown" {
		return nil, fmt.Errorf("invalid_request: model_result state")
	}
	if body.State == "unknown" {
		if body.Outcome != nil || body.ResultHash != nil || body.ProviderRequestID != nil ||
			body.Usage != nil || body.ErrorCode == nil || strings.TrimSpace(*body.ErrorCode) == "" {
			return nil, fmt.Errorf("invalid_request: model_result unknown")
		}
		return &body, nil
	}
	if body.Outcome == nil || (*body.Outcome != "succeeded" && *body.Outcome != "failed") {
		return nil, fmt.Errorf("invalid_request: model_result outcome")
	}
	if *body.Outcome == "failed" {
		if body.ResultHash != nil || body.ProviderRequestID != nil || body.Usage != nil ||
			body.ErrorCode == nil || strings.TrimSpace(*body.ErrorCode) == "" {
			return nil, fmt.Errorf("invalid_request: model_result failed")
		}
		return &body, nil
	}
	if body.ResultHash == nil || !bareHex64.MatchString(*body.ResultHash) ||
		body.Usage == nil || body.ErrorCode != nil {
		return nil, fmt.Errorf("invalid_request: model_result success")
	}
	var usageFields map[string]json.RawMessage
	if err := json.Unmarshal(fields["usage"], &usageFields); err != nil || len(usageFields) != 4 {
		return nil, fmt.Errorf("invalid_request: model_result usage")
	}
	for _, key := range []string{"input_tokens", "output_tokens", "cached_input_tokens", "estimated"} {
		if _, ok := usageFields[key]; !ok {
			return nil, fmt.Errorf("invalid_request: model_result usage")
		}
	}
	input, err := strconv.ParseUint(body.Usage.InputTokens, 10, 63)
	if err != nil {
		return nil, fmt.Errorf("invalid_request: model_result usage")
	}
	if _, err := strconv.ParseUint(body.Usage.OutputTokens, 10, 63); err != nil {
		return nil, fmt.Errorf("invalid_request: model_result usage")
	}
	cached, err := strconv.ParseUint(body.Usage.CachedInputTokens, 10, 63)
	if err != nil || cached > input {
		return nil, fmt.Errorf("invalid_request: model_result usage")
	}
	return &body, nil
}

func (s *Server) handleModelResult(ctx context.Context, stream grpc.ServerStream, orgID, deviceID, sessionID string, pub *devicesig.PublicKey, env *Envelope) error {
	var sig struct {
		Signature string `json:"signature"`
	}
	if err := json.Unmarshal(env.Body, &sig); err != nil || sig.Signature == "" {
		return mapError(fmt.Errorf("invalid_request: model_result signature"))
	}
	if !devicesig.VerifyFrame(pub, "model_result", env.Body, sig.Signature) {
		return status.Error(codes.Unauthenticated, "unauthorized")
	}
	resultID, operationID, err := modelResultIdentity(env.Body)
	if err != nil {
		return mapError(err)
	}
	body, err := parseModelResultBody(env.Body)
	if err != nil {
		return s.sendModelResultAck(stream, deviceID, sessionID, resultID, operationID, "rejected", "invalid_request")
	}
	result, err := s.recordModelResult(ctx, orgID, deviceID, env.Body)
	if err != nil {
		code, permanent := modelResultRejection(err)
		if !permanent {
			return mapError(err)
		}
		if !modelResultAckCode.MatchString(code) {
			code = "service_degraded"
		}
		return s.sendModelResultAck(stream, deviceID, sessionID, resultID, operationID, "rejected", code)
	}
	var recorded struct {
		State         string  `json:"state"`
		Code          *string `json:"code"`
		ModelResultID string  `json:"model_result_id"`
		OperationID   string  `json:"operation_id"`
	}
	if err := json.Unmarshal(result, &recorded); err != nil || recorded.State != "recorded" ||
		recorded.ModelResultID != body.ModelResultID || recorded.OperationID != body.OperationID {
		return status.Error(codes.Internal, "service_degraded")
	}
	if err := s.sendModelResultAck(stream, deviceID, sessionID, resultID, operationID, "recorded", ""); err != nil {
		return err
	}
	return s.pushPendingResolutions(ctx, stream, orgID, deviceID, sessionID)
}

func (s *Server) recordModelResult(ctx context.Context, orgID, deviceID string, body json.RawMessage) (json.RawMessage, error) {
	var raw []byte
	err := workdb.WithWorkerOrgContext(ctx, s.pool, orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT work.record_device_model_result_frame($1, $2::uuid, $3::jsonb)`,
			orgID, deviceID, body,
		).Scan(&raw)
	})
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

func (s *Server) sendModelResultAck(stream grpc.ServerStream, deviceID, sessionID, resultID, operationID, state, code string) error {
	var codeValue any
	if state == "rejected" {
		codeValue = code
	}
	wire, err := json.Marshal(map[string]any{
		"model_result_id": resultID,
		"operation_id":    operationID,
		"state":           state,
		"code":            codeValue,
	})
	if err != nil {
		return status.Error(codes.Internal, "service_degraded")
	}
	body, err := signAckBody(s.serverKey, "model_result_ack", wire)
	if err != nil {
		return status.Error(codes.Internal, "service_degraded")
	}
	env := Envelope{
		SchemaVersion:      2,
		Type:               "model_result_ack",
		MessageID:          newMessageID(),
		DeviceID:           deviceID,
		SessionID:          sessionID,
		RecoveryGeneration: "0",
		Body:               body,
	}
	raw, err := json.Marshal(env)
	if err != nil {
		return status.Error(codes.Internal, "service_degraded")
	}
	return stream.SendMsg(raw)
}
