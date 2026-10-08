"""Broker-owned, thread-safe HTTP pool; responses retain bounded byte reads."""

import io
import os
import threading
from contextlib import contextmanager
from http.cookiejar import CookieJar, DefaultCookiePolicy
from urllib.error import HTTPError

import httpx


class RejectCookies(DefaultCookiePolicy):
    def set_ok(self, cookie, request):
        return False


class ResponseBytes(io.RawIOBase):
    def __init__(self, response, release):
        self.response = response
        self.chunks = response.iter_raw()
        self.pending = memoryview(b"")
        self.release = release
        self.finished = False

    def readable(self):
        return True

    def finish(self):
        if not self.finished:
            self.finished = True
            try:
                self.response.close()
            finally:
                self.release()

    def readinto(self, buffer):
        if self.closed:
            raise ValueError("read of closed response")
        try:
            while not self.pending:
                if self.finished:
                    return 0
                self.pending = memoryview(next(self.chunks))
            size = min(len(buffer), len(self.pending))
            buffer[:size] = self.pending[:size]
            self.pending = self.pending[size:]
            return size
        except StopIteration:
            self.finish()
            return 0
        except Exception:
            self.finish()
            raise

    def close(self):
        try:
            self.finish()
        finally:
            super().close()


class ProviderHttpPool:
    """One owner per process; shutdown defers until outstanding responses finish.

    Only sockets are shared. Credentials are supplied per request, cookies are
    rejected, and neither redirects nor transport retries can repeat paid POSTs.
    Construct the Broker after forking; inherited pools are deliberately rejected.
    """

    def __init__(self, *, max_connections=16, max_keepalive_connections=8):
        self.pid = os.getpid()
        self.lock = threading.Lock()
        self.active = 0
        self.closed = False
        limits = httpx.Limits(
            max_connections=max_connections,
            max_keepalive_connections=max_keepalive_connections,
            keepalive_expiry=60,
        )
        self.client = httpx.Client(
            transport=httpx.HTTPTransport(
                retries=0,
                limits=limits,
            ),
            limits=limits,
            cookies=CookieJar(policy=RejectCookies()),
            follow_redirects=False,
        )

    def release(self):
        with self.lock:
            self.active -= 1
            if self.closed and self.active == 0:
                self.client.close()

    def close(self):
        self.check_process()
        with self.lock:
            if not self.closed:
                self.closed = True
                if self.active == 0:
                    self.client.close()

    def check_process(self):
        if os.getpid() != self.pid:
            raise RuntimeError("construct the model Broker after forking")

    @contextmanager
    def open(self, url, body, headers, timeout):
        self.check_process()
        with self.lock:
            if self.closed:
                raise RuntimeError("provider pool is closed")
            self.active += 1
        response = None
        reader = None
        try:
            request = self.client.build_request(
                "POST",
                url,
                content=body,
                headers={**headers, "Accept-Encoding": "identity"},
                timeout=httpx.Timeout(timeout, pool=min(timeout, 2)),
            )
            response = self.client.send(request, stream=True)
            if not 200 <= response.status_code < 300:
                # Preserve the Broker's sanitized status-only error contract.
                raise HTTPError(
                    url, response.status_code, "provider_http_error", {}, None
                )
            reader = io.BufferedReader(ResponseBytes(response, self.release))
            yield reader
        finally:
            if reader is not None:
                reader.close()
            else:
                try:
                    if response is not None:
                        response.close()
                finally:
                    self.release()
