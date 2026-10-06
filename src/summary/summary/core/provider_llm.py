"""Bounded SDK reuse with leases that keep active clients alive during eviction."""

import atexit
import os
import threading
import weakref
from collections import OrderedDict
from http.cookiejar import CookieJar, DefaultCookiePolicy
from types import SimpleNamespace

from .provider_http import shared_transport

MAX_CLIENTS = 16
_state = SimpleNamespace(pid=os.getpid(), lock=threading.RLock(), clients=OrderedDict())


class RejectCookies(DefaultCookiePolicy):
    """Provider APIs authenticate with explicit headers, never task cookies."""

    def set_ok(self, cookie, request):
        """Ignore Set-Cookie on provider responses."""
        return False


def sdk_http_client(timeout):
    """Share sockets without persisting provider cookies between tasks."""
    from openai import DefaultHttpxClient  # noqa: PLC0415

    return DefaultHttpxClient(
        transport=shared_transport(),
        timeout=timeout,
        cookies=CookieJar(policy=RejectCookies()),
    )


def reset_after_fork():
    """Never borrow parent clients, sockets or locks in a child worker."""
    _state.pid = os.getpid()
    _state.lock = threading.RLock()
    _state.clients = OrderedDict()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=reset_after_fork)


def _release(entry):
    if entry.pid != os.getpid():
        return
    with _state.lock:
        entry.users -= 1
        if entry.retired and not entry.users:
            entry.client.close()


class ClientLease:
    """Close a task's lease without closing a client borrowed by other tasks."""

    def __init__(self, entry):
        """Track one borrower and release it on explicit close or collection."""
        self._entry = entry
        self._finalizer = weakref.finalize(self, _release, entry)

    def __getattr__(self, name):
        """Expose SDK operations only while the task owns its lease."""
        if not self._finalizer.alive or self._entry.pid != os.getpid():
            raise RuntimeError("llm_client_outside_lease_lifetime")
        return getattr(self._entry.client, name)

    def close(self):
        """Release exactly once; garbage collection also releases unused leases."""
        self._finalizer()


def acquire(*, api_key, base_url, timeout=60.0, max_retries=None):
    """Reuse immutable SDK configuration; model and user metadata stay per call."""
    from openai import OpenAI  # noqa: PLC0415

    if _state.pid != os.getpid():
        reset_after_fork()
    # Factory identity also isolates replaced SDK factories in tests.
    timeout_key = (
        (timeout.connect, timeout.read, timeout.write, timeout.pool)
        if hasattr(timeout, "connect")
        else timeout
    )
    key = (OpenAI, api_key, str(base_url), timeout_key, max_retries)
    with _state.lock:
        entry = _state.clients.pop(key, None)
        if entry is None:
            http_client = sdk_http_client(timeout)
            try:
                client = OpenAI(
                    api_key=api_key,
                    base_url=base_url,
                    timeout=timeout,
                    http_client=http_client,
                    **({"max_retries": max_retries} if max_retries is not None else {}),
                )
            except BaseException:
                http_client.close()
                raise
            entry = SimpleNamespace(
                client=client, users=0, retired=False, pid=os.getpid()
            )
        entry.users += 1
        _state.clients[key] = entry
        while len(_state.clients) > MAX_CLIENTS:
            _, old = _state.clients.popitem(last=False)
            old.retired = True
            if not old.users:
                old.client.close()
        return ClientLease(entry)


@atexit.register
def shutdown():
    """Retire cached clients; outstanding leases close after their last release."""
    if _state.pid != os.getpid():
        reset_after_fork()
    with _state.lock:
        entries = list(_state.clients.values())
        _state.clients.clear()
        for entry in entries:
            entry.retired = True
            if not entry.users:
                entry.client.close()
