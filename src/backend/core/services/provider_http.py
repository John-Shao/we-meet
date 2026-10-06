"""Reuse provider connections without sharing credentials or crossing worker forks."""

import atexit
import os
import threading
import urllib.error
from types import SimpleNamespace

import httpx
import requests
from requests.adapters import HTTPAdapter

_state = SimpleNamespace(
    local=threading.local(), lock=threading.Lock(), pid=os.getpid(), transport=None
)


class SharedTransport(httpx.BaseTransport):
    """SDK clients own responses; the worker owns the underlying connection pool."""

    def __init__(self):
        self.pool = httpx.HTTPTransport(
            retries=0,
            limits=httpx.Limits(
                max_connections=64, max_keepalive_connections=32, keepalive_expiry=60
            ),
        )

    def handle_request(self, request):
        return self.pool.handle_request(request)

    def close(self):
        """Closing one SDK wrapper must not interrupt other in-flight requests."""

    def shutdown(self):
        self.pool.close()


def reset_after_fork():
    """Child workers create their own pools and locks before sending any requests."""
    _state.local = threading.local()
    _state.lock = threading.Lock()
    _state.pid = os.getpid()
    _state.transport = None


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=reset_after_fork)


def shared_transport():
    """One thread-safe httpx pool per process; headers stay on individual clients."""
    if _state.pid != os.getpid():
        reset_after_fork()
    with _state.lock:
        if _state.transport is None:
            _state.transport = SharedTransport()
        return _state.transport


def session():
    """Requests sessions are thread-local; paid submissions have no auto retries."""
    if getattr(_state.local, "pid", None) != os.getpid():
        value = requests.Session()
        for scheme in ("https://", "http://"):
            value.mount(
                scheme,
                HTTPAdapter(
                    pool_connections=8, pool_maxsize=8, max_retries=0, pool_block=True
                ),
            )
        _state.local.pid, _state.local.session = os.getpid(), value
    return _state.local.session


def request(method, url, **kwargs):
    """Keep authorization per request, never in shared session defaults."""
    value = session()
    value.cookies.clear()
    return value.request(method, url, **kwargs)


class UrlResponse:
    """Small urlopen-compatible boundary for the existing embedding parser."""

    def __init__(self, response):
        self.response = response

    def read(self):
        return self.response.content

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.response.close()


def urlopen(req, timeout):
    """Use the pooled transport without changing the embedding response contract."""
    try:
        response = request(
            req.get_method(),
            req.full_url,
            data=req.data,
            headers=dict(req.header_items()),
            timeout=timeout,
            allow_redirects=False,
            stream=True,
        )
    except requests.RequestException as exc:
        raise urllib.error.URLError("provider connection failed") from exc
    if response.status_code != 200:
        status = response.status_code
        response.close()
        raise urllib.error.HTTPError(
            req.full_url, status, "provider rejected", {}, None
        )
    return UrlResponse(response)


@atexit.register
def shutdown():
    """Release this process's pool after all normal worker operations finish."""
    if _state.transport is not None and _state.pid == os.getpid():
        _state.transport.shutdown()
    value = getattr(_state.local, "session", None)
    if value is not None:
        value.close()
