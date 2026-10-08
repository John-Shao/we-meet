"""Read-only review behavior at the process, artifact and RPC boundaries."""

import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from work_agent import drivers
from work_agent.contract import digest
from work_agent.review import (
    REPORT_SCHEMA,
    evidence_quotes,
    parse_report,
    response_format,
    validate_report,
)
from work_agent.runner import run


def report():
    return {
        "verdict": "needs_changes",
        "summary": "Wrong total",
        "findings": [
            {
                "severity": "error",
                "message": "1 + 2 is 3",
                "evidence": [
                    {
                        "file": "report.md",
                        "sha256": digest(b"Total: 4"),
                        "quote": "Total: 4",
                    }
                ],
            }
        ],
        "missing_information": [],
    }


class ReviewTests(unittest.TestCase):
    def test_schema_uses_bounded_literal_frozen_evidence_without_global_mutation(self):
        files = [
            {"name": "result-01.md", "text": "标题\n原文\r\n"},
            {"name": "large.txt", "text": "long text\n" * 10000},
        ]
        quotes = evidence_quotes(files)
        self.assertIn(files[0]["text"], quotes)
        self.assertLessEqual(len(quotes), 40)
        self.assertLessEqual(
            sum(len(json.dumps(q, ensure_ascii=False).encode()) for q in quotes), 4096
        )
        self.assertTrue(all(0 < len(q) <= 500 for q in quotes))
        self.assertTrue(all(any(q in f["text"] for f in files) for q in quotes))
        fmt = response_format("qwen", "qwen3.8-flash", files)
        properties = fmt["json_schema"]["schema"]["properties"]["findings"]["items"][
            "properties"
        ]["evidence"]["items"]["properties"]
        self.assertEqual(properties["file"]["enum"], [f["name"] for f in files])
        self.assertEqual(properties["quote"]["enum"], quotes)
        self.assertNotIn(
            "enum",
            REPORT_SCHEMA["properties"]["findings"]["items"]["properties"]["evidence"][
                "items"
            ]["properties"]["quote"],
        )
        # Global quote choices cannot bypass the authoritative per-file check.
        value = report()
        value["findings"][0]["evidence"][0].update(
            file=files[1]["name"],
            sha256=digest(files[1]["text"].encode()),
            quote=files[0]["text"],
        )
        with self.assertRaisesRegex(ValueError, "invalid_review_report"):
            validate_report(value, files)
        self.assertEqual(evidence_quotes([{"text": " \n\t"}]), [])

    def test_missing_information_always_blocks_clean_verdict(self):
        value = {
            "verdict": "no_issues",
            "summary": "No contradictions",
            "findings": [],
            "missing_information": ["No order records"],
        }
        self.assertEqual(parse_report(json.dumps(value), [])["verdict"], "inconclusive")
        value = report()
        value["missing_information"] = ["Original input was not supplied"]
        parsed = parse_report(
            json.dumps(value), [{"name": "report.md", "text": "Total: 4"}]
        )
        self.assertEqual(parsed["verdict"], "inconclusive")
        self.assertEqual(parsed["findings"], value["findings"])
        # Malformed evidence is still rejected, never repaired or dropped.
        value = report()
        value["findings"][0]["evidence"][0]["quote"] = "invented"
        with self.assertRaises(ValueError):
            parse_report(json.dumps(value), [{"name": "report.md", "text": "Total: 4"}])

    def test_evidence_and_verdict_are_strict(self):
        files = [{"name": "report.md", "text": "Total: 4"}]
        self.assertEqual(validate_report(report(), files)["verdict"], "needs_changes")
        for change in (
            {"quote": "fabricated"},
            {"sha256": "f" * 64},
            {"file": "../secret.txt"},
            {"quote": ""},
        ):
            value = report()
            value["findings"][0]["evidence"][0].update(change)
            with self.assertRaises(ValueError):
                validate_report(value, files)
        value = report()
        value["verdict"] = "no_issues"
        with self.assertRaises(ValueError):
            validate_report(value, files)

    def test_misspelled_evidence_field_is_rejected_without_repair(self):
        value = report()
        ref = value["findings"][0]["evidence"][0]
        ref["fle"] = ref.pop("file")
        original = json.dumps(value)
        with self.assertRaisesRegex(ValueError, "invalid_review_report"):
            parse_report(original, [{"name": "report.md", "text": "Total: 4"}])
        self.assertEqual(json.dumps(value), original)

    def test_trusted_runner_writes_only_review_artifact(self):
        with (
            tempfile.TemporaryDirectory() as temp,
            patch.dict(os.environ, {"WORK_AGENT_ENGINE": "fixture"}),
        ):
            root = Path(temp)
            request = {
                "contract": "work-agent/v1",
                "run_id": "00000000-0000-0000-0000-000000000001",
                "goal": "Review",
                "files": [
                    {
                        "name": "report.md",
                        "text": "Total: 4",
                        "sha256": digest(b"Total: 4"),
                    }
                ],
                "timeout_seconds": 10,
                "operation": "review",
            }
            (root / "request.json").write_text(json.dumps(request))
            run(root)
            value = json.loads((root / "result.json").read_text())
            self.assertEqual(
                [f["name"] for f in value["artifacts"]], ["pi-review.json"]
            )
            self.assertEqual((root / "workspace" / "report.md").read_text(), "Total: 4")

    def test_pi_disables_tools_and_rejects_unexpected_tool_events(self):
        for provider, tool_event in (
            ("deepseek", False),
            ("deepseek", True),
            ("qwen", False),
            ("qwen", True),
        ):
            records = [
                {"type": "response", "id": "retry", "success": True},
                {"type": "response", "id": "task", "success": True},
            ]
            if tool_event:
                records.append({"type": "tool_execution_start", "toolName": "bash"})
            records += [
                {
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "stopReason": "stop",
                        "content": [{"type": "text", "text": json.dumps(report())}],
                    },
                },
                {"type": "agent_settled"},
                {"type": "response", "id": "stats", "success": True, "data": {}},
            ]
            child = type(
                "Child",
                (),
                {
                    "stdin": io.BytesIO(),
                    "stdout": io.BytesIO(
                        b"".join(json.dumps(r).encode() + b"\n" for r in records)
                    ),
                    "wait": lambda self, timeout: 0,
                },
            )()
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                cli = root / "pi" / "dist" / "bundle" / "cli.js"
                cli.parent.mkdir(parents=True)
                (root / "pi" / "package.json").write_text('{"version":"1.0.4"}')
                home = root / "home"
                home.mkdir()
                request = {
                    "goal": "Review",
                    "operation": "review",
                    "files": [{"name": "report.md", "text": "Total: 4"}],
                }
                with (
                    patch.dict(
                        os.environ,
                        {
                            "PI_CLI": str(cli),
                            "WORK_AGENT_MODEL": "test",
                            "WORK_AGENT_PROVIDER": provider,
                            "WORK_AGENT_MODEL_TOKEN": "temporary-job-token",
                            "DEEPSEEK_BASE_URL": "https://example.invalid",
                        },
                    ),
                    patch.object(
                        drivers.subprocess, "Popen", return_value=child
                    ) as spawn,
                ):
                    if tool_event:
                        with self.assertRaisesRegex(
                            RuntimeError, "review_tool_forbidden"
                        ):
                            drivers.pi(request, root, home)
                    else:
                        self.assertEqual(
                            json.loads(drivers.pi(request, root, home)["summary"])[
                                "verdict"
                            ],
                            "needs_changes",
                        )
                    command = spawn.call_args.args[0]
                    self.assertIn("--no-tools", command)
                    self.assertNotIn("--tools", command)
                    self.assertIn("--no-extensions", command)
                    self.assertIn("--no-mcp", command)
                    self.assertEqual(command[command.index("--provider") + 1], provider)
                    self.assertEqual(
                        command[command.index("--thinking") + 1],
                        "off" if provider == "qwen" else "low",
                    )
                    models = json.loads((home / "models.json").read_text("utf8"))
                    entry = models["providers"][provider]
                    self.assertEqual(entry["apiKey"], "$WORK_AGENT_MODEL_TOKEN")
                    if provider == "qwen":
                        self.assertEqual(entry["api"], "openai-completions")
                        self.assertEqual(entry["models"][0]["id"], "test")
