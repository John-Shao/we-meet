"""Same fixtures and business contract for both engines; explicit paid opt-in."""

import argparse
import hashlib
import json
import os
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from work.agent_client import AgentClient  # noqa: E402

CASES = [
    {
        "id": "weekly-report",
        "files": {
            "progress.md": "项目：客户门户\n2026-10-05：登录页面开发完成，尚未验收。\n"
            "2026-10-06：导出功能仍在开发，负责人李明。\n",
            "risks.md": "导出接口权限方案待审批，没有确定上线日期。\n"
            "下周计划：联调导出功能；不是已完成事项。\n",
        },
        "goal": "依据材料生成中文周报 output/weekly.md，包含进展、风险、下周计划。"
        "引用材料文件名，保留未验收和待审批状态，不编造上线日期。",
        "expected": "weekly.md",
    },
    {
        "id": "csv-analysis",
        "files": {
            "sales.csv": "order_id,region,amount,status\nA1,华东,100,paid\n"
            "A2,华南,200,paid\nA1,华东,100,paid\n"
            "A3,华东,50,refunded\nA4,华南,300,pending\n",
        },
        "goal": "分析 sales.csv。按 order_id 去重，只统计 paid 订单。"
        "生成 output/totals.json，内容为地区名称到合计金额的 JSON 对象；"
        "另生成 output/analysis.md 说明去重和筛选口径。不要安装软件。",
        "expected": "totals.json",
    },
]


def check(case, job):
    if job["state"] != "succeeded":
        return {"artifact_present": False, "deterministic_check": False}
    artifacts = {item["name"]: item for item in job["result"]["artifacts"]}
    artifact = artifacts.get(case["expected"])
    if not artifact:
        return {"artifact_present": False, "deterministic_check": False}
    passed = None  # Weekly report requires a human semantic review.
    if case["id"] == "csv-analysis":
        try:
            passed = json.loads(artifact["text"]) == {"华东": 100, "华南": 200}
        except ValueError:
            passed = False
    return {"artifact_present": True, "deterministic_check": passed}


def evaluate(client, case, deadline=180):
    run_id = str(uuid.uuid4())
    before = client.capabilities()
    started = time.monotonic()
    client.submit(run_id, case["goal"], case["files"], timeout_seconds=deadline)
    while True:
        job = client.get(run_id)
        if job["state"] in {"succeeded", "failed", "cancelled"}:
            break
        if time.monotonic() - started > deadline + 15:
            client.cancel(run_id)
            raise RuntimeError("evaluation_timeout")
        time.sleep(0.3)
    return {
        "case": case["id"],
        "input_sha256": hashlib.sha256(
            json.dumps(case, ensure_ascii=False, sort_keys=True).encode()
        ).hexdigest(),
        "wall_ms": round((time.monotonic() - started) * 1000),
        "capabilities": before,
        "job": job,
        "checks": check(case, job),
        "semantic_review": "pending",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--case", choices=[case["id"] for case in CASES])
    parser.add_argument("--allow-paid", action="store_true")
    args = parser.parse_args()
    client = AgentClient(args.endpoint, os.environ["WORK_AGENT_TOKEN"])
    capabilities = client.capabilities()
    if capabilities["engine"] != "fixture" and not args.allow_paid:
        parser.error("real model evaluation requires --allow-paid")
    records = [
        evaluate(client, case)
        for case in CASES
        if args.case is None or args.case == case["id"]
    ]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(records, ensure_ascii=False, indent=2), "utf-8")
    print(
        json.dumps(
            {
                "engine": capabilities["engine"],
                "runs": len(records),
                "succeeded": sum(
                    record["job"]["state"] == "succeeded" for record in records
                ),
            }
        )
    )


if __name__ == "__main__":
    main()
