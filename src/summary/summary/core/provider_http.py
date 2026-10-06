"""Thread-local, fork-safe HTTP reuse for legacy file transcription workers."""

import os
import threading

import requests
from requests.adapters import HTTPAdapter

_local = threading.local()


def request(method, url, **kwargs):
    """Reuse connections, with per-call credentials and no automatic POST retries."""
    if getattr(_local, "pid", None) != os.getpid():
        session = requests.Session()
        for scheme in ("http://", "https://"):
            session.mount(scheme, HTTPAdapter(
                pool_connections=8, pool_maxsize=8, max_retries=0, pool_block=True
            ))
        _local.pid, _local.session = os.getpid(), session
    _local.session.cookies.clear()
    return _local.session.request(method, url, **kwargs)
