// Package dispatch connects the outbox relay to Temporal.
package dispatch

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"strings"

	"go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/client"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/we-meet/work/internal/relay"
)

type TemporalConfig struct {
	Address      string
	Namespace    string
	TaskQueue    string
	WorkflowType string
	CertFile     string
	KeyFile      string
	CAFile       string
	ServerName   string
}

type Temporal struct {
	client       client.Client
	taskQueue    string
	workflowType string
}

type RunWorkflowInput struct {
	RunID string `json:"run_id"`
	OrgID string `json:"org_id"`
}

func NewTemporal(config TemporalConfig) (*Temporal, error) {
	if strings.TrimSpace(config.Address) == "" {
		return nil, errors.New("temporal address is required")
	}
	if strings.TrimSpace(config.Namespace) == "" {
		config.Namespace = "work-r0a"
	}
	if strings.TrimSpace(config.TaskQueue) == "" {
		config.TaskQueue = "work-r0a-run"
	}
	if strings.TrimSpace(config.WorkflowType) == "" {
		config.WorkflowType = "RunWorkflow"
	}
	if config.ServerName == "" {
		config.ServerName = "temporal-server"
	}

	certificate, err := tls.LoadX509KeyPair(config.CertFile, config.KeyFile)
	if err != nil {
		return nil, fmt.Errorf("load temporal client certificate: %w", err)
	}
	caBody, err := os.ReadFile(config.CAFile)
	if err != nil {
		return nil, fmt.Errorf("read temporal CA: %w", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caBody) {
		return nil, errors.New("temporal CA file has no certificates")
	}
	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{certificate},
		RootCAs:      roots,
		ServerName:   config.ServerName,
		MinVersion:   tls.VersionTLS12,
	}

	connection, err := client.Dial(client.Options{
		HostPort:  config.Address,
		Namespace: config.Namespace,
		Identity:  "work-relay",
		ConnectionOptions: client.ConnectionOptions{
			TLS: tlsConfig,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("dial temporal: %w", err)
	}
	return &Temporal{
		client: connection, taskQueue: config.TaskQueue, workflowType: config.WorkflowType,
	}, nil
}

func (t *Temporal) StartWorkflow(ctx context.Context, request relay.StartWorkflowRequest) error {
	options := client.StartWorkflowOptions{
		ID:                                       request.WorkflowID,
		TaskQueue:                                t.taskQueue,
		WorkflowIDReusePolicy:                    enums.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
		WorkflowExecutionErrorWhenAlreadyStarted: true,
	}
	_, err := t.client.ExecuteWorkflow(ctx, options, t.workflowType, RunWorkflowInput{
		RunID: request.RunID, OrgID: request.OrgID,
	})
	if err == nil {
		return nil
	}
	if status.Code(err) == codes.AlreadyExists ||
		strings.Contains(strings.ToLower(err.Error()), "already started") {
		return nil
	}
	return err
}

func (t *Temporal) CancelWorkflow(ctx context.Context, workflowID string) error {
	err := t.client.CancelWorkflow(ctx, workflowID, "")
	if err == nil {
		return nil
	}
	if status.Code(err) == codes.NotFound {
		return relay.ErrWorkflowNotFound
	}
	return err
}

func (t *Temporal) SignalWorkflow(ctx context.Context, workflowID, signalName string, payload any) error {
	err := t.client.SignalWorkflow(ctx, workflowID, "", signalName, payload)
	if err == nil {
		return nil
	}
	if status.Code(err) == codes.NotFound {
		return relay.ErrWorkflowNotFound
	}
	return err
}

func (t *Temporal) Client() client.Client { return t.client }

func (t *Temporal) Close() { t.client.Close() }
