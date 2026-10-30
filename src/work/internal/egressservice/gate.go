package egressservice

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"

	"github.com/we-meet/work/internal/authz"
	"github.com/we-meet/work/internal/egress"
)

// decisionGate adapts one already-taken consume decision to the egress gate
// contract. Consume never calls the authorization service again: the single
// ConsumeByExecution call in the handler is the linearization point, and only
// its Won decision can authorize the send. Attach records the receipt for the
// receipt slot that same decision minted, so the exchange cannot choose a slot
// belonging to another attempt.
type decisionGate struct {
	commands    EgressCommands
	decision    authz.ConsumeDecision
	binding     ExecutionBinding
	requestHash string
}

// Consume returns the handler's decision. As a defensive check it refuses a
// delivery tuple that differs from the derived binding; egress.Exchange then
// stops before the provider call.
func (g *decisionGate) Consume(_ context.Context, delivery egress.DeliveryRequest) (egress.ConsumeDecision, error) {
	if delivery.ExecutionID != g.binding.ExecutionID ||
		delivery.OperationID != g.binding.OperationID ||
		delivery.AttemptID != g.binding.AttemptID ||
		delivery.HolderID != g.binding.HolderID ||
		delivery.RunFence != g.binding.RunFence ||
		delivery.RequestHash != g.requestHash {
		return egress.ConsumeDecision{}, errors.New("egressservice: delivery tuple does not match the derived binding")
	}
	return g.decision, nil
}

// Attach forwards the exchange's receipt coordinates with the decision's
// receipt slot. The provider request id is already part of the request when the
// provider supplied a representable one.
func (g *decisionGate) Attach(ctx context.Context, request authz.ReceiptRequest) error {
	request.ReceiptSlotID = g.decision.ReceiptSlotID
	return g.commands.Attach(ctx, request)
}

// newReferenceID mints one uuid-shaped content-reference id. Answer and
// rejection-evidence ids are allocated by this service and returned to the
// control plane, which registers the kind/object mapping later.
func newReferenceID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16]), nil
}
