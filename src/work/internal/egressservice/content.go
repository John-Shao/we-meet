package egressservice

import (
	"context"
	"errors"

	"github.com/we-meet/work/internal/canonical"
	"github.com/we-meet/work/internal/contentref"
)

// readReference resolves one reference for the presented execution, reads the
// object through the Content Store and verifies the bytes against both the
// registry row and the reference's own hash form.
//
// A missing, tombstoned, foreign-organization or unbound reference is the same
// 404 answer so a tombstone cannot be used to probe old content. A reference
// of another kind is refused as a kind mismatch, and bytes that do not match
// the registered hash/size are an integrity failure. Model-request and receipt
// objects carry the domain-prefixed document hash; input, template and answer
// bodies carry the plain UTF-8 SHA-256.
func (s *Server) readReference(
	ctx context.Context, orgID, executionID, refID string, want contentref.Kind,
) (contentref.Reference, []byte, error) {
	reference, err := s.references.Resolve(ctx, orgID, refID)
	if errors.Is(err, contentref.ErrNotFound) {
		return contentref.Reference{}, nil, errReferenceNotFound
	}
	if err != nil {
		return contentref.Reference{}, nil, errReferenceUnavailable
	}
	if reference.RefID != refID || reference.OrgID != orgID {
		return contentref.Reference{}, nil, errReferenceNotFound
	}
	if reference.ExecutionID == "" || reference.ExecutionID != executionID {
		return contentref.Reference{}, nil, errReferenceNotFound
	}
	if reference.Kind != want {
		return contentref.Reference{}, nil, errReferenceKindMismatch
	}

	body, err := s.store.Get(ctx, orgID, reference.ContentRef)
	if err != nil {
		return contentref.Reference{}, nil, errContentUnavailable
	}
	if int64(len(body)) != reference.Bytes {
		return contentref.Reference{}, nil, errContentIntegrity
	}
	hash, err := referenceHash(want, body)
	if err != nil || hash != reference.ContentHash {
		return contentref.Reference{}, nil, errContentIntegrity
	}
	return reference, body, nil
}

// referenceHash computes the hash form the signed schema assigns to one kind.
func referenceHash(kind contentref.Kind, body []byte) (string, error) {
	switch kind {
	case contentref.KindModelRequest, contentref.KindReceipt:
		return canonical.HashDocumentBytes(body)
	default:
		return canonical.BodyHash(body)
	}
}

// loadModelRequest resolves and verifies the frozen model_request document.
// The bytes hash must equal the registry hash and the hash presented on the
// thin wire; a different hash is refused before anything is consumed. The
// document is then parsed with the canonical reader, which re-applies the
// schema and structural rules (logical-key ordering, prior-receipt count,
// route and parameter domains).
func (s *Server) loadModelRequest(
	ctx context.Context, orgID, executionID, requestRef, requestHash string,
) (canonical.ModelRequest, string, error) {
	reference, body, err := s.readReference(ctx, orgID, executionID, requestRef, contentref.KindModelRequest)
	if err != nil {
		return canonical.ModelRequest{}, "", err
	}
	if reference.ContentHash != requestHash {
		return canonical.ModelRequest{}, "", errRequestHashMismatch
	}
	document, err := canonical.ParseModelRequest(body)
	if err != nil {
		return canonical.ModelRequest{}, "", errModelRequestInvalid
	}
	if document.Binding.OrgID != orgID {
		return canonical.ModelRequest{}, "", errRequestBindingMismatch
	}
	hash, err := document.Hash()
	if err != nil || hash != reference.ContentHash {
		return canonical.ModelRequest{}, "", errContentIntegrity
	}
	return document, hash, nil
}

// assembleMessages resolves the document's input, template and prior-receipt
// graph and builds the deterministic message sequence documented in the
// package comment. Every object is read through the registry and verified
// against the hash the frozen document names.
func (s *Server) assembleMessages(
	ctx context.Context, orgID, executionID string, document canonical.ModelRequest,
) (assembled, error) {
	inputReference, input, err := s.readReference(
		ctx, orgID, executionID, document.Input.RefID, contentref.KindInput)
	if err != nil {
		return assembled{}, err
	}
	if inputReference.ContentHash != document.Input.Hash {
		return assembled{}, errContentIntegrity
	}

	var (
		template    []byte
		hasTemplate bool
	)
	if document.Template != nil {
		templateReference, templateBody, err := s.readReference(
			ctx, orgID, executionID, document.Template.RefID, contentref.KindTemplate)
		if err != nil {
			return assembled{}, err
		}
		if templateReference.ContentHash != document.Template.Hash {
			return assembled{}, errContentIntegrity
		}
		template, hasTemplate = templateBody, true
	}

	priorAnswers := make([][]byte, 0, len(document.PriorReceipts))
	for _, entry := range document.PriorReceipts {
		receiptReference, receiptBody, err := s.readReference(
			ctx, orgID, executionID, entry.RefID, contentref.KindReceipt)
		if err != nil {
			return assembled{}, err
		}
		if receiptReference.ContentHash != entry.Hash {
			return assembled{}, errContentIntegrity
		}
		receipt, err := canonical.ParseModelReceipt(receiptBody)
		if err != nil {
			return assembled{}, errContentIntegrity
		}
		if receipt.ExecutionID != executionID {
			return assembled{}, errRequestBindingMismatch
		}
		// Only a trusted succeeded receipt points at a public answer. A
		// rejected or unknown step has no assistant text to append.
		if receipt.Outcome != canonical.OutcomeSucceeded || receipt.Content == nil {
			return assembled{}, errPriorReceiptUnusable
		}
		answerReference, answer, err := s.readReference(
			ctx, orgID, executionID, receipt.Content.RefID, contentref.KindAnswer)
		if err != nil {
			return assembled{}, err
		}
		if answerReference.ContentHash != receipt.Content.Hash ||
			receipt.ContentBytes != int64(len(answer)) {
			return assembled{}, errContentIntegrity
		}
		priorAnswers = append(priorAnswers, answer)
	}

	return assemble(template, hasTemplate, input, priorAnswers)
}
