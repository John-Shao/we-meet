"""Bounded fixed media subprocess and process-tree lifetime; no shell or URLs."""

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from core.services.voiceprint_media_lifetime import ParentDeathJob


class MediaError(ValueError):
    def __init__(self, code, *, retryable=False):
        super().__init__(code)
        self.retryable = retryable


class MediaTransport:
    def __init__(self, payload, *, deadline, maximum):
        self.output, self.payload = b"", payload
        self.maximum = maximum
        self.done = threading.Event()
        self.expired = threading.Event()
        args = [
            sys.executable,
            "-m",
            "core.services.voiceprint_media_worker",
            str(os.getpid()),
        ]
        self.job = None
        try:
            self.job = ParentDeathJob()
            if sys.platform == "win32":
                from core.services.voiceprint_media_windows import (  # noqa: PLC0415 -- Windows-only process creation.
                    WindowsJobProcess,
                )

                self.process = WindowsJobProcess(
                    args,
                    job=self.job,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    cwd=str(Path(__file__).resolve().parents[2]),
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
            else:
                self.process = subprocess.Popen(  # noqa: S603 -- Fixed local module, bounded stdin.
                    args,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    cwd=str(Path(__file__).resolve().parents[2]),
                )
        except OSError:
            if self.job is not None:
                self.job.close()
            raise MediaError("media_worker_unavailable", retryable=True) from None
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.writer = threading.Thread(target=self.write, daemon=True)
        self.timer = threading.Timer(
            max(0, deadline - time.monotonic()), self.terminate
        )
        self.timer.daemon = True

    def read(self):
        try:
            self.output = self.process.stdout.read(self.maximum + 1)
        except OSError:
            pass
        finally:
            self.process.stdout.close()
            self.done.set()

    def write(self):
        try:
            self.process.stdin.write(self.payload)
        except OSError:
            pass
        finally:
            try:
                self.process.stdin.close()
            except OSError:
                pass

    def terminate(self):
        self.expired.set()
        self.job.close()
        try:
            if self.process.poll() is None:
                self.process.kill()
            self.process.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            pass

    def __enter__(self):
        self.timer.start()
        self.reader.start()
        self.writer.start()
        return self

    def __exit__(self, *_args):
        self.timer.cancel()
        self.terminate()
        self.reader.join(timeout=0.5)
        self.writer.join(timeout=0.5)
        self.timer.join(timeout=0.5)
        if self.process.poll() is None:
            raise MediaError("media_worker_unavailable", retryable=True)


def invoke(payload, *, maximum, expires, authorized, seconds):  # noqa: PLR0912 -- One bounded lifecycle with authorization on every exit.
    if type(maximum) is not int or not 0 < maximum <= 480000:
        raise MediaError("media_configuration_invalid")
    try:
        encoded = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode(
            "ascii"
        )
    except (ValueError, TypeError, RecursionError):
        raise MediaError("media_input_invalid") from None
    if len(encoded) > 8192 or type(expires) is not int or expires <= time.time():
        raise MediaError("media_input_invalid")
    if type(seconds) not in (int, float) or not 0 < seconds <= 25:
        raise MediaError("media_configuration_invalid")
    if not authorized():
        raise MediaError("media_authorization_revoked")
    deadline = time.monotonic() + min(seconds, expires - time.time())
    with MediaTransport(encoded, deadline=deadline, maximum=maximum) as transport:
        next_check = 0
        while True:
            now = time.monotonic()
            if transport.expired.is_set() or now >= deadline:
                raise MediaError("media_deadline_exceeded", retryable=True)
            if now >= next_check:
                if not authorized():
                    raise MediaError("media_authorization_revoked")
                next_check = now + 0.25
            if transport.done.is_set() and len(transport.output) > maximum:
                raise MediaError("media_response_too_large")
            if transport.process.poll() is not None and transport.done.is_set():
                break
            time.sleep(0.05)
        if not authorized():
            raise MediaError("media_authorization_revoked")
        if time.monotonic() >= deadline:
            raise MediaError("media_deadline_exceeded", retryable=True)
        if transport.process.returncode != 0:
            raise MediaError("media_decode_unavailable")
        return transport.output
