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
    storage_settings = (
        "backend.envVars.AWS_S3_ENDPOINT_URL=https://storage.example.invalid",
        "backend.envVars.AWS_S3_ACCESS_KEY_ID=fixture-storage-key",
        "backend.envVars.AWS_S3_SECRET_ACCESS_KEY=fixture-storage-secret",
        "backend.envVars.AWS_STORAGE_BUCKET_NAME_VIDEO=fixture-private-video",
    )
    settings = (
        "meetingAIWorkers.credentialsSecret=fixture-ai",
        "meetingAIWorkers.backendUrl=http://meet-backend:8000",
        "meetingAIWorkers.livekitUrl=wss://livekit.example.invalid",
        "meetingAIWorkers.gateway.origins=https://meet.example.invalid",
        "meetingAIWorkers.image.tag=fixture-immutable",
    ) + storage_settings

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

    def test_import_enabled_with_multipart_headroom(self):
        config = yaml.safe_load((ROOT / "src/helm/env.d/aliyun-prod/values.meet.yaml").read_text(encoding="utf-8"))
        env = config["backend"]["envVars"]
        self.assertEqual("True", env["MEETING_FILE_ASR_ENABLED"])
        self.assertEqual(100 * 1024 * 1024, int(env["MEETING_FILE_ASR_MAX_BYTES"]))
        self.assertEqual("101m", config["ingress"]["annotations"]["nginx.ingress.kubernetes.io/proxy-body-size"])

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
                     "agentAIAssistant.envVars.DASHSCOPE_WORKSPACE_ID=fixture-workspace",
                     "backend.envVars.AGENT_INTERNAL_API_TOKEN=fixture-internal",
                     "backend.envVars.AWS_S3_ACCESS_KEY_ID=fixture-storage-key",
                     "backend.envVars.AWS_S3_SECRET_ACCESS_KEY=fixture-storage-secret",
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
            self.assertEqual("text-embedding-v4", env["QWEN_EMBEDDING_MODEL"]["value"])
        for name in ("meet-summary", "meet-celery-summarize", "meet-celery-summary-backend"):
            container = deployments[name]["spec"]["template"]["spec"]["containers"][0]
            env = {item["name"]: item for item in container["env"]}
            self.assertEqual("qwen3.8-flash", env["LLM_MODEL"]["value"])
            self.assertEqual("meet-ai-credentials", env["DASHSCOPE_API_KEY"]["valueFrom"]["secretKeyRef"]["name"])
        for worker in WORKERS:
            container = deployments[f"meet-agent-{worker}"]["spec"]["template"]["spec"]["containers"][0]
            self.assertTrue(container["image"].startswith("jusi-cn-guangzhou.cr.volces.com/we-meet/meet-agents:"))
        capture = deployments["meet-agent-capture-asr"]["spec"]["template"]["spec"]["containers"][0]
        capture_env = {item["name"]: item for item in capture["env"]}
        self.assertEqual(config["backend"]["envVars"]["AWS_STORAGE_BUCKET_NAME_VIDEO"],
                         capture_env["AWS_STORAGE_BUCKET_NAME"]["value"])
        self.assertEqual(config["backend"]["envVars"]["AWS_S3_ENDPOINT_URL"],
                         capture_env["AWS_S3_ENDPOINT_URL"]["value"])
        self.assertEqual("fixture-storage-key", capture_env["AWS_S3_ACCESS_KEY_ID"]["value"])
        subtitle = deployments["meet-agent-subtitles"]["spec"]["template"]["spec"]["containers"][0]
        env = {item["name"]: item for item in subtitle["env"]}
        self.assertEqual("qwen", env["STT_PROVIDER"]["value"])
        self.assertEqual("", env["TRANSLATION_TARGET_LANGS"]["value"])
        secret = next(row for row in rows if row["kind"] == "Secret" and row["metadata"]["name"] == "meet-ai-credentials")
        self.assertEqual("fixture-provider", secret["stringData"]["DASHSCOPE_API_KEY"])
        self.assertEqual("fixture-internal", secret["stringData"]["AGENT_INTERNAL_API_TOKEN"])
        self.assertEqual("fixture-livekit", secret["stringData"]["LIVEKIT_API_SECRET"])
        self.assertEqual("fixture-workspace", secret["stringData"]["DASHSCOPE_WORKSPACE_ID"])
        self.assertFalse(env["DASHSCOPE_WORKSPACE_ID"]["valueFrom"]["secretKeyRef"]["optional"])
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

    def test_managed_asr_requires_valid_workspace_before_any_cluster_write(self):
        credentials = (
            "meetingAIWorkers.backendUrl=http://backend.invalid",
            "meetingAIWorkers.credentialsFromExistingEnv=true",
            "meetingAIWorkers.credentialsSecret=fixture-ai",
            "agentAIAssistant.envVars.DASHSCOPE_API_KEY=fixture-provider",
            "backend.envVars.AGENT_INTERNAL_API_TOKEN=fixture-internal",
            "agentSubtitles.envVars.LIVEKIT_API_KEY=fixture-key",
            "agentSubtitles.envVars.LIVEKIT_API_SECRET=fixture-secret",
        )
        for enabled in ("meetingAIWorkers.workers.capture-live-asr.enabled=true",
                        "agentSubtitles.envVars.STT_PROVIDER=qwen"):
            with self.subTest(enabled=enabled):
                self.assertIn("DASHSCOPE_WORKSPACE_ID", render(*credentials, enabled, success=False))
                self.assertIn("DASHSCOPE_WORKSPACE_ID", render(*credentials, enabled,
                    "agentAIAssistant.envVars.DASHSCOPE_WORKSPACE_ID=invalid/workspace", success=False))
        # Translation-only installations do not need the ASR workspace.
        self.assertTrue(render(*credentials))
        # Whole-file ASR uses the API key; only realtime ASR requires a workspace.
        self.assertTrue(render(*credentials, *self.storage_settings,
                               "meetingAIWorkers.workers.capture-asr.enabled=true"))

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
            self.assertEqual(key != "capture-live-asr",
                             env["DASHSCOPE_WORKSPACE_ID"]["valueFrom"]["secretKeyRef"]["optional"])
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

    def capture_env(self, *values):
        rows = render(*self.settings, "meetingAIWorkers.workers.capture-asr.enabled=true", *values)
        row = next(row for row in rows if row["kind"] == "Deployment" and row["metadata"]["name"] == "meet-agent-capture-asr")
        return {item["name"]: item for item in row["spec"]["template"]["spec"]["containers"][0]["env"]}

    def test_file_asr_inherits_video_bucket_and_optional_storage_transport(self):
        env = self.capture_env("backend.envVars.AWS_S3_PUBLIC_ENDPOINT_URL=https://public.example.invalid",
                               "backend.envVars.AWS_S3_SECURE_ACCESS=false")
        self.assertEqual("fixture-private-video", env["AWS_STORAGE_BUCKET_NAME"]["value"])
        self.assertEqual("https://public.example.invalid", env["AWS_S3_PUBLIC_ENDPOINT_URL"]["value"])
        self.assertEqual("false", env["AWS_S3_SECURE_ACCESS"]["value"])

    def test_file_asr_preserves_explicit_worker_storage_and_secret_references(self):
        env = self.capture_env(
            "meetingAIWorkers.workers.capture-asr.envVars.AWS_STORAGE_BUCKET_NAME.secretKeyRef.name=worker-storage",
            "meetingAIWorkers.workers.capture-asr.envVars.AWS_STORAGE_BUCKET_NAME.secretKeyRef.key=bucket",
            "meetingAIWorkers.workers.capture-asr.envVars.AWS_S3_ACCESS_KEY_ID.secretKeyRef.name=worker-storage",
            "meetingAIWorkers.workers.capture-asr.envVars.AWS_S3_ACCESS_KEY_ID.secretKeyRef.key=access-key",
            "backend.envVars.AWS_S3_PUBLIC_ENDPOINT_URL=https://backend.example.invalid",
            "meetingAIWorkers.workers.capture-asr.envVars.AWS_S3_PUBLIC_ENDPOINT_URL=https://worker.example.invalid",
            "backend.envVars.AWS_S3_SECURE_ACCESS=true",
            "meetingAIWorkers.workers.capture-asr.envVars.AWS_S3_SECURE_ACCESS=false",
        )
        self.assertEqual({"name": "worker-storage", "key": "bucket"}, env["AWS_STORAGE_BUCKET_NAME"]["valueFrom"]["secretKeyRef"])
        self.assertEqual({"name": "worker-storage", "key": "access-key"}, env["AWS_S3_ACCESS_KEY_ID"]["valueFrom"]["secretKeyRef"])
        self.assertEqual("https://worker.example.invalid", env["AWS_S3_PUBLIC_ENDPOINT_URL"]["value"])
        self.assertEqual("false", env["AWS_S3_SECURE_ACCESS"]["value"])

    def test_file_asr_supports_explicit_backend_bucket_before_video_alias(self):
        env = self.capture_env("backend.envVars.AWS_STORAGE_BUCKET_NAME=backend-explicit")
        self.assertEqual("backend-explicit", env["AWS_STORAGE_BUCKET_NAME"]["value"])

    def test_file_asr_requires_bucket_when_neither_name_is_configured(self):
        error = render(*self.settings, "meetingAIWorkers.workers.capture-asr.enabled=true",
                       "backend.envVars.AWS_STORAGE_BUCKET_NAME_VIDEO=", success=False)
        self.assertIn("AWS_STORAGE_BUCKET_NAME_VIDEO", error)


class MeetingAIReleaseTest(unittest.TestCase):
    # 40 位 fixture commit: 前 9 位是 123456789.
    FULL_SHA = "1234567890abcdef1234567890abcdef12345678"

    def release(self, module, denied=False, tag="new-tag"):
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
                # `--short` 故意只回 8 位 —— 复现发布机与构建机缩写位数不一致的事故.
                "git": f"""#!/usr/bin/env bash
case "$*" in
  *rev-parse*--is-inside-work-tree*) echo true ;;
  *branch*--show-current*) echo aliyun-dev ;;
  *rev-parse*--short*) echo 12345678 ;;
  *rev-parse*HEAD*) echo {self.FULL_SHA} ;;
esac
# 会打印 commit 缩写的命令必须固定位数, 否则日志里同一个 commit 会同时出现
# 8 位和 9 位两个字符串.
case "$*" in
  *checkout*|*fetch*|*pull*) [[ "$*" == *"core.abbrev=9"* ]] || echo "GIT-ABBREV-MISSING: $*" >&2 ;;
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
            tag_arg = f"--tag {tag} " if tag else ""
            command = f'export PATH="{posix(root)}:$PATH"; exec bash "{posix(ROOT / "deploy/aliyun/release-meet.sh")}" {tag_arg}--skip-git-pull --dry-run {module}'
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

    def test_derived_tag_ignores_git_short_sha_length(self):
        # `git rev-parse --short` 的位数随仓库大小变化, 构建机 9 位 / 发布机 8 位
        # 会让发布指向不存在的镜像 (be9fdcdfe vs be9fdcdf). 标签必须取完整
        # SHA 的前 9 位, 与 `--short` 的输出无关.
        result, log = self.release("frontend", tag=None)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("frontend.image.tag=123456789", log)
        self.assertNotIn("frontend.image.tag=12345678\n", log)
        # 日志里不能出现没固定缩写的 git 输出, 也要说明 tag 就是那个 commit 的前缀.
        self.assertNotIn("GIT-ABBREV-MISSING", result.stderr)
        self.assertIn("first 9 chars of the commit above", result.stdout)

    def test_git_output_is_pinned_to_the_tag_length(self):
        result, _ = self.release("frontend")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertNotIn("GIT-ABBREV-MISSING", result.stderr)

    def test_explicit_short_tag_warns_about_truncation(self):
        result, log = self.release("frontend", tag="12345678")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("has 8 characters", result.stderr)
        self.assertIn("frontend.image.tag=12345678", log)
        self.assertIn("(explicit --tag)", result.stdout)


if __name__ == "__main__":
    unittest.main()
