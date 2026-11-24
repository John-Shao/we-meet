#!/usr/bin/env python3
import json
import os
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_BODY = 1024 * 1024
ALLOWED_LABELS = {"alertname", "severity", "alert_class", "org_id", "job", "instance"}
ALLOWED_ANNOTATIONS = {
    "summary": "C17 local demo alert pipeline probe",
    "runbook": "docs/work/operations.md",
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/healthz":
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"ok\n")

    def do_POST(self):
        if self.path != "/alerts":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(400)
            return
        if length <= 0 or length > MAX_BODY:
            self.send_error(400)
            return
        try:
            payload = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_error(400)
            return
        if not isinstance(payload, dict) or not isinstance(payload.get("alerts"), list):
            self.send_error(400)
            return
        alerts = []
        for alert in payload["alerts"]:
            if not isinstance(alert, dict):
                self.send_error(400)
                return
            labels = alert.get("labels", {})
            annotations = alert.get("annotations", {})
            if not isinstance(labels, dict) or not isinstance(annotations, dict):
                self.send_error(400)
                return
            if set(labels) - ALLOWED_LABELS or annotations != ALLOWED_ANNOTATIONS:
                self.send_error(400)
                return
            if (
                labels.get("alertname") != "WorkObservabilityDemoFailure"
                or labels.get("alert_class") != "demo"
                or labels.get("org_id") != "demo"
                or labels.get("severity") != "ticket"
                or labels.get("job") != "work-demo"
                or labels.get("instance") != "127.0.0.1:19092"
                or alert.get("status") not in {"firing", "resolved"}
            ):
                self.send_error(400)
                return
            alerts.append({
                "status": alert["status"],
                "labels": {key: labels[key] for key in sorted(labels)},
            })
        record = {
            "received_at": datetime.now(timezone.utc).isoformat(),
            "receiver": "demo-webhook",
            "alerts": alerts,
        }
        path = Path(os.environ["WORK_WEBHOOK_DATA_FILE"])
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(descriptor, (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode())
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"ok\n")

    def log_message(self, _format, *_args):
        return


if __name__ == "__main__":
    address = os.environ["WORK_DEMO_WEBHOOK_ADDR"]
    host, port = address.rsplit(":", 1)
    server = ThreadingHTTPServer((host, int(port)), Handler)
    server.daemon_threads = True
    server.serve_forever()
