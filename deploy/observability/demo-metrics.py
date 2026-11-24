#!/usr/bin/env python3
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock

counter = 0
lock = Lock()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/healthz":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"ok\n")
            return
        if self.path != "/metrics":
            self.send_error(404)
            return
        global counter
        with lock:
            counter += 1
            current = counter
        failed = Path(os.environ["WORK_DEMO_FAIL_FILE"]).exists()
        body = (
            "# HELP work_demo_requests_total Demo scrapes served by the C17 local probe.\n"
            "# TYPE work_demo_requests_total counter\n"
            f'work_demo_requests_total{{org_id="demo"}} {current}\n'
            "# HELP work_demo_failures_total Controlled C17 demo alert state.\n"
            "# TYPE work_demo_failures_total gauge\n"
            f'work_demo_failures_total{{org_id="demo"}} {1 if failed else 0}\n'
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        return


if __name__ == "__main__":
    address = os.environ["WORK_DEMO_METRICS_ADDR"]
    host, port = address.rsplit(":", 1)
    server = ThreadingHTTPServer((host, int(port)), Handler)
    server.daemon_threads = True
    server.serve_forever()
