"""Opt-in real API -> Node coordinator -> native dsh -> DeepSeek acceptance.

Business authentication is a synthetic isolated account; API views, PostgreSQL,
the adapter and model requests are real. No production service is contacted.
"""

import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from django.db import close_old_connections

import pytest
from rest_framework.test import APIClient

from core.models import AIUsageRecord

from work import services
from work.models import WorkMaterial, WorkRun

from .test_local_runs import local_settings
from .test_materials import client, upload, work_settings

pytestmark = [
    pytest.mark.django_db(transaction=True),
    pytest.mark.skipif(
        not os.environ.get("WORK_COORDINATION_LIVE_KEY_FILE"),
        reason="explicit isolated real-model acceptance only",
    ),
]


@pytest.mark.parametrize("remote", [False, True])
def test_native_execution_with_authorized_cloud_context(client, settings, remote):
    settings.WORK_REMOTE_AGENT_ENABLED = remote
    response = upload(client, data=b"cloud-marker-4681\n", name="context.md")
    assert response.status_code == 201
    assert services.process_materials() == 1
    material = WorkMaterial.objects.get(pk=response.data["id"])
    sources = [
        {
            "id": str(material.pk),
            "checksum": material.checksum,
            "parser_version": material.parser_version,
            "generation": material.generation,
        }
    ]
    user = client.work_user

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def handle_api(self):
            close_old_connections()
            try:
                assert (
                    self.headers.get("Authorization") == "Bearer isolated-test-account"
                )
                size = int(self.headers.get("Content-Length", 0))
                assert 0 <= size <= 2100000
                api = APIClient()
                api.force_authenticate(user)
                result = api.generic(
                    self.command,
                    self.path,
                    self.rfile.read(size),
                    content_type="application/json",
                )
                self.send_response(result.status_code)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(result.content)
            finally:
                close_old_connections()

        do_GET = handle_api
        do_POST = handle_api

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    desktop = Path(__file__).resolve().parents[3] / "desktop"
    receipt = desktop.parents[1] / (
        ".work-acceptance/work-delivery-20261007/remote/live.json"
        if remote
        else ".work-acceptance/work-coordination-20261007/live.json"
    )
    receipt.parent.mkdir(parents=True, exist_ok=True)
    env = {
        **os.environ,
        "WE_MEET_LOCAL_KEY_FILE": os.environ["WORK_COORDINATION_LIVE_KEY_FILE"],
        "WORK_LOCAL_ALLOW_PAID": "1",
        "WORK_COORDINATION_URL": f"http://127.0.0.1:{server.server_port}",
        "WORK_COORDINATION_SOURCES": json.dumps(sources),
        "WORK_COORDINATION_RECEIPT": str(receipt),
        "WORK_COORDINATION_REMOTE": "1" if remote else "0",
    }
    try:
        process = subprocess.run(
            ["node", "scripts/coordination-acceptance.cjs"],
            cwd=desktop,
            env=env,
            timeout=700,
            capture_output=True,
            check=False,
            text=True,
        )
        assert process.returncode == 0, process.stdout + process.stderr
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    evidence = json.loads(receipt.read_text())
    run = WorkRun.objects.get(pk=evidence["run_id"])
    assert run.status == "succeeded" and run.execution_target == "local"
    assert run.usage_origin == "device_reported" and run.local_report_seq >= 2
    assert list(run.files.values_list("name", flat=True)) == ["report.md"]
    assert not AIUsageRecord.objects.filter(ref_id=str(run.pk)).exists()
