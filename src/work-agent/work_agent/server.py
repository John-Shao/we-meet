"""Private, authenticated HTTP boundary. One process per state directory."""

import argparse
import hmac
import json
import os
import subprocess
import threading
import uuid
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from . import CONTRACT
from .config import Config, load_env
from .contract import MAX_REQUEST_BYTES, ContractError, validate_request
from .model_broker import ModelBroker
from .store import Store
from .worker import Worker


class Gateway:
    def __init__(self, config, host="127.0.0.1", port=0):
        if config.execution == "docker":
            image_id = (
                subprocess.check_output(
                    ["docker", "image", "inspect", "--format", "{{.Id}}", config.image],
                    timeout=10,
                    stderr=subprocess.DEVNULL,
                )
                .decode()
                .strip()
            )
            if not image_id.startswith("sha256:"):
                raise ValueError("invalid image ID")
            config = replace(config, image=image_id)
        self.config = config
        config.root.mkdir(parents=True, exist_ok=True)
        # A second process must not mark the first process's executions unknown.
        self.owner = open(config.root / "gateway.lock", "a+b")
        self.owner.seek(0)
        self.owner.write(b"0")
        self.owner.flush()
        self.owner.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self.owner.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.owner.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.owner.close()
            raise RuntimeError("state directory already in use") from None
        self.store = Store(config.root / "jobs.sqlite3")
        self.broker = (
            ModelBroker(config, self.store) if config.engine != "fixture" else None
        )
        self.worker = Worker(config, self.store, self.broker)
        self.http = ThreadingHTTPServer((host, port), self.handler())
        self.http.daemon_threads = True
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)

    def start(self):
        if self.broker:
            self.broker.start()
        self.worker.start()
        self.thread.start()

    def close(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=5)
        self.worker.close()
        if self.broker:
            self.broker.close()
        self.store.close()
        self.owner.close()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.http.server_port}"

    def handler(self):
        gateway = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass  # URLs, request bodies and provider diagnostics stay private.

            def reply(self, status, body):
                encoded = json.dumps(body, ensure_ascii=False).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(encoded)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(encoded)

            def handle_request(self):
                self.connection.settimeout(5)
                try:
                    expected = "Bearer " + gateway.config.token
                    if not hmac.compare_digest(
                        self.headers.get("Authorization", "").encode(),
                        expected.encode(),
                    ):
                        raise ContractError("unauthorized", 401)
                    parsed = urlsplit(self.path)
                    if self.command == "GET" and parsed.path == "/v1/capabilities":
                        return self.reply(200, gateway.config.capabilities())
                    if self.command == "POST" and parsed.path == "/v1/jobs":
                        if self.headers.get("Transfer-Encoding"):
                            raise ContractError("invalid_request")
                        size = int(self.headers.get("Content-Length", "0"))
                        if not 0 < size <= MAX_REQUEST_BYTES:
                            raise ContractError("request_too_large", 413)
                        if self.headers.get_content_type() != "application/json":
                            raise ContractError("invalid_content_type", 415)
                        body = validate_request(json.loads(self.rfile.read(size)))
                        fresh = gateway.store.admit(body, gateway.config.capabilities())
                        return self.reply(
                            202 if fresh else 200, gateway.store.get(body["run_id"])
                        )
                    if parsed.path.startswith("/v1/jobs/"):
                        suffix = parsed.path[len("/v1/jobs/") :]
                        if self.command == "POST" and suffix.endswith("/cancel"):
                            run_id = suffix[: -len("/cancel")]
                            if str(uuid.UUID(run_id)) != run_id:
                                raise ContractError("invalid_run_id")
                            gateway.store.cancel(run_id)
                            return self.reply(200, gateway.store.get(run_id))
                        if self.command == "GET" and "/" not in suffix:
                            after = int(parse_qs(parsed.query).get("after", ["0"])[0])
                            if after < 0:
                                raise ContractError("invalid_cursor")
                            return self.reply(200, gateway.store.get(suffix, after))
                    raise ContractError("not_found", 404)
                except ContractError as exc:
                    self.reply(
                        exc.status, {"contract": CONTRACT, "error_code": exc.code}
                    )
                except (ValueError, TypeError, UnicodeError):
                    self.reply(
                        400, {"contract": CONTRACT, "error_code": "invalid_request"}
                    )
                except Exception:
                    self.reply(
                        500, {"contract": CONTRACT, "error_code": "gateway_error"}
                    )
                finally:
                    self.close_connection = True

            do_GET = handle_request
            do_POST = handle_request

        return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", choices=["dsh", "pi", "fixture"], required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8881)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--model", default="deepseek-flash")
    parser.add_argument("--image")
    parser.add_argument("--env-file", type=Path)
    args = parser.parse_args()
    if args.env_file:
        load_env(args.env_file)
    config = Config(
        engine=args.engine,
        root=args.state_dir.resolve(),
        token=os.environ.get("WORK_AGENT_TOKEN", ""),
        model=args.model,
        execution="fixture" if args.engine == "fixture" else "docker",
        image=args.image or f"we-meet-work-agent:{args.engine}-poc",
    )
    gateway = Gateway(config, args.host, args.port)
    gateway.start()
    try:
        gateway.thread.join()
    except KeyboardInterrupt:
        pass
    finally:
        gateway.close()


if __name__ == "__main__":
    main()
