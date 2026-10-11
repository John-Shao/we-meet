"""Isolated HTTPS file-ASR protocol fixture that really reads a signed MinIO object.

It generates fixed text, not speech recognition. Never accepts arbitrary URLs,
contacts DashScope or fabricates application records, dispatches or identity jobs.
"""

# A disposable container listener and fixed aggregate output are intentional.
# ruff: noqa: S104, T201

import hashlib
import io
import json
import os
import ssl
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_AUDIO_BYTES = 4 * 1024 * 1024
MODEL = "qwen-audio-3.1-asr-flash-filetrans"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise ValueError("filetrans_fixture_redirect_rejected")


def read_audio(url):
    """Only this owned network's private prepared source may be fetched."""
    parsed = urlsplit(url)
    if (
        parsed.scheme != "http"
        or parsed.hostname != "backend"
        or parsed.port != 9000
        or parsed.username
        or parsed.password
        or not parsed.path.startswith(
            "/voiceprint-rtc-fixture/record-uploads/identity-input-"
        )
        or not parsed.query
        or parsed.fragment
    ):
        raise ValueError("filetrans_fixture_source_rejected")
    with build_opener(NoRedirect).open(Request(url), timeout=10) as response:  # noqa: S310 -- Exact internal origin above, signed private object only.
        data = response.read(MAX_AUDIO_BYTES + 1)
    if len(data) > MAX_AUDIO_BYTES:
        raise ValueError("filetrans_fixture_source_too_large")
    with wave.open(io.BytesIO(data), "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            raise ValueError("filetrans_fixture_audio_invalid")
        duration = audio.getnframes() * 1000 // audio.getframerate()
    if duration != 30000:
        raise ValueError("filetrans_fixture_duration_invalid")
    return duration, hashlib.sha256(data).hexdigest(), len(data)


def main():
    configuration = json.loads(Path(os.environ["FILETRANS_FIXTURE_CONFIG"]).read_text())
    token = configuration["token"]
    lock = threading.Lock()
    observations = {
        "submissions": 0,
        "polls": 0,
        "result_reads": 0,
        "signed_audio_reads": 0,
    }
    result = None

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def respond(self, value, status=200):
            raw = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "private, no-store")
            self.end_headers()
            self.wfile.write(raw)

        def authorized(self):
            return self.headers.get("Authorization") == "Bearer " + token

        def do_POST(self):
            nonlocal result
            if (
                self.path != "/api/v1/services/audio/asr/transcription"
                or not self.authorized()
            ):
                self.respond({"code": "fixture_request_rejected"}, 403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 16384:
                    raise ValueError
                body = json.loads(self.rfile.read(length))
                if (
                    body["model"] != MODEL
                    or body["parameters"]["diarization_enabled"] is not True
                    or len(body["input"]["file_urls"]) != 1
                    or self.headers.get("X-DashScope-Async") != "enable"
                ):
                    raise ValueError
                duration, digest, size = read_audio(body["input"]["file_urls"][0])
                with lock:
                    if observations["submissions"]:
                        self.respond({"code": "fixture_duplicate_submission"}, 409)
                        return
                    observations["submissions"] += 1
                    observations["signed_audio_reads"] += 1
                    observations["audio_sha256"] = digest
                    observations["audio_bytes"] = size
                    result = {
                        "properties": {"original_duration_in_milliseconds": duration},
                        "transcripts": [
                            {
                                "sentences": [
                                    {
                                        "text": "Synthetic import protocol sentence "
                                        + str(index + 1),
                                        "begin_time": index * 10000,
                                        "end_time": (index + 1) * 10000,
                                        "speaker_id": 0,
                                        "language": "en",
                                    }
                                    for index in range(3)
                                ]
                            }
                        ],
                    }
                self.respond({"output": {"task_id": "synthetic-filetrans-task"}})
            except Exception:  # noqa: BLE001 -- Fixed fixture errors must not expose signed URLs or tokens.
                self.respond({"code": "fixture_submission_invalid"}, 400)

        def do_GET(self):
            if self.path == "/fixture-evidence" and self.authorized():
                with lock:
                    self.respond(dict(observations))
            elif (
                self.path == "/api/v1/tasks/synthetic-filetrans-task"
                and self.authorized()
            ):
                with lock:
                    if result is None:
                        self.respond({"code": "fixture_no_submission"}, 404)
                        return
                    observations["polls"] += 1
                self.respond(
                    {
                        "output": {
                            "task_status": "SUCCEEDED",
                            "results": [
                                {
                                    "subtask_status": "SUCCEEDED",
                                    "transcription_url": "https://filetrans.aliyuncs.com/results/synthetic-task",
                                }
                            ],
                        },
                        "usage": {"duration": 30},
                    }
                )
            elif self.path == "/results/synthetic-task" and result is not None:
                if self.headers.get("Authorization"):
                    self.respond({"code": "fixture_result_credential_leak"}, 403)
                    return
                with lock:
                    observations["result_reads"] += 1
                    self.respond(result)
            else:
                self.respond({"code": "fixture_request_rejected"}, 403)

    server = ThreadingHTTPServer(("0.0.0.0", 443), Handler)
    server.daemon_threads = True
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(configuration["certificate"], configuration["key"])
    server.socket = context.wrap_socket(server.socket, server_side=True)
    print(json.dumps({"event": "filetrans_fixture_ready"}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
