"""Render-only checks: no secrets, provider calls or cluster access."""

import pathlib
import os
import shutil
import subprocess
import unittest
import tempfile
import runpy
from unittest.mock import patch

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKERS = ("translation", "interpretation", "capture-asr", "capture-live-asr", "capture-translation")


def render(*values, success=True):
    command = [shutil.which("helm"), "template", "meet", str(ROOT / "src/helm/meet")]
    for value in values:
        command += ["--set" if value.endswith(("=true", "=false")) else "--set-string", value]
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
    if success:
        if result.returncode:
            raise AssertionError(result.stderr)
        return [row for row in yaml.safe_load_all(result.stdout) if row]
    assert result.returncode != 0
    return result.stderr


class MeetingAIChartTest(unittest.TestCase):
    settings = (
        "meetingAIWorkers.credentialsSecret=fixture-ai",
        "meetingAIWorkers.backendUrl=http://meet-backend:8000",
        "meetingAIWorkers.livekitUrl=wss://livekit.example.invalid",
        "meetingAIWorkers.gateway.origins=https://meet.example.invalid",
        "meetingAIWorkers.image.tag=fixture-immutable",
    )

    def test_production_gunicorn_memory_controls_are_consumed_by_image(self):
        config = yaml.safe_load((ROOT / "src/helm/env.d/aliyun-prod/values.meet.yaml").read_text(encoding="utf-8"))
        env = {key: str(value) for key, value in config["backend"]["envVars"].items() if key.startswith("GUNICORN_")}
        with patch.dict(os.environ, env, clear=True):
            runtime = runpy.run_path(str(ROOT / "docker/files/usr/local/etc/gunicorn/meet.py"))
        self.assertEqual(2, runtime["workers"])
        self.assertEqual(500, runtime["max_requests"])
        self.assertEqual(50, runtime["max_requests_jitter"])
        self.assertEqual("1Gi", config["backend"]["resources"]["limits"]["memory"])

    def test_default_emits_no_optional_workers(self):
        rows = render()
        self.assertFalse(any(row["metadata"]["name"] == f"meet-agent-{key}"
                             for row in rows for key in WORKERS))
        self.assertFalse(any(row["metadata"]["name"] == "meet-celery-beat" for row in rows))

    def test_beat_inherits_backend_settings_without_worker_override_leak(self):
        rows = render("celeryBeat.enabled=true", "backend.envVars.AI_SCOPE=backend",
                      "celeryBackend.envVars.AI_SCOPE=worker", "backend.image.tag=fixture-backend")
        for name, expected in (("meet-backend", "backend"), ("meet-celery-beat", "backend"), ("meet-celery-backend", "worker")):
            row = next(row for row in rows if row["kind"] == "Deployment" and row["metadata"]["name"] == name)
            container = row["spec"]["template"]["spec"]["containers"][0]
            env = {item["name"]: item.get("value") for item in container["env"]}
            self.assertEqual(expected, env["AI_SCOPE"])
            self.assertTrue(container["image"].endswith(":fixture-backend"))
            if name == "meet-celery-beat":
                self.assertEqual(1, row["spec"]["replicas"])
                self.assertEqual("Recreate", row["spec"]["strategy"]["type"])
                self.assertIn("beat", container["command"])

    def test_aliyun_rollout_wires_entries_credentials_scheduler_and_workers(self):
        command = [shutil.which("helm"), "template", "meet", str(ROOT / "src/helm/meet"),
                   "-f", str(ROOT / "src/helm/env.d/aliyun-prod/values.meet.yaml")]
        # Never load the operator's actual secret file in regression tests.
        for item in ("agentAIAssistant.envVars.DASHSCOPE_API_KEY=fixture-provider",
                     "backend.envVars.AGENT_INTERNAL_API_TOKEN=fixture-internal",
                     "agentSubtitles.envVars.LIVEKIT_API_SECRET=fixture-livekit"):
            command += ["--set-string", item]
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(0, result.returncode, result.stderr)
        rows = [row for row in yaml.safe_load_all(result.stdout) if row]
        deployments = {row["metadata"]["name"]: row for row in rows if row["kind"] == "Deployment"}
        config = yaml.safe_load((ROOT / "src/helm/env.d/aliyun-prod/values.meet.yaml").read_text(encoding="utf-8"))
        flags = [key for key in config["backend"]["envVars"] if key.startswith("MEETING_") and key.endswith("_ENABLED")]
        self.assertTrue({"MEETING_RECORDS_ENABLED", "MEETING_CAPTURE_AUDIO_ENABLED",
                         "MEETING_SUMMARY_REQUESTS_ENABLED", "MEETING_CAPTURE_TRANSLATION_ENABLED"}.issubset(flags))
        for name in ("meet-backend", "meet-celery-backend", "meet-celery-beat"):
            container = deployments[name]["spec"]["template"]["spec"]["containers"][0]
            env = {item["name"]: item for item in container["env"]}
            for flag in flags:
                self.assertEqual("True", env[flag]["value"], f"{name}:{flag}")
            self.assertEqual("qwen3.8-flash", env["MEETING_SUMMARY_MODEL"]["value"])
            self.assertEqual("meet-ai-credentials", env["DASHSCOPE_API_KEY"]["valueFrom"]["secretKeyRef"]["name"])
        for worker in WORKERS:
            container = deployments[f"meet-agent-{worker}"]["spec"]["template"]["spec"]["containers"][0]
            self.assertTrue(container["image"].startswith("jusi-cn-guangzhou.cr.volces.com/we-meet/meet-agents:"))
        subtitle = deployments["meet-agent-subtitles"]["spec"]["template"]["spec"]["containers"][0]
        env = {item["name"]: item for item in subtitle["env"]}
        self.assertEqual("qwen", env["STT_PROVIDER"]["value"])
        self.assertEqual("", env["TRANSLATION_TARGET_LANGS"]["value"])
        secret = next(row for row in rows if row["kind"] == "Secret" and row["metadata"]["name"] == "meet-ai-credentials")
        self.assertEqual("fixture-provider", secret["stringData"]["DASHSCOPE_API_KEY"])
        self.assertEqual("fixture-internal", secret["stringData"]["AGENT_INTERNAL_API_TOKEN"])
        self.assertEqual("fixture-livekit", secret["stringData"]["LIVEKIT_API_SECRET"])
        self.assertEqual("before-hook-creation", secret["metadata"]["annotations"]["helm.sh/hook-delete-policy"])
        for row in rows:
            if row["kind"] == "Job":
                self.assertLess(int(secret["metadata"]["annotations"]["helm.sh/hook-weight"]),
                                int(row["metadata"]["annotations"]["helm.sh/hook-weight"]))
        ingress = next(row for row in rows if row["kind"] == "Ingress" and row["metadata"]["name"] == "meet-agent-capture-translation")
        self.assertEqual("meet.we-meet.online", ingress["spec"]["rules"][0]["host"])
        self.assertEqual("meet-tls", ingress["spec"]["tls"][0]["secretName"])

    def test_managed_credentials_require_existing_secret_inputs(self):
        self.assertIn("DASHSCOPE_API_KEY", render("meetingAIWorkers.credentialsFromExistingEnv=true",
                                                 "meetingAIWorkers.credentialsSecret=fixture-ai", success=False))

    def test_enabled_workers_and_wss_are_exact_and_use_secret_references(self):
        rows = render(*self.settings,
                      *(f"meetingAIWorkers.workers.{key}.enabled=true" for key in WORKERS),
                      "meetingAIWorkers.gateway.ingress.enabled=true",
                      "meetingAIWorkers.gateway.ingress.host=meet.example.invalid",
                      "meetingAIWorkers.gateway.ingress.tlsSecret=fixture-tls")
        for key in WORKERS:
            deployment = next(row for row in rows if row["kind"] == "Deployment" and
                              row["metadata"]["name"] == f"meet-agent-{key}")
            container = deployment["spec"]["template"]["spec"]["containers"][0]
            self.assertEqual("lasuite/meet-agents:fixture-immutable", container["image"])
            env = {item["name"]: item for item in container["env"]}
            for name in ("AGENT_INTERNAL_API_TOKEN", "DASHSCOPE_API_KEY"):
                self.assertEqual({"name": "fixture-ai", "key": name}, env[name]["valueFrom"]["secretKeyRef"])
            self.assertEqual(key in ("translation", "interpretation"), "LIVEKIT_API_SECRET" in env)
            if key == "capture-translation":
                self.assertEqual("true", env["CAPTURE_TRANSLATION_GATEWAY_ENABLED"]["value"])
                self.assertEqual("0.0.0.0", env["CAPTURE_TRANSLATION_BIND"]["value"])
                self.assertEqual(["python", "capture_translation_gateway.py"], container["command"])
        ingress = next(row for row in rows if row["kind"] == "Ingress" and row["metadata"]["name"] == "meet-agent-capture-translation")
        path = ingress["spec"]["rules"][0]["http"]["paths"][0]
        self.assertEqual("/capture-translation", path["path"])
        self.assertEqual("Exact", path["pathType"])
        self.assertEqual("fixture-tls", ingress["spec"]["tls"][0]["secretName"])

    def test_enabled_missing_secret_fails_before_deployment(self):
        self.assertIn("credentialsSecret", render("meetingAIWorkers.workers.capture-asr.enabled=true", success=False))

    def test_gateway_requires_origins_and_tls(self):
        values = tuple(value for value in self.settings if ".origins=" not in value)
        self.assertIn("origins", render(*values, "meetingAIWorkers.workers.capture-translation.enabled=true", success=False))
        self.assertIn("tlsSecret", render(*self.settings, "meetingAIWorkers.workers.capture-translation.enabled=true",
                      "meetingAIWorkers.gateway.ingress.enabled=true", "meetingAIWorkers.gateway.ingress.host=fixture.invalid", success=False))

    def test_partial_image_override_is_independent(self):
        rows = render(*self.settings, "meetingAIWorkers.workers.capture-asr.enabled=true",
                      "meetingAIWorkers.workers.capture-asr.imageTag=old-capture")
        row = next(row for row in rows if row["metadata"]["name"] == "meet-agent-capture-asr")
        self.assertEqual("lasuite/meet-agents:old-capture", row["spec"]["template"]["spec"]["containers"][0]["image"])


class MeetingAIReleaseTest(unittest.TestCase):
    def release(self, module, denied=False):
        bash = shutil.which("bash")
        git = shutil.which("git")
        if os.name == "nt" and git:
            candidate = pathlib.Path(git).parents[1] / "bin/bash.exe"
            if candidate.exists():
                bash = str(candidate)
        if not bash:
            self.skipTest("bash unavailable")

        def posix(path):
            value = pathlib.Path(path).as_posix()
            return f"/{value[0].lower()}{value[2:]}" if os.name == "nt" else value

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            scripts = {
                "git": """#!/usr/bin/env bash
case "$*" in
  *rev-parse*--is-inside-work-tree*) echo true ;;
  *branch*--show-current*) echo aliyun-dev ;;
esac
exit 0
""",
                "kubectl": """#!/usr/bin/env bash
case "$*" in
  *--ignore-not-found*)
    [[ "$FIXTURE_DENIED" == 1 ]] && exit 1
    [[ "$*" == *'meet-agent-translation '* ]] && echo deployment.apps/meet-agent-translation
    exit 0 ;;
  *jsonpath*) echo fixture/agents:old-tag ;;
esac
""",
                "helm": """#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FIXTURE_LOG"
""",
            }
            for name, source in scripts.items():
                path = root / name
                path.write_text(source, encoding="utf-8", newline="\n")
                path.chmod(0o755)
            values = root / "values.yaml"
            values.write_text("{}", encoding="utf-8")
            log = root / "helm.log"
            env = dict(os.environ, VALUES_FILE=posix(values), SECRETS_FILE=posix(values),
                       FIXTURE_LOG=posix(log), FIXTURE_DENIED="1" if denied else "0")
            command = f'export PATH="{posix(root)}:$PATH"; exec bash "{posix(ROOT / "deploy/aliyun/release-meet.sh")}" --tag new-tag --skip-git-pull --dry-run {module}'
            result = subprocess.run([bash, "-c", command], env=env, capture_output=True, text=True)
            return result, log.read_text(encoding="utf-8") if log.exists() else ""

    def test_agents_release_sets_all_optional_tags_without_enabling(self):
        result, log = self.release("agents")
        self.assertEqual(0, result.returncode, result.stderr)
        for key in WORKERS:
            self.assertIn(f"meetingAIWorkers.workers.{key}.imageTag=new-tag", log)
        self.assertNotIn(".enabled=", log)
        self.assertIn("--dry-run", log)

    def test_partial_release_preserves_only_existing_optional_worker(self):
        result, log = self.release("frontend")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("meetingAIWorkers.workers.translation.imageTag=old-tag", log)
        self.assertNotIn("meetingAIWorkers.workers.capture-asr.imageTag", log)

    def test_failed_cluster_read_prevents_helm(self):
        result, log = self.release("frontend", denied=True)
        self.assertNotEqual(0, result.returncode)
        self.assertEqual("", log)


if __name__ == "__main__":
    unittest.main()
