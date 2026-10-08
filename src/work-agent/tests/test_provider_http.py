"""Real keep-alive sockets and bounded response lifecycle, without paid calls."""

import json
import os
import socket
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import HTTPError

import httpx

from work_agent.model_broker import ModelBroker
from work_agent.provider_http import ProviderHttpPool


class CountingServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), Upstream)
        self.connections = 0
        self.requests = []
        self.release = threading.Event()
        self.entered = threading.Event()
        self.hold_target = 1
        self.lock = threading.Lock()

    def get_request(self):
        connection, address = super().get_request()
        connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        with self.lock:
            self.connections += 1
        return connection, address


class Upstream(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def handle(self):
        try:
            super().handle()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass  # Expected when the caller rejects or abandons a bounded response.

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        with self.server.lock:
            self.server.requests.append((self.path, dict(self.headers), body))
        status = 200
        payload = b'{"choices": [], "usage": {"prompt_tokens": 8, '
        payload += b'"completion_tokens": 2, "total_tokens": 10}}'
        if json.loads(body).get("stream"):
            payload = b'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
            payload += (
                b'data: {"choices":[],"usage":{"prompt_tokens":8,'
                b'"completion_tokens":2,"total_tokens":10}}\n\ndata: [DONE]\n\n'
            )
        if self.path == "/redirect":
            status = 307
        elif self.path == "/failure":
            status = 503
        elif self.path == "/large":
            payload = b"x" * 500_000
        elif self.path == "/stream":
            payload = 'data: {"text":"你好"}\r\n\r\ndata: [DONE]\n\n'.encode()
        elif self.path == "/drop":
            self.connection.shutdown(socket.SHUT_RDWR)
            self.close_connection = True
            return
        self.send_response(status)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Set-Cookie", "session=must-not-cross-tasks")
        if status == 307:
            self.send_header("Location", "/redirect-target")
        self.end_headers()
        if self.path == "/hold":
            with self.server.lock:
                count = sum(r[0] == "/hold" for r in self.server.requests)
                if count >= self.server.hold_target:
                    self.server.entered.set()
            self.server.release.wait(5)
        try:
            # Deliberately split UTF-8 and SSE delimiters across HTTP chunks.
            if self.path == "/stream":
                for byte in payload:
                    self.wfile.write(bytes([byte]))
                    self.wfile.flush()
            else:
                self.wfile.write(payload)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


class ProviderHttpTests(unittest.TestCase):
    def setUp(self):
        self.server = CountingServer()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.pools = []

    def tearDown(self):
        self.server.release.set()
        for pool in self.pools:
            pool.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)

    def pool(self, **kwargs):
        pool = ProviderHttpPool(**kwargs)
        self.pools.append(pool)
        return pool

    def open(self, pool, path="/json", key="key-a", timeout=2):
        return pool.open(
            self.url + path,
            b"{}",
            {"Authorization": "Bearer " + key, "Content-Type": "application/json"},
            timeout,
        )

    def test_sequential_requests_from_distinct_threads_reuse_one_tcp_connection(self):
        pool = self.pool()
        for _ in range(12):

            def request():
                with self.open(pool) as response:
                    return json.loads(response.read(1000))

            with ThreadPoolExecutor(1) as executor:
                self.assertEqual(executor.submit(request).result()["choices"], [])
        self.assertEqual(self.server.connections, 1)
        self.assertEqual(len(self.server.requests), 12)

    def test_auth_is_per_request_and_cookies_do_not_cross_tasks(self):
        pool = self.pool()
        for key in ("key-a", "key-b"):
            with self.open(pool, key=key) as response:
                response.read(1000)
        headers = [request[1] for request in self.server.requests]
        self.assertEqual(
            [h["Authorization"] for h in headers], ["Bearer key-a", "Bearer key-b"]
        )
        self.assertTrue(all("Cookie" not in h for h in headers))
        self.assertFalse(pool.client.cookies)

    def test_brokers_have_independent_pools_and_credentials(self):
        config = SimpleNamespace(provider="qwen", base_url=self.url, model="qwen-test")
        first, second = ModelBroker(config, None), ModelBroker(config, None)
        try:
            for broker, key in ((first, "key-a"), (second, "key-b")):
                with patch.dict(os.environ, {"DASHSCOPE_API_KEY": key}):
                    with broker.open_provider(b"{}", 2) as response:
                        response.read(1000)
            self.assertEqual(self.server.connections, 2)
            first.close()
            first.close()
            with patch.dict(os.environ, {"DASHSCOPE_API_KEY": "key-b"}):
                with second.open_provider(b"{}", 2) as response:
                    response.read(1000)
            self.assertEqual(self.server.connections, 2)
        finally:
            first.close()
            second.close()

    def test_split_sse_preserves_bytes_and_line_boundaries(self):
        pool = self.pool(max_connections=1, max_keepalive_connections=1)
        with self.open(pool, "/stream") as response:
            self.assertEqual(
                response.readline(200_001), 'data: {"text":"你好"}\r\n'.encode()
            )
            self.assertEqual(response.readline(200_001), b"\r\n")
            self.assertEqual(response.readline(200_001), b"data: [DONE]\n")
            self.assertEqual(response.readline(200_001), b"\n")
            self.assertEqual(response.readline(200_001), b"")
            # EOF releases the lease, even if the caller is still in the context.
            self.assertEqual(pool.active, 0)
            with self.open(pool) as other:
                other.read(1000)
        self.assertEqual(self.server.connections, 1)

    def test_bounded_read_and_early_close_release_the_only_slot(self):
        pool = self.pool(max_connections=1, max_keepalive_connections=1)
        with self.open(pool, "/large") as response:
            self.assertEqual(len(response.read(17)), 17)
        self.assertEqual(pool.active, 0)
        with self.open(pool) as response:
            self.assertTrue(response.read(1000))

    def test_bounded_readline_does_not_buffer_the_entire_response(self):
        pool = self.pool()
        with self.open(pool, "/large") as response:
            self.assertEqual(len(response.readline(200_001)), 200_001)
        self.assertEqual(pool.active, 0)

    def test_http_errors_and_redirects_are_closed_without_retry(self):
        pool = self.pool(max_connections=1, max_keepalive_connections=1)
        for path, status in (("/failure", 503), ("/redirect", 307)):
            with self.assertRaises(HTTPError) as caught:
                with self.open(pool, path):
                    self.fail("error response must not reach the caller")
            self.assertEqual(caught.exception.code, status)
            self.assertEqual(pool.active, 0)
        with self.open(pool) as response:
            response.read(1000)
        self.assertEqual(
            [r[0] for r in self.server.requests], ["/failure", "/redirect", "/json"]
        )

    def test_disconnect_does_not_repeat_a_paid_post_and_releases_slot(self):
        pool = self.pool(max_connections=1, max_keepalive_connections=1)
        with self.assertRaises(httpx.RemoteProtocolError):
            with self.open(pool, "/drop"):
                pass
        self.assertEqual(pool.active, 0)
        with self.open(pool) as response:
            response.read(1000)
        self.assertEqual([r[0] for r in self.server.requests], ["/drop", "/json"])

    def test_pool_exhaustion_wait_is_bounded_and_does_not_send_a_request(self):
        pool = self.pool(max_connections=1, max_keepalive_connections=1)
        with self.open(pool, "/hold") as held:
            self.assertTrue(self.server.entered.wait(2))
            with self.assertRaises(httpx.PoolTimeout):
                with self.open(pool, timeout=0.05):
                    pass
            self.assertEqual(len(self.server.requests), 1)
            self.assertEqual(pool.active, 1)
            self.server.release.set()
            held.read(1000)
        with self.open(pool) as response:
            response.read(1000)
        self.assertEqual(self.server.connections, 1)

    def test_concurrent_requests_are_bounded_and_keep_credentials_isolated(self):
        pool = self.pool(max_connections=2, max_keepalive_connections=2)
        self.server.hold_target = 2

        def request(index):
            with self.open(pool, "/hold", key=f"task-{index}") as response:
                return json.loads(response.read(1000))["usage"]["total_tokens"]

        with ThreadPoolExecutor(8) as executor:
            futures = [executor.submit(request, i) for i in range(8)]
            try:
                self.assertTrue(self.server.entered.wait(2))
                self.assertEqual(len(self.server.requests), 2)
            finally:
                self.server.release.set()
            self.assertEqual([f.result(5) for f in futures], [10] * 8)
        self.assertEqual(self.server.connections, 2)
        self.assertEqual(
            {r[1]["Authorization"] for r in self.server.requests},
            {f"Bearer task-{i}" for i in range(8)},
        )
        self.assertEqual(pool.active, 0)

    def test_shutdown_rejects_new_requests_and_drains_active_response(self):
        pool = self.pool()
        with self.open(pool, "/hold") as held:
            pool.close()
            self.assertFalse(pool.client.is_closed)
            with self.assertRaisesRegex(RuntimeError, "closed"):
                with self.open(pool):
                    pass
            self.server.release.set()
            self.assertTrue(held.read(1000))
            self.assertTrue(pool.client.is_closed)
        pool.close()
        self.assertEqual(pool.active, 0)

    def test_response_read_timeout_releases_slot(self):
        pool = self.pool(max_connections=1, max_keepalive_connections=1)
        with self.assertRaises(httpx.ReadTimeout):
            with self.open(pool, "/hold", timeout=0.05) as response:
                response.read(1000)
        self.server.release.set()
        self.assertEqual(pool.active, 0)
        with self.open(pool) as response:
            response.read(1000)

    def test_child_process_must_construct_its_own_pool(self):
        pool = self.pool()
        with patch("work_agent.provider_http.os.getpid", return_value=pool.pid + 1):
            with self.assertRaisesRegex(RuntimeError, "after forking"):
                with self.open(pool):
                    pass
        self.assertEqual(len(self.server.requests), 0)


if __name__ == "__main__":
    unittest.main()
