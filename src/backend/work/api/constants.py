"""Frozen R0a limits and server assets (D2/D5)."""

import os

LIMITS = {
    "max_goal_chars": 2000,
    "max_background_chars": 4000,
    "max_artifact_bytes": 262144,
    "max_active_runs": 1,
}

CLOUD_TARGET = {"kind": "cloud", "profile": "text-v1"}
EXECUTION_TARGETS = [dict(CLOUD_TARGET)]
PHASES = ["R0a"]
PERMISSIONS = ["work.task.create", "work.artifact.read"]
USAGE_NOTE = "用量仅供参考，费用以云厂商账单为准"
# Records what actually executes the Run.  R0a runs on the Python Temporal
# worker against a mock model gateway, not on the Pi agent-core runtime that
# the architecture targets, and the ledger must not claim otherwise.
RUNTIME_VERSION = os.environ.get("WORK_RUNTIME_VERSION", "r0a-temporal-py-1")

TEMPLATES = [
    {
        "id": "tpl-report",
        "version": 1,
        "name": "方案 / 报告",
        "description": "面向决策的方案或报告初稿，包含背景、方案、风险与下一步。",
        "output_format": "markdown",
        "sections": ["背景与目标", "方案", "风险", "下一步"],
        "content_hash": "sha256:tpl-report-v1",
    },
    {
        "id": "tpl-plan",
        "version": 1,
        "name": "计划 / 清单",
        "description": "把目标拆成可执行步骤、负责人、依赖与验收标准。",
        "output_format": "markdown",
        "sections": ["目标", "步骤", "依赖", "验收"],
        "content_hash": "sha256:tpl-plan-v1",
    },
    {
        "id": "tpl-summary",
        "version": 1,
        "name": "总结 / 纪要",
        "description": "把输入整理成结构化总结，突出结论、依据与待办。",
        "output_format": "markdown",
        "sections": ["结论", "依据", "待办"],
        "content_hash": "sha256:tpl-summary-v1",
    },
]
