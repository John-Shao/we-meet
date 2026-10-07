"""Opt-in real Android + Electron + Work/PostgreSQL + native dsh acceptance.

Authentication alone is an isolated fixture; no production login is claimed.
"""

import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from django.db import close_old_connections

import pytest
from rest_framework.test import APIClient

from core.models import AIUsageRecord

from work.models import WorkRun

from .test_local_runs import local_settings
from .test_materials import client, work_settings

pytestmark = [
    pytest.mark.django_db(transaction=True),
    pytest.mark.skipif(
        os.environ.get("WORK_CROSS_DEVICE_LIVE") != "1",
        reason="explicit isolated cross-device/model opt-in required",
    ),
]


def test_android_and_desktop_share_real_remote_task(client, settings):  # noqa: PLR0915
    settings.WORK_REMOTE_AGENT_ENABLED = True
    user = client.work_user
    user.language = "zh-cn"
    user.save(update_fields=["language"])
    root = Path(__file__).resolve().parents[4]
    desktop = root / "src/desktop"
    android = root.parent / "we-meet-android"
    output = Path(
        os.environ.get(
            "WORK_CROSS_DEVICE_OUTPUT",
            str(root / ".work-acceptance/work-cross-device-20261007"),
        )
    )
    output.mkdir(parents=True, exist_ok=True)
    assert not (output / "desktop-ready.json").exists(), (
        "Use WORK_CROSS_DEVICE_OUTPUT with a fresh receipt directory"
    )
    sdk = Path(os.environ.get("ANDROID_HOME", "D:/ProgramData/AndroidSDK"))
    adb = sdk / "platform-tools/adb.exe"
    serial = os.environ.get("WORK_CROSS_DEVICE_SERIAL", "emulator-5556")

    def device(*args, timeout=30):
        return subprocess.run(
            [str(adb), "-s", serial, *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=timeout,
            check=True,
        ).stdout

    assert not device(
        "shell", "pm", "list", "packages", "com.we.meet.fixturework"
    ).strip()
    assert "tcp:48761" not in device("reverse", "--list")
    meta = json.loads(
        (android / "app/build/outputs/apk/debug/output-metadata.json").read_text(
            "utf-8"
        )
    )
    assert meta["applicationId"] == "com.we.meet.fixturework"
    reports = []
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def handle_api(self):
            close_old_connections()
            try:
                if self.path.startswith("/api/v1.0/im/"):
                    self.send_response(503)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(
                        b'{"detail":"IM is outside isolated Work acceptance"}'
                    )
                    return
                size = int(self.headers.get("Content-Length", 0))
                assert 0 <= size <= 2100000
                body = self.rfile.read(size)
                api = APIClient()
                auth = self.headers.get("Authorization")
                if auth == "Bearer isolated-test-account":
                    api.force_authenticate(user)
                elif auth:
                    self.send_response(401)
                    self.end_headers()
                    return
                result = api.generic(
                    self.command, self.path, body, content_type="application/json"
                )
                requests.append(
                    {
                        "path": self.path,
                        "status": result.status_code,
                        "authenticated": bool(auth),
                    }
                )
                (output / "api-status.json").write_text(
                    json.dumps(requests), encoding="utf-8"
                )
                if self.path.endswith("/report/"):
                    reports.append(json.loads(body))
                self.send_response(result.status_code)
                self.send_header("Content-Type", result.get("Content-Type"))
                if result.get("Location"):
                    self.send_header("Location", result["Location"])
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(result.content)
            finally:
                close_old_connections()

        do_GET = handle_api
        do_POST = handle_api
        do_PATCH = handle_api

    server = ThreadingHTTPServer(("127.0.0.1", 48761), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    process = None
    installed = reversed_port = False
    thread.start()
    try:
        device("reverse", "tcp:48761", "tcp:48761")
        reversed_port = True
        device(
            "install",
            str(android / "app/build/outputs/apk/debug/app-debug.apk"),
            timeout=90,
        )
        installed = True
        device(
            "install",
            str(
                android
                / "app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
            ),
            timeout=90,
        )
        env = {
            **os.environ,
            "WORK_COORDINATION_URL": "http://127.0.0.1:48761",
            "WORK_CROSS_DEVICE_OUTPUT": str(output),
            "WE_MEET_LOCAL_KEY_FILE": os.environ["WORK_COORDINATION_LIVE_KEY_FILE"],
            "WORK_LOCAL_ALLOW_PAID": "1",
        }
        process = subprocess.Popen(
            ["node", "scripts/cross-device-acceptance.cjs"],
            cwd=desktop,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if (output / "desktop-ready.json").exists():
                break
            if process.poll() is not None:
                stdout, stderr = process.communicate()
                pytest.fail(stdout + stderr)
            time.sleep(0.2)
        assert (output / "desktop-ready.json").exists(), (
            "Desktop did not publish workspace"
        )
        instrument = device(
            "shell",
            "am",
            "instrument",
            "-w",
            "-e",
            "class",
            "com.we.meet.ui.work.WorkRemoteIntegrationTest",
            "-e",
            "workCrossDevice",
            "1",
            "com.we.meet.fixturework.test/com.we.meet.ui.records.IsolatedRecordsRunner",
            timeout=700,
        )
        (output / "android-instrumentation.txt").write_text(
            instrument, encoding="utf-8"
        )
        assert "OK (1 test)" in instrument, instrument
        for name in ("result.png", "receipt.json"):
            device(
                "pull",
                f"/sdcard/Android/data/com.we.meet.fixturework/files/work-cross-device/{name}",
                str(output / ("android-" + name)),
            )
        stdout, stderr = process.communicate(timeout=30)
        (output / "desktop-log.txt").write_text(stdout + stderr, encoding="utf-8")
        assert process.returncode == 0, stdout + stderr
        phone = json.loads((output / "android-receipt.json").read_text("utf-8"))
        pc = json.loads((output / "desktop-receipt.json").read_text("utf-8"))
        assert phone["run_id"] == pc["run_id"]
        assert phone["workspace_id"] == pc["workspace_id"]
        run = WorkRun.objects.get(pk=pc["run_id"])
        assert run.status == "succeeded" and run.execution_target == "local"
        assert list(run.files.values_list("name", flat=True)) == ["report.md"]
        assert WorkRun.objects.get(pk=phone["canceled_run_id"]).status == "canceled"
        assert not AIUsageRecord.objects.filter(ref_id=str(run.pk)).exists()
        assert "cross-device-marker" not in json.dumps(reports)
        (output / "receipt.json").write_text(
            json.dumps(
                {
                    "passed": True,
                    "run_id": str(run.pk),
                    "android": phone,
                    "desktop": pc,
                    "checks": [
                        "same-real-run-on-both-UIs",
                        "phone-dispatch-and-cancel",
                        "native-approval-before-execution",
                        "original-preserved",
                        "no-automatic-body-upload",
                        "explicit-sync-and-phone-SHA-preview",
                    ],
                    "limitation": "Isolated authentication and controlled native dialogs; not real login or clean Windows install.",
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    finally:
        if process and process.poll() is None:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                capture_output=True,
                check=False,
            )
            process.communicate(timeout=30)
        if installed:
            device("uninstall", "com.we.meet.fixturework.test")
            device("uninstall", "com.we.meet.fixturework")
        if reversed_port:
            device("reverse", "--remove", "tcp:48761")
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
