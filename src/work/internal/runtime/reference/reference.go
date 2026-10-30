// Package reference is a deterministic, non-model runtime used to exercise the
// RunWorkflow lifecycle. It never calls a provider; artifacts are stamped as
// reference output by the activity provenance.
package reference

import (
	"context"
	"fmt"
	"strings"
	"unicode/utf8"

	workruntime "github.com/we-meet/work/internal/runtime"
)

const Version = "reference-text-v1"

type Runtime struct{}

func New() *Runtime { return &Runtime{} }

func (r *Runtime) Execute(ctx context.Context, request workruntime.Request) (workruntime.Result, error) {
	if err := ctx.Err(); err != nil {
		return workruntime.Result{}, err
	}
	goal := strings.TrimSpace(request.Goal)
	if goal == "" {
		return workruntime.Result{}, fmt.Errorf("reference runtime requires a goal")
	}
	background := strings.TrimSpace(request.Background)
	title := strings.TrimSpace(request.TemplateName)
	if title == "" {
		title = request.TemplateID
	}
	if title == "" {
		title = "任务"
	}
	var body strings.Builder
	fmt.Fprintf(&body, "# %s结果\n\n", title)
	body.WriteString("> 参考运行时输出（非模型生成），用于验证任务生命周期。\n\n")
	if request.StepCount > 1 {
		fmt.Fprintf(&body, "> 步骤 %d/%d\n\n", request.Step, request.StepCount)
	}
	body.WriteString("## 目标\n\n")
	body.WriteString(goal)
	body.WriteString("\n\n## 背景\n\n")
	if background == "" {
		body.WriteString("（未提供）")
	} else {
		body.WriteString(background)
	}
	if request.PreviousContent != "" {
		body.WriteString("\n\n## 上一步检查点\n\n")
		body.WriteString(request.PreviousContent)
	}
	body.WriteString("\n\n## 结果\n\n")
	body.WriteString("已按模板整理目标与背景；接入真实运行时后将替换为本段生成内容。\n")

	content := []byte(body.String())
	input := estimateTokens(goal + "\n" + background + "\n" + request.PreviousContent)
	output := estimateTokens(string(content))
	cached := int64(0)
	return workruntime.Result{
		Content:           content,
		MediaType:         "text/markdown",
		RuntimeVersion:    Version,
		ProviderRequestID: "reference:" + request.RunID,
		Usage: workruntime.Usage{
			Source:            workruntime.UsageGatewayEstimate,
			InputTokens:       &input,
			OutputTokens:      &output,
			CachedInputTokens: &cached,
		},
	}, nil
}

func estimateTokens(value string) int64 {
	runes := utf8.RuneCountInString(value)
	if runes == 0 {
		return 0
	}
	return int64(runes/4) + 1
}
