"""Work Helm and overlay tests; no production credentials or cluster calls."""

import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]


def render(*args):
    result = subprocess.run(
        [shutil.which("helm"), "template", "meet", str(ROOT / "src/helm/meet"), *args],
        capture_output=True,
        text=True,
        encoding="utf8",
    )
    return result, list(yaml.safe_load_all(result.stdout)) if result.returncode == 0 else []


@unittest.skipUnless(shutil.which("helm"), "helm not installed")
class WorkChartTest(unittest.TestCase):
    def test_default_has_no_work_worker(self):
        result, rows = render()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(
            any(row and row["metadata"]["name"] == "meet-celery-work" for row in rows)
        )

    def test_worker_requires_scheduler(self):
        result, _ = render("--set", "workWorker.enabled=true")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requires celeryBeat", result.stderr)

    def test_worker_inherits_backend_only_and_shares_image(self):
        result, rows = render(
            "--set",
            "workWorker.enabled=true,celeryBeat.enabled=true",
            "--set-string",
            "backend.image.tag=fixture-immutable",
            "--set-string",
            "backend.envVars.WORK_ENABLED=True",
            "--set-string",
            "backend.envVars.WORK_AGENT_ENABLED=True",
            "--set-string",
            "celeryBackend.envVars.OTHER_QUEUE_ONLY=not-work",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        row = next(
            row for row in rows if row and row["metadata"]["name"] == "meet-celery-work"
        )
        pod = row["spec"]["template"]["spec"]
        container = pod["containers"][0]
        self.assertTrue(container["image"].endswith(":fixture-immutable"))
        self.assertEqual(container["command"][-2:], ["-Q", "work"])
        self.assertIn("--pool=prefork", container["command"])
        env = {item["name"]: item for item in container["env"]}
        self.assertNotIn("OTHER_QUEUE_ONLY", env)
        self.assertEqual(env["WORK_ENABLED"]["value"], "True")
        self.assertEqual(env["WORK_AGENT_ENABLED"]["value"], "True")
        self.assertTrue(container["securityContext"]["readOnlyRootFilesystem"])
        self.assertEqual(container["resources"]["limits"]["memory"], "1Gi")
        self.assertEqual(pod["volumes"][0]["emptyDir"]["sizeLimit"], "256Mi")

    def test_work_overlay_enables_work_and_worker(self):
        result, rows = render(
            "-f", str(ROOT / "src/helm/env.d/aliyun-prod/values.work.yaml.dist")
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in ("meet-backend", "meet-celery-work", "meet-celery-beat"):
            row = next(
                row
                for row in rows
                if row and row["kind"] == "Deployment" and row["metadata"]["name"] == name
            )
            env = {
                item["name"]: item.get("value")
                for item in row["spec"]["template"]["spec"]["containers"][0]["env"]
            }
            self.assertEqual(env["WORK_ENABLED"], "True")
        script = (ROOT / "deploy/aliyun/release-meet.sh").read_text(encoding="utf8")
        self.assertIn('helm_args+=(-f "$WORK_VALUES_FILE")', script)
        self.assertIn('wait_for_deployment "$RELEASE-celery-work"', script)


class WorkEnableScriptTest(unittest.TestCase):
    def execute(self, mode, denied=False, initial=None):
        bash = shutil.which("bash")
        if os.name == "nt":
            candidate = pathlib.Path(shutil.which("git")).parents[1] / "bin/bash.exe"
            if candidate.exists():
                bash = str(candidate)
        if not bash:
            self.skipTest("bash unavailable")

        def posix(path):
            value = pathlib.Path(path).as_posix()
            return f'/{value[0].lower()}{value[2:]}' if os.name == "nt" else value

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "deploy/aliyun").mkdir(parents=True)
            (root / "bin").mkdir()
            shutil.copyfile(
                ROOT / "deploy/aliyun/enable-work.sh",
                root / "deploy/aliyun/enable-work.sh",
            )
            shutil.copyfile(
                ROOT / "deploy/aliyun/configure-work-overlay.py",
                root / "deploy/aliyun/configure-work-overlay.py",
            )
            (root / "src/helm/env.d/aliyun-prod").mkdir(parents=True)
            shutil.copyfile(
                ROOT / "src/helm/env.d/aliyun-prod/values.work.yaml.dist",
                root / "src/helm/env.d/aliyun-prod/values.work.yaml.dist",
            )
            (root / "deploy/aliyun/check-work-runtime.py").write_text(
                "# fixture only\n"
            )
            scripts = {
                "bin/kubectl": """#!/usr/bin/env bash
echo "kubectl $*" >> "$FIXTURE_LOG"
case "$*" in
  *exec*) cat >/dev/null; if [[ "$FIXTURE_DENIED" == 1 ]]; then exit 1; fi; echo '{"ok":true}' ;;
  *get*) echo 'registry.example.invalid/backend:e82d71f91' ;;
esac
""",
                "bin/helm": "#!/usr/bin/env bash\nexit 0\n",
                "bin/python3": f'#!/usr/bin/env bash\nexec "{posix(sys.executable)}" "$@"\n',
                "deploy/aliyun/release-meet.sh": '#!/usr/bin/env bash\necho "release $*" >> "$FIXTURE_LOG"\n',
            }
            for name, text in scripts.items():
                file = root / name
                file.write_text(text, encoding="utf8", newline="\n")
                file.chmod(0o755)
            log = root / "calls.log"
            overlay = root / "src/helm/env.d/aliyun-prod/values.work.yaml"
            if initial is not None:
                overlay.write_text(json.dumps(initial), encoding="utf8")
            env = dict(
                os.environ,
                FIXTURE_LOG=posix(log),
                FIXTURE_DENIED="1" if denied else "0",
                WORK_VALUES_FILE="src/helm/env.d/aliyun-prod/values.work.yaml",
            )
            command = f'export PATH="{posix(root / "bin")}:$PATH"; exec bash "{posix(root / "deploy/aliyun/enable-work.sh")}" {mode}'
            result = subprocess.run(
                [bash, "-c", command],
                env=env,
                capture_output=True,
                text=True,
                encoding="utf8",
            )
            return (
                result,
                log.read_text() if log.exists() else "",
                json.loads(overlay.read_text()) if overlay.exists() else None,
            )

    def test_check_never_writes_overlay_or_releases(self):
        result, log, overlay = self.execute("check")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(overlay)
        self.assertNotIn("release ", log)

    def test_runtime_failure_stops_before_flags_or_release(self):
        result, log, overlay = self.execute("on", denied=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(overlay)
        self.assertNotIn("release ", log)

    def test_enable_reuses_running_image_and_requires_worker(self):
        result, log, overlay = self.execute("on")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("release --skip-git-pull --tag e82d71f91 backend", log)
        self.assertIn("--require-enabled --require-worker", log)
        self.assertTrue(overlay["workWorker"]["enabled"])
        self.assertEqual(overlay["backend"]["envVars"]["WORK_ENABLED"], "True")

    def test_off_keeps_worker_but_disables_work_writes(self):
        result, log, overlay = self.execute("off")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(overlay["workWorker"]["enabled"])
        self.assertEqual(overlay["backend"]["envVars"]["WORK_ENABLED"], "False")
        self.assertIn("--require-disabled", log)


if __name__ == "__main__":
    unittest.main()
