"""Thread-local, fork-safe HTTP reuse for legacy file transcription workers."""

import atexit
import os
import threading
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
        """Bound open sockets and retained idle connections per process."""
        self.pool = httpx.HTTPTransport(
            retries=0,
            limits=httpx.Limits(
                max_connections=64, max_keepalive_connections=32, keepalive_expiry=60
            ),
        )

    def handle_request(self, request):
        """Dispatch through the process-owned transport."""
        return self.pool.handle_request(request)

    def close(self):
        """Closing one SDK wrapper must not interrupt other in-flight requests."""

    def shutdown(self):
        """Close sockets after worker operations finish."""
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


_local = threading.local()


def request(method, url, **kwargs):
    """Reuse connections, with per-call credentials and no automatic POST retries."""
    if getattr(_local, "pid", None) != os.getpid():
        session = requests.Session()
        for scheme in ("http://", "https://"):
            session.mount(
                scheme,
                HTTPAdapter(
                    pool_connections=8, pool_maxsize=8, max_retries=0, pool_block=True
                ),
            )
        _local.pid, _local.session = os.getpid(), session
    _local.session.cookies.clear()
    return _local.session.request(method, url, **kwargs)


@atexit.register
def shutdown():
    """Close process-owned connections at normal worker shutdown."""
    if _state.pid == os.getpid() and _state.transport is not None:
        _state.transport.shutdown()
    session = getattr(_local, "session", None)
    if session is not None:
        session.close()
