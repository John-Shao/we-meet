"""Batch 66 offline contracts; no runtime service imports this module."""

import hashlib
import json
from pathlib import Path

from core.tests.evaluations.evidence_rerank import (
    PROMPT,
    entity_matches,
    payload,
    validate_selection,
)

ROOT = Path(__file__).parent
ARTIFACTS = ROOT.parents[4] / "docs/research/evaluations"
CONTROLS_PATH = ROOT / "meeting_qa_scenario_controls.json"
ARMS = ("schema_only", "scenario")
SCHEMA_PROMPT = PROMPT.replace(
    "只返回JSON数组，按直接相关程度排序，最多8项，每项只能有id和evidence两个字符串字段。",
    "返回JSON对象，含decision和selected。selected为按相关程度排序的数组，最多8项，"
    '每项只能有id和evidence两个字符串字段。decision为"evidence"时selected必须非空；'
    '没有证据时decision为"no_evidence"，selected为空。',
).replace("返回[]", '返回{"decision":"no_evidence","selected":[]}')
SCENARIO_PROMPT = (
    SCHEMA_PROMPT
    + """
选择前先识别问题询问的实体、事件、动作与所需属性，再逐条核对证据描述的是不是同一件事。
跨语言或同义表达可以匹配，但一个词的不同义项不等同。不能因为词义相近就跨业务场景替换。
候选的排列位置、标题相似和词频均不能证明相关。只有证据明确支持问题所问的事实才选择。
当问题中的指代缺乏上下文且存在多个同等合理的目标实体/事件时，不自行选择或合并；
返回decision="clarify"且selected=[]。同一目标的冲突说法不是指代歧义，仍保留冲突证据。
问题已明确目标却只有其他实体/事件的材料，返回no_evidence；不要将明确未知误当缺证据。
如果候选中只有一个明确符合问题所问角色/事件的目标，可保留该证据，不因其他无关场景而拒绝。
"""
)
PROMPTS = {"schema_only": SCHEMA_PROMPT, "scenario": SCENARIO_PROMPT}


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False).encode()).hexdigest()


def response_format(item):
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "evidence_selection",
            "strict": True,
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "required": ["decision", "selected"],
                "properties": {
                    "decision": {
                        "type": "string",
                        "enum": ["evidence", "no_evidence", "clarify"],
                    },
                    "selected": {
                        "type": "array",
                        "maxItems": 8,
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["id", "evidence"],
                            "properties": {
                                "id": {
                                    "type": "string",
                                    "enum": [c["id"] for c in item["candidates"]],
                                },
                                "evidence": {
                                    "type": "string",
                                    "minLength": 2,
                                    "maxLength": 400,
                                },
                            },
                        },
                    },
                },
            },
        },
    }


def validate(value, item):
    if not isinstance(value, dict) or set(value) != {"decision", "selected"}:
        raise ValueError("Expected decision and selected")
    if value["decision"] not in ("evidence", "no_evidence", "clarify"):
        raise ValueError("Unknown decision")
    selected = validate_selection(value["selected"], item)
    if bool(selected) != (value["decision"] == "evidence"):
        raise ValueError("Decision and selected evidence disagree")
    return value


def controls():
    return json.loads(CONTROLS_PATH.read_text(encoding="utf-8"))["cases"]


def build_plan():
    previous = json.loads(
        (ARTIFACTS / "miaoji-qa-rerank-plan-b65.json").read_text(encoding="utf-8")
    )
    for case in controls():
        previous.append(
            {
                "id": "scenario_controls/" + case["id"],
                "question": case["question"],
                "candidates": [
                    c
                    for c in case["candidates"]
                    if entity_matches(case["question"], c["title"], c["text"])
                ],
            }
        )
    assert len({v["id"] for v in previous}) == len(previous)
    assert all(v["candidates"] for v in previous)
    return sorted(previous, key=lambda v: v["id"])


def request_body(item, arm, model):
    return {
        "model": model,
        "temperature": 0,
        "enable_thinking": False,
        "messages": [
            {"role": "system", "content": PROMPTS[arm]},
            {"role": "user", "content": json.dumps(payload(item), ensure_ascii=False)},
        ],
        "response_format": response_format(item),
    }


def replay(row, item):
    assert row["input_sha256"] == digest(payload(item))
    assert row["schema_sha256"] == digest(response_format(item))
    try:
        if row["finish_reason"] != "stop":
            raise ValueError("Incomplete output")
        parsed = validate(json.loads(row["raw"]), item)
    except (ValueError, TypeError):
        assert row.get("invalid_output") and row["selected"] == []
        assert row["decision"] == "invalid"
    else:
        assert not row.get("invalid_output")
        assert parsed == {k: row[k] for k in ("decision", "selected")}
    return row["selected"]
