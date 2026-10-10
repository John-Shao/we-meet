"""Private leased query files and bounded recovery after an abrupt parent exit."""

import json
import os
import shutil
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from core.services.voiceprint_media_process import MediaError

MAX_LEASE_SECONDS = 900
DRAIN_SECONDS = 45


def directory():
    root = Path(tempfile.gettempdir()) / "we-meet-voiceprint-query"
    root.mkdir(mode=0o700, exist_ok=True)
    if root.is_symlink() or not root.is_dir():
        raise MediaError("media_query_directory_unavailable")
    if os.name == "posix" and (
        root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077
    ):
        raise MediaError("media_query_directory_unavailable")
    return root.resolve(strict=True)


@contextmanager
def leased_directory(expires):
    if (
        type(expires) is not int
        or not time.time() < expires <= time.time() + MAX_LEASE_SECONDS
    ):
        raise MediaError("media_query_lease_invalid")
    with tempfile.TemporaryDirectory(prefix="query-", dir=directory()) as root:
        path = Path(root)
        lease = path / "lease.json"
        lease.write_bytes(
            json.dumps({"schema": 1, "expires": expires}, separators=(",", ":")).encode(
                "ascii"
            )
        )
        stopped = threading.Event()

        def remove_audio():
            # Native per-operation timers close their file handles at the same
            # lease boundary. Allow only the existing bounded drain to retry.
            end = time.monotonic() + DRAIN_SECONDS
            while not stopped.is_set():
                try:
                    (path / "source.media").unlink(missing_ok=True)
                    return
                except OSError:
                    if time.monotonic() >= end or stopped.wait(0.25):
                        return

        timer = threading.Timer(max(0, expires - time.time()), remove_audio)
        timer.daemon = True
        timer.start()
        try:
            yield root
        finally:
            stopped.set()
            timer.cancel()
            timer.join(timeout=0.5)


def expiry(path):
    lease = path / "lease.json"
    try:
        if lease.is_symlink() or not 0 < lease.stat().st_size <= 256:
            raise ValueError
        with lease.open("rb") as stream:
            value = json.loads(stream.read(257))
        if (
            not isinstance(value, dict)
            or set(value) != {"schema", "expires"}
            or type(value["schema"]) is not int
            or value["schema"] != 1
            or type(value["expires"]) is not int
            or value["expires"] <= 0
        ):
            raise ValueError
        # A malformed lease must not turn a crash leftover into indefinite data.
        return min(value["expires"], path.stat().st_mtime + MAX_LEASE_SECONDS)
    except (OSError, ValueError, TypeError, RecursionError):
        return path.stat().st_mtime + MAX_LEASE_SECONDS


def purge(*, limit=100, now=None):
    """Never recurse outside the verified dedicated directory or follow links."""
    if type(limit) is not int or not 1 <= limit <= 1000:
        raise MediaError("media_query_cleanup_limit_invalid")
    current = time.time() if now is None else now
    if type(current) not in (int, float) or not 0 < current < float("inf"):
        raise MediaError("media_query_cleanup_clock_invalid")
    root = directory()
    removed, failed, scanned = 0, 0, 0
    with os.scandir(root) as entries:
        for entry in entries:
            if scanned >= limit:
                break
            scanned += 1
            path = Path(entry.path)
            if (
                not entry.name.startswith("query-")
                or entry.is_symlink()
                or not entry.is_dir(follow_symlinks=False)
            ):
                continue
            try:
                # Resolve and validate the actual absolute target immediately
                # before the recursive delete, entirely within one filesystem API.
                target = path.resolve(strict=True)
                if target.parent != root or target != path or target.is_symlink():
                    continue
                if expiry(target) + DRAIN_SECONDS > current:
                    continue
                shutil.rmtree(target)
                removed += 1
            except OSError:
                failed += 1
    return {"scanned": scanned, "removed": removed, "failed": failed}
