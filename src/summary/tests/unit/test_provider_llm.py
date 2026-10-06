"""SDK ownership, credential isolation and concurrency without paid model calls."""

import gc
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock, patch

import pytest

from summary.core import provider_llm as pool


@pytest.fixture(autouse=True)
def clean_pool():
    """Ensure every test starts and finishes with an empty SDK cache."""
    pool.shutdown()
    yield
    pool.shutdown()


def test_configuration_isolation_and_reuse_after_release():
    """Same configuration reuses the SDK; credentials and policies do not mix."""
    with patch("openai.OpenAI") as factory:
        factory.side_effect = Mock
        first = pool.acquire(api_key="a", base_url="https://a", max_retries=0)
        sdk = first._entry.client
        first.close()
        first.close()
        same = pool.acquire(api_key="a", base_url="https://a", max_retries=0)
        assert same._entry.client is sdk
        others = [
            pool.acquire(api_key="b", base_url="https://a", max_retries=0),
            pool.acquire(api_key="a", base_url="https://b", max_retries=0),
            pool.acquire(api_key="a", base_url="https://a", timeout=30, max_retries=0),
            pool.acquire(api_key="a", base_url="https://a", max_retries=None),
        ]
        assert factory.call_count == 5
        assert all(item._entry.client is not sdk for item in others)
        sdk.close.assert_not_called()
        for item in [same, *others]:
            item.close()
        pool.shutdown()
        sdk.close.assert_called_once()


def test_eviction_waits_for_last_lease_and_gc_releases():
    """Evicted clients close only after their final borrower releases them."""
    with patch("openai.OpenAI") as factory, patch.object(pool, "MAX_CLIENTS", 1):
        factory.side_effect = Mock
        first = pool.acquire(api_key="a", base_url="https://a")
        second_lease = pool.acquire(api_key="a", base_url="https://a")
        sdk = first._entry.client
        other = pool.acquire(api_key="b", base_url="https://a")
        assert len(pool._state.clients) == 1
        first.close()
        sdk.close.assert_not_called()
        assert second_lease.chat is sdk.chat
        del second_lease
        gc.collect()
        sdk.close.assert_called_once()
        other.close()


def test_shutdown_keeps_borrowed_client_alive_until_release():
    """Normal shutdown retires the cache without interrupting borrowed clients."""
    with patch("openai.OpenAI") as factory:
        lease = pool.acquire(api_key="a", base_url="https://a")
        pool.shutdown()
        factory.return_value.close.assert_not_called()
        assert lease.chat is factory.return_value.chat
        lease.close()
        factory.return_value.close.assert_called_once()


def test_failed_sdk_construction_closes_http_wrapper():
    """An invalid configuration must not leave an uncached HTTP wrapper alive."""
    with (
        patch("openai.OpenAI", side_effect=ValueError("invalid configuration")),
        patch.object(pool, "sdk_http_client") as http,
    ):
        with pytest.raises(ValueError, match="invalid configuration"):
            pool.acquire(api_key="a", base_url="https://a")
        http.return_value.close.assert_called_once()
        assert not pool._state.clients


def test_fork_reset_replaces_clients_and_never_closes_parent_client():
    """Child workers reject inherited leases and create their own SDK clients."""
    with patch("openai.OpenAI") as factory:
        factory.side_effect = Mock
        parent = pool.acquire(api_key="a", base_url="https://a")
        lock = pool._state.lock
        with patch.object(pool.os, "getpid", return_value=parent._entry.pid + 1):
            child = pool.acquire(api_key="a", base_url="https://a")
            assert child._entry.client is not parent._entry.client
            assert pool._state.lock is not lock
            with pytest.raises(RuntimeError, match="lease_lifetime"):
                _ = parent.chat
            parent.close()
            child.close()
            pool.shutdown()
        parent._entry.client.close.assert_not_called()
        pool.reset_after_fork()


def test_concurrent_sdk_calls_preserve_credentials_models_and_responses():
    """Real SDK requests retain their own credentials and outputs under load."""
    ports = set()
    seen = []
    guard = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            with guard:
                ports.add(self.client_address[1])
                seen.append(
                    (
                        self.headers["Authorization"],
                        body["model"],
                        body["messages"],
                        self.headers.get("Cookie"),
                    )
                )
            result = json.dumps(
                {
                    "id": "test",
                    "object": "chat.completion",
                    "created": 1,
                    "model": body["model"],
                    "choices": [
                        {
                            "index": 0,
                            "finish_reason": "stop",
                            "message": {
                                "role": "assistant",
                                "content": body["messages"][0]["content"],
                            },
                        }
                    ],
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(result)))
            self.send_header("Set-Cookie", "private=must-not-cross-tasks")
            self.end_headers()
            self.wfile.write(result)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}/v1"

    def call(index):
        lease = pool.acquire(api_key=f"key-{index % 2}", base_url=url, max_retries=0)
        try:
            response = lease.chat.completions.create(
                model=f"model-{index % 3}",
                messages=[{"role": "user", "content": str(index)}],
            )
            assert response.choices[0].message.content == str(index)
            return id(lease._entry.client)
        finally:
            lease.close()

    try:
        with ThreadPoolExecutor(max_workers=8) as executor:
            clients = list(executor.map(call, range(64)))
        assert len(set(clients)) == 2
        assert len(ports) <= 8
        assert len(seen) == 64
        for auth, model, messages, cookie in seen:
            index = int(messages[0]["content"])
            assert auth == f"Bearer key-{index % 2}"
            assert model == f"model-{index % 3}"
            assert cookie is None
    finally:
        pool.shutdown()
        server.shutdown()
        server.server_close()
        thread.join()
