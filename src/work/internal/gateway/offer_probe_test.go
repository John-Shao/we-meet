package gateway

import (
	"encoding/json"
	"testing"
)

func TestRunOfferWireOnlyIncludesProbeMetadataForProbeRuns(t *testing.T) {
	base := pendingOffer{
		RunID: "run", BindingRevision: json.Number("1"), BindingHash: "binding",
		TaskID: "task", DeviceID: "device", SessionID: "session", InputRef: "input",
		InputHash: "input-hash", SnapshotHash: "snapshot", ProfileID: "profile",
		ProfileRevision: json.Number("1"), RuntimeDigest: "runtime", ToolManifestHash: "tools",
		ModelVersion: "model", GrantSet: json.RawMessage(`[]`), StartNonce: "nonce",
		OfferExpiry: "2026-11-16T00:02:00Z",
	}
	ordinary, err := runOfferWire(&base)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := ordinary["probe"]; ok {
		t.Fatalf("ordinary offer contains probe metadata: %#v", ordinary)
	}
	probe := base
	probe.Probe = &probeOffer{BindingID: "binding-id", ProbeID: "probe-id", PreviewHash: "preview", TemplateHash: "template"}
	wire, err := runOfferWire(&probe)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := wire["probe"].(map[string]any)
	if !ok || got["binding_id"] != "binding-id" || got["probe_id"] != "probe-id" ||
		got["preview_hash"] != "preview" || got["template_hash"] != "template" {
		t.Fatalf("probe offer metadata = %#v", wire["probe"])
	}
}
