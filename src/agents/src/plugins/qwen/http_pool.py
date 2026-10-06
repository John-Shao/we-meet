"""Worker-owned Filetrans HTTP connections, scoped to one event loop."""

import asyncio
import os
from contextlib import asynccontextmanager
from contextvars import ContextVar

import aiohttp

_current = ContextVar("filetrans_http_pool", default=None)


def _session():
    return aiohttp.ClientSession(
        timeout=aiohttp.ClientTimeout(total=45),
        connector=aiohttp.TCPConnector(
            limit=32,
            limit_per_host=16,
            keepalive_timeout=60,
        ),
        cookie_jar=aiohttp.DummyCookieJar(),
    )


@asynccontextmanager
async def filetrans_http_pool(*, enabled=True):
    """Own connections until the worker and its child tasks have finished."""
    if not enabled:
        yield
        return
    async with _session() as client:
        token = _current.set((os.getpid(), asyncio.get_running_loop(), client))
        try:
            yield
        finally:
            _current.reset(token)


@asynccontextmanager
async def filetrans_http_client():
    """Borrow worker connections; standalone calls own and close their session."""
    pool = _current.get()
    if pool is not None:
        pid, loop, client = pool
        if (
            pid != os.getpid()
            or loop is not asyncio.get_running_loop()
            or client.closed
        ):
            raise RuntimeError("filetrans_pool_outside_worker_lifetime")
        yield client
    else:
        async with _session() as client:
            yield client
