"""Prepare and validate human intent labels without rewriting historical gold."""

import argparse
import hashlib
import json
from datetime import date
from pathlib import Path

from core.tests.evaluations.structured_rerank import ARTIFACTS

SOURCE = ARTIFACTS / "miaoji-qa-structured-plan-b66.json"
CASE_IDS = (
    "meeting_qa_semantic_cases/cost_with_noise",
    "meeting_qa_semantic_cases/release_with_noise",
    "meeting_qa_semantic_cases/owner_with_noise",
    "meeting_qa_cases/natural_synonym",
    "meeting_qa_expansion_cases/cost_paraphrase",
    "controls/partial_known",
    "controls/embedded_command",
    "controls/conflicting_sources",
)
POLICY = {
    "multiple_projects_without_target": "clarify_before_answer",
    "confirmed_by": "user_in_conversation_2026-09-21",
    "scope": "product_policy_only_not_case_annotations",
}
EMPTY_REVIEW = {
    "decision": None,
    "evidence": [],
    "clarification": None,
    "rationale": None,
}


def build_packet():
    source = {c["id"]: c for c in json.loads(SOURCE.read_text(encoding="utf-8"))}
    cases = []
    for number, source_id in enumerate(CASE_IDS, 1):
        item = source[source_id]
        # Neutral stable order: never show vector/reranker order to the reviewer.
        candidates = sorted(
            item["candidates"],
            key=lambda c: hashlib.sha256(
                (c["title"] + "\n" + c["text"]).encode()
            ).hexdigest(),
        )
        cases.append(
            {
                "id": f"R{number:02d}",
                "question": item["question"],
                "candidates": [
                    {"id": chr(65 + i), "title": c["title"], "text": c["text"]}
                    for i, c in enumerate(candidates)
                ],
                "review": {**EMPTY_REVIEW, "evidence": []},
            }
        )
    return {
        "schema_version": 1,
        "source_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        "policy": dict(POLICY),
        "reviewer": None,
        "reviewed_at": None,
        "cases": cases,
    }


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def validate_evidence(evidence, candidates, decision):
    if not isinstance(evidence, list) or bool(evidence) != (decision == "answer"):
        raise ValueError("Only an answer decision must cite evidence")
    seen = set()
    for quote in evidence:
        if not isinstance(quote, dict) or set(quote) != {"candidate_id", "quote"}:
            raise ValueError("Unexpected evidence shape")
        ident, text = quote["candidate_id"], quote["quote"]
        if (
            not isinstance(ident, str)
            or ident not in candidates
            or not nonempty(text)
            or text not in candidates[ident]
        ):
            raise ValueError("Evidence must cite an existing candidate verbatim")
        if (ident, text) in seen:
            raise ValueError("Duplicate evidence")
        seen.add((ident, text))


def validate_annotation(review, candidates):
    if not isinstance(review, dict) or set(review) != set(EMPTY_REVIEW):
        raise ValueError("Unexpected annotation shape")
    if review == EMPTY_REVIEW:
        return None
    decision = review["decision"]
    if decision not in (
        "answer",
        "clarify",
        "no_evidence",
        "needs_context",
    ) or not nonempty(review["rationale"]):
        raise ValueError("A decision and rationale are required")
    validate_evidence(review["evidence"], candidates, decision)
    if decision == "clarify":
        if not nonempty(review["clarification"]):
            raise ValueError("A clarification question is required")
    elif review["clarification"] is not None:
        raise ValueError("Only clarify may contain a clarification question")
    return decision


def validate_reviewer(packet):
    identified = nonempty(packet["reviewer"])
    if packet["reviewer"] is not None and not identified:
        raise ValueError("Invalid reviewer name")
    dated = packet["reviewed_at"] is not None
    if dated:
        if not isinstance(packet["reviewed_at"], str):
            raise ValueError("Invalid review date")
        date.fromisoformat(packet["reviewed_at"])
    return identified, dated


def validate(packet):
    canonical = build_packet()
    if not isinstance(packet, dict) or set(packet) != set(canonical):
        raise ValueError("Unexpected packet shape")
    if type(packet["schema_version"]) is not int:
        raise ValueError("Invalid schema version")
    for key in ("schema_version", "source_sha256", "policy"):
        if packet[key] != canonical[key]:
            raise ValueError("Changed packet source or product policy")
    cases = packet["cases"]
    if not isinstance(cases, list) or len(cases) != len(canonical["cases"]):
        raise ValueError("Review must contain all frozen cases")
    pending, needs_context = [], []
    for case, fixed in zip(cases, canonical["cases"], strict=True):
        if not isinstance(case, dict) or set(case) != set(fixed):
            raise ValueError("Unexpected case shape")
        if {k: v for k, v in case.items() if k != "review"} != {
            k: v for k, v in fixed.items() if k != "review"
        }:
            raise ValueError("Questions, candidates and IDs must remain frozen")
        decision = validate_annotation(
            case["review"], {c["id"]: c["text"] for c in case["candidates"]}
        )
        if decision is None:
            pending.append(case["id"])
        if decision == "needs_context":
            needs_context.append(case["id"])
    identified, dated = validate_reviewer(packet)
    return {
        "review_sha256": hashlib.sha256(
            json.dumps(packet, ensure_ascii=False, sort_keys=True).encode()
        ).hexdigest(),
        "ready_for_scoring": identified and dated and not pending and not needs_context,
        "pending": pending,
        "needs_context": needs_context,
        "reviewer_provided": identified,
        "review_date_provided": dated,
        "human_identity_independently_verified": False,
        "production_promotion_approved": False,
    }


def render(packet):
    lines = [
        "# 跨记录问答：人工意图复核包",
        "",
        "以下是合成测试问题和原文片段，不是真实会议记录，也没有额外的完整会议上下文。只依据展示的材料判断；未展示旧标准答案或任何模型输出。候选按文本hash固定排序，字母顺序不表示相关性。",
        "",
        "已确认规则：未指定项目、存在多个项目预算时先追问项目。人工结论由你逐题填写，不要将模型或作者的判断填写为独立人工复核。",
        "",
        "**你评价的是整个问题应该如何处理，不是逐个评价候选。处理方式与候选字母没有对应关系。**",
        "",
        "每题选择一种处理方式，直接填写中文名称，不使用字母代号：",
        "",
        "- **回答**：材料足以回答全部或部分问题。填写证据的候选字母和原文摘句；需要多条事实或冲突证据时，可以选多个候选。",
        "- **澄清**：你确定系统应先追问用户。填写具体追问内容。",
        "- **无相关证据**：问题目标清楚，但材料不能支持回答。",
        "- **需补上下文**：你作为复核者暂时无法确定应如何处理。说明缺少什么信息，不必猜测。",
        "",
        "每题均请写一句理由。**候选A、候选B等字母仅表示证据来源，只有选择“回答”时才需要填写。**",
        "",
        "可以在每题下填写，也可以直接在会话中回复。通用格式如下（不是任何题目的建议结论）：",
        "",
        "```text",
        "人工结论：",
        "处理方式：回答 / 澄清 / 无相关证据 / 需补上下文（四选一）",
        "理由：……",
        "证据：候选X，“原文摘句……”（仅“回答”填写，可选多条）",
        "追问内容：……（仅“澄清”填写）",
        "```",
        "",
    ]
    for case in packet["cases"]:
        lines += [f"## {case['id']}：{case['question']}", ""]
        for candidate in case["candidates"]:
            lines += [
                f"- **候选{candidate['id']}**（{candidate['title']}）：{candidate['text']}"
            ]
        lines += ["", "人工结论：待填写。", ""]
    lines += [
        "你可以只填写本文件或在会话中回复，不需要操作JSON。后续由助手将你的结论整理到同名JSON中，保留问题、原文、编号和hash。校验通过只表示可评分，不证明标注人身份或可上线；真实用户样本和完整问答验收仍另需完成。",
        "",
    ]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--create",
        type=Path,
        help="New JSON output; a Markdown sibling is also created",
    )
    group.add_argument("--review", type=Path)
    args = parser.parse_args()
    if args.create:
        if args.create.suffix != ".json":
            raise ValueError("The review packet must use a .json filename")
        md = args.create.with_suffix(".md")
        if args.create.exists() or md.exists():
            raise FileExistsError("Use new output paths")
        packet = build_packet()
        args.create.write_text(
            json.dumps(packet, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        md.write_text(render(packet), encoding="utf-8", newline="\n")
        return 0
    packet = json.loads(args.review.read_text(encoding="utf-8"))
    result = validate(packet)
    print(json.dumps(result, ensure_ascii=False, indent=2))  # noqa: T201
    return 0 if result["ready_for_scoring"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
