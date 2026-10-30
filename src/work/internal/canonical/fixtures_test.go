package canonical

// Fixtures mirror docs/plan/assets/work-r0a-orchestration-2026-10-25/
// runtime-recovery.test.mjs so Go and the signed Node reference model can be
// compared on identical documents.

func testUUID(n int) string {
	digits := "000000000000"
	s := ""
	for v := n; v > 0; v /= 10 {
		s = string(rune('0'+v%10)) + s
	}
	if len(s) > len(digits) {
		panic("fixture index too large")
	}
	return "00000000-0000-4000-8000-" + digits[:len(digits)-len(s)] + s
}

func testHash(c byte) string {
	hex := make([]byte, 64)
	for i := range hex {
		hex[i] = c
	}
	return "sha256:" + string(hex)
}

func testRef(n int) Reference {
	return Reference{RefID: testUUID(n), Hash: testHash('a')}
}

func testBinding() Binding {
	return Binding{
		OrgID:          "org_1",
		TaskID:         testUUID(1),
		RunID:          testUUID(2),
		SnapshotID:     testUUID(3),
		RuntimeVersion: "pi-1.4.0-build1",
	}
}

func testRequest() ModelRequest {
	return ModelRequest{
		Binding:       testBinding(),
		LogicalKey:    LogicalKey1,
		Input:         testRef(4),
		Template:      Ref(testRef(5)),
		PriorReceipts: nil,
		Route: Route{
			Provider:             ProviderAliyun,
			Model:                "qwen-text",
			ConfigRevision:       "1",
			CompatProfileVersion: "v1",
		},
		Parameters: Parameters{MaxOutputTokens: 2048, TemperatureMilli: 500, OutputFormat: OutputFormatMarkdown},
	}
}

func testInitialState() CanonicalState {
	return CanonicalState{
		Binding:           testBinding(),
		Revision:          0,
		Previous:          nil,
		WriterExecutionID: testUUID(7),
		Input:             testRef(4),
		Template:          Ref(testRef(5)),
		CompletedModels:   nil,
		Phase:             PhaseReady,
		Pending:           nil,
		Artifact:          nil,
	}
}

func testReceipt() ModelReceipt {
	requestHash, err := testRequest().Hash()
	if err != nil {
		panic(err)
	}
	return ModelReceipt{
		ReceiptID:         testUUID(8),
		Binding:           testBinding(),
		LogicalKey:        LogicalKey1,
		OperationID:       testUUID(9),
		DispatchAttemptID: testUUID(10),
		ExecutionID:       testUUID(7),
		RequestHash:       requestHash,
		WriterGatewayID:   testUUID(11),
		RecordedAtUnixMs:  1800000000000,
		Outcome:           OutcomeSucceeded,
		ProviderRequestID: String("req-1"),
		Content:           Ref(testRef(12)),
		ContentBytes:      32,
		Usage: Usage{
			Source:            UsageProvider,
			InputTokens:       Int64(20),
			OutputTokens:      Int64(10),
			CachedInputTokens: Int64(0),
		},
		RejectionEvidence: nil,
	}
}

func testCompletedModel(index int) CompletedModel {
	key, err := LogicalKeyAt(index)
	if err != nil {
		panic(err)
	}
	requestHash, err := testRequest().Hash()
	if err != nil {
		panic(err)
	}
	return CompletedModel{LogicalKey: key, RequestHash: requestHash, Receipt: testRef(20 + index)}
}
