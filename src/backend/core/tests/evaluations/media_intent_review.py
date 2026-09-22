"""Review real authorized media with explicitly assistant-authored questions."""

import argparse
import hashlib
import json
from pathlib import Path

from core.tests.evaluations.context_decisions import encoded
from core.tests.evaluations.review_meeting_qa import (
    EMPTY_REVIEW,
    validate_annotation,
    validate_reviewer,
)
from core.tests.evaluations.structured_rerank import ARTIFACTS

SOURCE = ARTIFACTS / "miaoji-qa-media-source-b71.json"


def source():
    return json.loads(SOURCE.read_text(encoding="utf-8"))


def build_packet():
    data = source()
    return {
        "schema_version": 1,
        "source_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        "data_kind": data["data_kind"],
        "reviewer": None,
        "reviewed_at": None,
        "cases": [
            {**q, "review": {**EMPTY_REVIEW, "evidence": []}} for q in data["questions"]
        ],
    }


def validate(packet):
    canonical = build_packet()
    if not isinstance(packet, dict) or set(packet) != set(canonical):
        raise ValueError("Unexpected packet shape")
    if type(packet["schema_version"]) is not int:
        raise ValueError("Invalid schema version")
    for key in ("schema_version", "source_sha256", "data_kind"):
        if packet[key] != canonical[key]:
            raise ValueError("Changed source provenance")
    if not isinstance(packet["cases"], list) or len(packet["cases"]) != len(
        canonical["cases"]
    ):
        raise ValueError("All frozen questions are required")
    segments = {
        s["id"]: s["text"] for record in source()["sources"] for s in record["segments"]
    }
    pending, needs_context = [], []
    for case, fixed in zip(packet["cases"], canonical["cases"], strict=True):
        if not isinstance(case, dict) or set(case) != set(fixed):
            raise ValueError("Unexpected case shape")
        if (case["id"], case["question"]) != (fixed["id"], fixed["question"]):
            raise ValueError("Question identity must remain frozen")
        decision = validate_annotation(case["review"], segments)
        if decision is None:
            pending.append(case["id"])
        if decision == "needs_context":
            needs_context.append(case["id"])
    identified, dated = validate_reviewer(packet)
    return {
        "review_sha256": hashlib.sha256(encoded(packet)).hexdigest(),
        "source_sha256": canonical["source_sha256"],
        "ready_for_calibration": identified
        and dated
        and not pending
        and not needs_context,
        "pending": pending,
        "needs_context": needs_context,
        "reviewer_provided": identified,
        "review_date_provided": dated,
        "real_user_query_log": False,
        "independent_holdout": False,
        "production_promotion_approved": False,
    }


def timestamp(ms):
    minutes, rest = divmod(ms, 60000)
    seconds, millis = divmod(rest, 1000)
    return f"{minutes:02}:{seconds:02}.{millis:03}"


def render():
    data = source()
    lines = [
        "# 已授权媒体：五题人工复核（第71批）",
        "",
        "两份原文来自你提供的真实音视频及当前有效转写；下面五个问题由助手拟定，不是真实用户查询日志。"
        "本包用于人工复核后建立校准样本，不是独立验证集。未填写任何建议答案或展示模型输出。",
        "",
        "只依据下方两份媒体片段判断；这些片段不代表完整项目历史。转写尚未逐句对照音频校验，"
        "有口误或识别疑点时可回听，不应把转写猜测当成已确认事实。",
        "",
        "## 填写方式",
        "",
        "每题评价整体处理方式，四选一：**回答／澄清／无相关证据／需补上下文**。",
        "",
        "- 回答：写答案，列原文编号及摘句；多条事实需要多条证据。",
        "- 澄清：你认为系统应先追问，填写具体问句。",
        "- 无相关证据：问题目标明确，但所给材料不支持回答。",
        "- 需补上下文：你作为复核者仍无法判断如何处理，写清缺少什么。",
        "",
        "每题写一句理由。A01等是音频原文编号，V01等是视频原文编号，与处理方式没有对应关系。"
        "可以填写本文件，也可以直接在会话回复；无需编辑JSON。",
        "",
        "## 原文在哪里",
        "",
        "全部26段原文及时间如下，不需要另找隐藏讨论记录。可回听你提供的本地样本：",
        "",
        "- [原始音频](C:/Users/19146/Downloads/test-audio01.m4a)",
        "- [原始视频](C:/Users/19146/Downloads/test-video01.mp4)",
        "",
    ]
    for record in data["sources"]:
        lines += [f"### {record['media_name']}", ""]
        for segment in record["segments"]:
            lines += [
                f"**{segment['id']} · {timestamp(segment['start_ms'])}–{timestamp(segment['end_ms'])}**",
                "",
                f"> {segment['text']}",
                "",
            ]
    lines += ["## 请填写以下五题", ""]
    for q in data["questions"]:
        lines += [
            f"### {q['id']}：{q['question']}",
            "",
            "处理方式：待填写",
            "",
            "理由：",
            "",
            "答案、原文编号及摘句（仅回答填写）：",
            "",
            "追问内容（仅澄清填写）：",
            "",
        ]
    lines += [
        "填写后由助手按原文编号转录并校验。没有人工结论的题保持未标注；"
        "本包不改变第68批R01/R04/R05待定结论，也不自动形成上线结论。",
        "",
    ]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--create", type=Path)
    group.add_argument("--review", type=Path)
    args = parser.parse_args()
    if args.create:
        md = args.create.with_suffix(".md")
        if args.create.suffix != ".json":
            raise ValueError("Use a JSON output path")
        if args.create.exists() or md.exists():
            raise FileExistsError("Use new output paths")
        args.create.write_bytes(encoded(build_packet()))
        md.write_text(render(), encoding="utf-8", newline="\n")
        return 0
    result = validate(json.loads(args.review.read_text(encoding="utf-8")))
    print(json.dumps(result, ensure_ascii=False, indent=2))  # noqa: T201
    return 0 if result["ready_for_calibration"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
