"""Measure provider resource reuse against a loopback-only fake model server."""

import argparse
import asyncio
import importlib
import json
import statistics
import socket
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Server(ThreadingHTTPServer):
    """Count accepted sockets, requests and task isolation errors."""

    request_queue_size = 128

    def __init__(self):
        """Listen on loopback only; all credentials and data are fake."""
        self.connections = 0
        self.requests = 0
        self.errors = 0
        self.guard = threading.Lock()
        super().__init__(("127.0.0.1", 0), Handler)

    def get_request(self):
        """Count new TCP connections instead of recycled source port numbers."""
        result = super().get_request()
        result[0].setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        with self.guard:
            self.connections += 1
        return result


class Handler(BaseHTTPRequestHandler):
    """Reply with synthetic OpenAI-compatible completions or Filetrans bodies."""

    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        """Suppress request logs so no payload or credential is printed."""

    def do_POST(self):
        """Validate individual request identity and return its fake result."""
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        index = int(body["messages"][0]["content"])
        self.respond(index)

    def do_GET(self):
        """Return fake polling/download data."""
        self.respond(int(self.path.rsplit("=", 1)[1]))

    def respond(self, index):
        """Ensure sockets share no task credentials or cookies."""
        expected = (
            None if self.path.startswith("/result") else f"Bearer fake-{index % 2}"
        )
        with self.server.guard:
            self.server.requests += 1
            if self.headers.get("Authorization") != expected or self.headers.get(
                "Cookie"
            ):
                self.server.errors += 1
        data = json.dumps(
            {
                "id": "synthetic",
                "object": "chat.completion",
                "created": 1,
                "model": "synthetic",
                "index": str(index),
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": str(index),
                        },
                    }
                ],
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Set-Cookie", "private=must-not-cross-tasks")
        self.end_headers()
        self.wfile.write(data)


def measure(args, reused):
    """Run a bounded synthetic workload without business or model endpoints."""
    server = Server()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}"
    elapsed = []
    clients = set()
    guard = threading.Lock()
    started = time.perf_counter()
    if args.service == "agent":
        pool = importlib.import_module("plugins.qwen.http_pool")

        async def run():
            semaphore = asyncio.Semaphore(args.concurrency)

            async def call(index):
                async with semaphore:
                    before = time.perf_counter()
                    async with pool.filetrans_http_client() as client:
                        clients.add(id(client))
                        body = {"messages": [{"role": "user", "content": str(index)}]}
                        headers = {"Authorization": f"Bearer fake-{index % 2}"}
                        async with client.post(
                            url + "/submit", json=body, headers=headers
                        ) as response:
                            assert (await response.json())["index"] == str(index)
                        for path, request_headers in (
                            ("poll", headers),
                            ("result", {}),
                        ):
                            async with client.get(
                                f"{url}/{path}?index={index}", headers=request_headers
                            ) as response:
                                assert (await response.json())["index"] == str(index)
                    elapsed.append((time.perf_counter() - before) * 1000)

            async with pool.filetrans_http_pool(enabled=reused):
                await asyncio.gather(*(call(index) for index in range(args.tasks)))

        asyncio.run(run())
    else:
        name = "core.services" if args.service == "backend" else "summary.core"
        pool = importlib.import_module(name + ".provider_llm")
        sdk = importlib.import_module("openai")

        def call(index):
            before = time.perf_counter()
            configuration = {
                "api_key": f"fake-{index % 2}",
                "base_url": url + "/v1",
                "max_retries": 0,
            }
            if args.service == "summary":
                configuration["timeout"] = sdk.DEFAULT_TIMEOUT
            if reused:
                client = pool.acquire(**configuration)
                actual = client._entry.client
            elif args.service == "summary":
                client = sdk.OpenAI(**configuration)
                actual = client
            else:
                client = sdk.OpenAI(
                    **configuration, http_client=pool.sdk_http_client(60)
                )
                actual = client
            with guard:
                clients.add(id(actual))
            try:
                response = client.chat.completions.create(
                    model="synthetic",
                    messages=[{"role": "user", "content": str(index)}],
                )
                assert response.choices[0].message.content == str(index)
            finally:
                client.close()
            with guard:
                elapsed.append((time.perf_counter() - before) * 1000)

        with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
            list(executor.map(call, range(args.tasks)))
        pool.shutdown()
        http = importlib.import_module(name + ".provider_http")
        http.shutdown()
        http.reset_after_fork()
    wall = time.perf_counter() - started
    server.shutdown()
    server.server_close()
    thread.join()
    values = sorted(elapsed)
    assert not server.errors
    return {
        "reused": reused,
        "tasks": args.tasks,
        "concurrency": args.concurrency,
        "requests": server.requests,
        "connections": server.connections,
        "clients": len(clients) if reused else args.tasks,
        "isolation_errors": server.errors,
        "seconds": round(wall, 3),
        "p50_ms": round(statistics.median(values), 2),
        "p95_ms": round(values[int(len(values) * 0.95) - 1], 2),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--service", choices=["backend", "summary", "agent"], required=True
    )
    parser.add_argument("--root", required=True)
    parser.add_argument("--tasks", type=int, default=256)
    parser.add_argument("--concurrency", type=int, default=16)
    args = parser.parse_args()
    if not 1 <= args.tasks <= 4096 or not 1 <= args.concurrency <= 64:
        parser.error("workload exceeds the synthetic probe limits")
    sys.path.insert(0, args.root)
    # Load lazy SDK serializers before timing either comparison.
    warmup = argparse.Namespace(**vars(args))
    warmup.tasks = min(args.tasks, 16)
    measure(warmup, False)
    print(
        json.dumps(
            {
                "service": args.service,
                "baseline": measure(args, False),
                "pooled": measure(args, True),
            }
        )
    )
