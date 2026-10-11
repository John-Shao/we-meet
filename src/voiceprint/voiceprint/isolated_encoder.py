"""One persistent, killable Qwen worker with bounded I/O and no audio files."""

import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from uuid import uuid4

import numpy as np

from voiceprint.process_lifetime import ParentDeathJob
from voiceprint.process_protocol import (
    MAX_HEADER_BYTES,
    MAX_OUTPUT_BYTES,
    EncoderProcessError,
    validate_frames,
    validate_quality,
    validate_result,
)
from voiceprint.spec import ENCODER_SHA256, feature_space


def encode_header(value):
    try:
        encoded = (
            json.dumps(value, separators=(",", ":"), allow_nan=False).encode("ascii")
            + b"\n"
        )
    except (ValueError, TypeError, RecursionError):
        raise EncoderProcessError("encoder_protocol_invalid") from None
    if len(encoded) > MAX_HEADER_BYTES:
        raise EncoderProcessError("encoder_protocol_invalid")
    return encoded


def spawn_model(job):
    return job.spawn(
        [sys.executable, "-m", "voiceprint.process_worker", str(os.getpid())],
        cwd=str(Path(__file__).resolve().parents[1]),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )


class ModelProcess:
    """Bounded one-slot input/output queues; close interrupts native and pipe waits."""

    def __init__(self):
        self.closed = threading.Event()
        self.failed = threading.Event()
        self.inputs = queue.Queue(maxsize=1)
        self.outputs = queue.Queue(maxsize=1)
        self.ready = False
        self.job = None
        self.process = None
        try:
            self.job = ParentDeathJob()
            self.process = spawn_model(self.job)
        except Exception:
            if self.job is not None:
                self.job.close()
            if self.process is not None:
                try:
                    if self.process.poll() is None:
                        self.process.kill()
                    self.process.wait(timeout=2)
                except (OSError, subprocess.TimeoutExpired):
                    pass
                self.process.stdin.close()
                self.process.stdout.close()
            raise EncoderProcessError("encoder_startup_failed") from None
        self.writer = threading.Thread(target=self.write_loop, daemon=True)
        self.reader = threading.Thread(target=self.read_loop, daemon=True)
        try:
            self.writer.start()
            self.reader.start()
        except RuntimeError:
            self.close()
            raise EncoderProcessError("encoder_startup_failed") from None

    def write_loop(self):
        try:
            while not self.closed.is_set():
                payload = self.inputs.get()
                if payload is None or self.closed.is_set():
                    return
                self.process.stdin.write(payload)
                self.process.stdin.flush()
        except OSError:
            self.failed.set()
        finally:
            try:
                self.process.stdin.close()
            except OSError:
                pass

    def read_loop(self):
        try:
            while not self.closed.is_set():
                encoded = self.process.stdout.readline(MAX_OUTPUT_BYTES + 1)
                if (
                    not encoded
                    or len(encoded) > MAX_OUTPUT_BYTES
                    or not encoded.endswith(b"\n")
                ):
                    self.failed.set()
                    return
                self.outputs.put_nowait(encoded)
        except (OSError, queue.Full):
            self.failed.set()
        finally:
            self.process.stdout.close()

    def exchange(self, payload, *, seconds):
        if self.closed.is_set() or self.failed.is_set():
            raise EncoderProcessError("encoder_unavailable")
        try:
            self.inputs.put_nowait(payload)
        except queue.Full:
            raise EncoderProcessError("encoder_busy") from None
        expired = threading.Event()

        def expire():
            expired.set()
            self.close()

        timer = threading.Timer(seconds, expire)
        timer.daemon = True
        deadline = time.monotonic() + seconds
        timer.start()
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or expired.is_set():
                    raise EncoderProcessError("encoder_timeout")
                if self.closed.is_set() or self.failed.is_set():
                    raise EncoderProcessError("encoder_unavailable")
                try:
                    encoded = self.outputs.get(timeout=min(0.05, remaining))
                    break
                except queue.Empty:
                    continue
            try:
                return json.loads(encoded)
            except (ValueError, UnicodeError, RecursionError):
                raise EncoderProcessError("encoder_protocol_invalid") from None
        finally:
            timer.cancel()
            timer.join(timeout=3)

    def close(self):
        self.closed.set()
        self.ready = False
        self.job.close()  # Kill the complete Windows tree, including the venv launcher.
        try:
            self.inputs.put_nowait(None)
        except queue.Full:
            pass
        try:
            if self.process.poll() is None:
                self.process.kill()
            self.process.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            self.failed.set()
        for thread, pipe in (
            (self.writer, self.process.stdin),
            (self.reader, self.process.stdout),
        ):
            if thread.ident is not None:
                thread.join(timeout=0.5)
            else:
                pipe.close()


class IsolatedEncoder:
    """Warm one model child; retire on any timeout, crash, or protocol mismatch."""

    def __init__(
        self,
        model_dir,
        *,
        expected_sha256,
        threads=2,
        startup_seconds=20,
        inference_seconds=20,
    ):
        if (
            expected_sha256 != ENCODER_SHA256
            or type(threads) is not int
            or not 1 <= threads <= 8
        ):
            raise EncoderProcessError("encoder_configuration_invalid")
        if (
            type(startup_seconds) not in (int, float)
            or not 0 < startup_seconds <= 30
            or type(inference_seconds) not in (int, float)
            or not 0 < inference_seconds <= 20
        ):
            raise EncoderProcessError("encoder_configuration_invalid")
        self.space = feature_space(expected_sha256)
        self.config = {
            "model_dir": str(Path(model_dir).resolve()),
            "sha256": expected_sha256,
            "threads": threads,
        }
        self.startup_seconds, self.inference_seconds = (
            startup_seconds,
            inference_seconds,
        )
        self.operation = threading.Lock()
        self.state = threading.Lock()
        self.closing = threading.Event()
        self.child = None

    @property
    def ready(self):
        with self.state:
            return bool(
                self.child
                and self.child.ready
                and not self.child.closed.is_set()
                and not self.child.failed.is_set()
                and self.child.process.poll() is None
            )

    def retire(self, child):
        with self.state:
            if self.child is child:
                self.child = None
        if child:
            child.close()

    def start(self):
        with self.operation:
            if self.closing.is_set():
                raise EncoderProcessError("encoder_unavailable")
            if self.ready:
                return
            self.retire(self.child)
            child = ModelProcess()
            with self.state:
                closing = self.closing.is_set()
                if not closing:
                    self.child = child
            if closing:
                child.close()
                raise EncoderProcessError("encoder_unavailable")
            try:
                result = child.exchange(
                    encode_header(self.config), seconds=self.startup_seconds
                )
                if (
                    not isinstance(result, dict)
                    or set(result) != {"ready", "space"}
                    or result["ready"] is not True
                    or result["space"] != self.space
                    or self.closing.is_set()
                ):
                    raise EncoderProcessError("encoder_startup_failed")
                child.ready = True
            except Exception:
                self.retire(child)
                raise

    def extract(self, clip):
        with self.operation:
            if self.closing.is_set() or not self.ready:
                raise EncoderProcessError("encoder_unavailable")
            samples = clip.samples
            if (
                not isinstance(samples, np.ndarray)
                or samples.ndim != 1
                or samples.dtype != np.float32
            ):
                raise EncoderProcessError("encoder_protocol_invalid")
            validate_frames(samples.size)
            validate_quality(clip.quality, samples.size)
            if not np.isfinite(samples).all() or np.max(np.abs(samples)) > 1.0:
                raise EncoderProcessError("encoder_protocol_invalid")
            identifier = str(uuid4())
            payload = encode_header(
                {"id": identifier, "frames": samples.size, "quality": clip.quality}
            )
            payload += samples.astype("<f4", copy=False).tobytes()
            with self.state:
                child = self.child
            if child is None:
                raise EncoderProcessError("encoder_unavailable")
            try:
                response = child.exchange(payload, seconds=self.inference_seconds)
                if (
                    not isinstance(response, dict)
                    or set(response) != {"id", "result"}
                    or response["id"] != identifier
                ):
                    raise EncoderProcessError("encoder_protocol_invalid")
                result = validate_result(
                    response["result"], space=self.space, quality=clip.quality
                )
                if self.closing.is_set() or child.closed.is_set():
                    raise EncoderProcessError("encoder_unavailable")
                return result
            except Exception:
                self.retire(child)
                raise

    def close(self):
        self.closing.set()
        self.retire(self.child)
