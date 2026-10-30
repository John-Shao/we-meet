package egressservice

import (
	"strings"
	"testing"

	"github.com/we-meet/work/internal/canonical"
)

func requireRoles(t *testing.T, messages []message, roles ...string) {
	t.Helper()
	if len(messages) != len(roles) {
		t.Fatalf("message count = %d, want %d (%+v)", len(messages), len(roles), messages)
	}
	for i, role := range roles {
		if messages[i].Role != role {
			t.Fatalf("message[%d].role = %q, want %q", i, messages[i].Role, role)
		}
	}
}

func TestAssembleMessagesOrderAndText(t *testing.T) {
	template := []byte("system template text")
	input := []byte("user input text")
	prior := [][]byte{[]byte("first public answer"), []byte("second public answer")}

	got, err := assemble(template, true, input, prior)
	if err != nil {
		t.Fatalf("assemble: %v", err)
	}
	requireRoles(t, got.Ordered, roleSystem, roleUser, roleAssistant, roleAssistant)
	wantContents := []string{
		"system template text",
		"user input text",
		"first public answer",
		"second public answer",
	}
	for i, want := range wantContents {
		if got.Ordered[i].Content != want {
			t.Fatalf("message[%d].content = %q, want %q", i, got.Ordered[i].Content, want)
		}
	}
	if string(got.Input.SystemTemplate) != string(template) ||
		string(got.Input.Input) != string(input) {
		t.Fatal("egress input does not carry the template/input bytes 1:1")
	}
	if len(got.Input.PriorAnswers) != 2 ||
		string(got.Input.PriorAnswers[0]) != "first public answer" ||
		string(got.Input.PriorAnswers[1]) != "second public answer" {
		t.Fatalf("prior answers = %q", got.Input.PriorAnswers)
	}
}

func TestAssembleMessagesOmitsAnAbsentTemplate(t *testing.T) {
	got, err := assemble(nil, false, []byte("input"), [][]byte{[]byte("answer")})
	if err != nil {
		t.Fatalf("assemble: %v", err)
	}
	requireRoles(t, got.Ordered, roleUser, roleAssistant)
	if got.Input.SystemTemplate != nil {
		t.Fatalf("system template = %q, want nil", got.Input.SystemTemplate)
	}
	if got.Ordered[0].Content != "input" || got.Ordered[1].Content != "answer" {
		t.Fatalf("messages = %+v", got.Ordered)
	}
}

func TestAssembleMessagesKeepsAnEmptyTemplateAsASystemMessage(t *testing.T) {
	got, err := assemble([]byte{}, true, []byte("input"), nil)
	if err != nil {
		t.Fatalf("assemble: %v", err)
	}
	requireRoles(t, got.Ordered, roleSystem, roleUser)
	if got.Ordered[0].Content != "" {
		t.Fatalf("empty template content = %q", got.Ordered[0].Content)
	}
}

func TestAssembleMessagesRefusesInvalidTextAndOversize(t *testing.T) {
	cases := map[string]struct {
		template []byte
		has      bool
		input    []byte
		prior    [][]byte
	}{
		"empty input":       {input: nil},
		"invalid input":     {input: []byte{0xff, 0xfe}},
		"invalid template":  {template: []byte{0xff}, has: true, input: []byte("ok")},
		"invalid prior":     {input: []byte("ok"), prior: [][]byte{{0xff}}},
		"empty prior":       {input: []byte("ok"), prior: [][]byte{{}}},
		"too many priors":   {input: []byte("ok"), prior: [][]byte{[]byte("a"), []byte("b"), []byte("c")}},
		"over body ceiling": {input: []byte(strings.Repeat("a", canonical.MaxBodyBytes+1))},
		"template over": {
			template: []byte(strings.Repeat("b", canonical.MaxBodyBytes)),
			has:      true,
			input:    []byte("a"),
		},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := assemble(testCase.template, testCase.has, testCase.input, testCase.prior); err == nil {
				t.Fatal("assemble accepted an invalid assembly")
			}
		})
	}
}
