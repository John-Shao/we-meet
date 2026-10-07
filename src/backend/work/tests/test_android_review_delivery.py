"""Opt-in Android -> real PostgreSQL/API -> pinned Pi, with synthetic model SSE."""

import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from django.db import close_old_connections

import pytest
from rest_framework.test import APIClient

from .test_local_review_flow import (
    test_selected_local_files_to_review_with_lost_admission_ack as run_review_flow,
)
from .test_local_runs import local_settings
from .test_materials import client, work_settings

pytestmark = [
    pytest.mark.django_db(transaction=True),
    pytest.mark.skipif(
        os.environ.get("WORK_ANDROID_REVIEW_TEST") != "1",
        reason="explicit isolated Android/Pi opt-in required",
    ),
]


def test_android_reads_real_pi_review(client, settings, tmp_path, monkeypatch):
    """Production business endpoints; only authentication and supplier are fixtures."""
    assert os.environ.get("WORK_AGENT_PI_TEST_IMAGE"), "Pinned Pi image required"
    root = Path(__file__).resolve().parents[4]
    android = root.parent / "we-meet-android"
    output = Path(os.environ["WORK_ANDROID_REVIEW_OUTPUT"])
    output.mkdir(parents=True, exist_ok=True)
    sdk = Path(os.environ.get("ANDROID_HOME", "D:/ProgramData/AndroidSDK"))
    adb = sdk / "platform-tools/adb.exe"
    serial = os.environ.get("WORK_ANDROID_REVIEW_SERIAL", "emulator-5556")

    def device(*args, timeout=30):
        return subprocess.run(
            [str(adb), "-s", serial, *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=timeout,
            check=True,
        ).stdout

    def probe(run, review):
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
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                close_old_connections()
                try:
                    if (
                        self.headers.get("Authorization")
                        != "Bearer isolated-test-account"
                    ):
                        self.send_response(401)
                        self.end_headers()
                        return
                    if not self.path.startswith("/api/v1.0/work/"):
                        self.send_response(404)
                        self.end_headers()
                        return
                    api = APIClient()
                    api.force_authenticate(client.work_user)
                    result = api.get(self.path)
                    requests.append({"path": self.path, "status": result.status_code})
                    self.send_response(result.status_code)
                    self.send_header("Content-Type", result.get("Content-Type"))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(result.content)
                finally:
                    close_old_connections()

        server = ThreadingHTTPServer(("127.0.0.1", 48761), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        installed = test_installed = reversed_port = False
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
            test_installed = True
            result = device(
                "shell",
                "am",
                "instrument",
                "-w",
                "-r",
                "-e",
                "class",
                "com.we.meet.ui.work.WorkBackendReviewIntegrationTest",
                "-e",
                "workReviewCrossDevice",
                "1",
                "-e",
                "workReviewTask",
                str(run.task_id),
                "com.we.meet.fixturework.test/com.we.meet.ui.records.IsolatedRecordsRunner",
                timeout=180,
            )
            (output / "instrumentation.txt").write_text(result, encoding="utf-8")
            assert "OK (1 test)" in result and "FAILURES" not in result, result
            device(
                "pull",
                "/sdcard/Android/data/com.we.meet.fixturework/files/work-review-live",
                str(output),
                timeout=60,
            )
            assert any(
                item["path"] == f"/api/v1.0/work/runs/{run.pk}/reviews/"
                and item["status"] == 200
                for item in requests
            )
            (output / "backend.json").write_text(
                json.dumps(
                    {
                        "passed": True,
                        "auth": "isolated fixture; no production login",
                        "supplier": "synthetic SSE; no paid calls",
                        "pi_image": os.environ["WORK_AGENT_PI_TEST_IMAGE"],
                        "task_id": str(run.task_id),
                        "run_id": str(run.pk),
                        "review_id": str(review.pk),
                        "input_tokens": review.input_tokens,
                        "output_tokens": review.output_tokens,
                        "requests": requests,
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
        finally:
            if test_installed:
                device("uninstall", "com.we.meet.fixturework.test")
            if installed:
                device("uninstall", "com.we.meet.fixturework")
            if reversed_port:
                device("reverse", "--remove", "tcp:48761")
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    run_review_flow(client, settings, tmp_path, monkeypatch, "pi", delivery_probe=probe)
