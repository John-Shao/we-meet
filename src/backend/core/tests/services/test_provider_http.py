"""Real keepalive reuse, credential isolation, retry and SDK-close semantics."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest

from core.services import provider_http as pool


@pytest.fixture
def server():
    calls = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            calls.append((self.client_address[1], self.headers.get("Authorization")))
            body = json.dumps({"ok": True}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    pool.session().trust_env = False  # Local server must bypass developer HTTP proxies.
    yield f"http://127.0.0.1:{http.server_port}/", calls
    pool.session().close()
    if hasattr(pool._state.local, "pid"):
        del pool._state.local.pid
    http.shutdown()
    http.server_close()
    thread.join()


def test_requests_reuses_tcp_but_not_authorization(server):
    url, calls = server
    for headers in (
        {"Authorization": "Bearer first"},
        {},
        {"Authorization": "Bearer second"},
    ):
        with pool.request("POST", url, headers=headers, timeout=2) as response:
            assert response.json()["ok"]
    assert len({port for port, _ in calls}) == 1
    assert [auth for _, auth in calls] == ["Bearer first", None, "Bearer second"]
    assert pool.session().get_adapter("https://").max_retries.total == 0
    assert "Authorization" not in pool.session().headers


def test_sdk_wrappers_close_without_destroying_shared_pool(server):
    url, calls = server
    transport = pool.shared_transport()
    for key in ("first", "second"):
        with httpx.Client(transport=transport, timeout=2) as client:
            assert client.post(url, headers={"Authorization": key}).json()["ok"]
    assert len({port for port, _ in calls}) == 1
    assert [auth for _, auth in calls] == ["first", "second"]


def test_fork_reset_discards_parent_sessions_and_locks():
    session, transport = pool.session(), pool.shared_transport()
    pool.reset_after_fork()
    assert pool.session() is not session
    assert pool.shared_transport() is not transport
    session.close()
    transport.shutdown()


def test_requests_sessions_are_not_shared_between_threads():
    parent = pool.session()
    results = []

    def child():
        results.append(pool.session())
        pool.session().close()

    thread = threading.Thread(target=child)
    thread.start()
    thread.join()
    assert results[0] is not parent
