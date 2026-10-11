"""Process lifetime and failure recovery using real pipes, plus optional real Qwen."""

import asyncio
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np
import psutil
import pytest
from aiohttp.test_utils import TestClient, TestServer

from tests.test_server import KEY, TOKEN, headers
from voiceprint import isolated_encoder
from voiceprint.audio import decode_wav
from voiceprint.isolated_encoder import IsolatedEncoder
from voiceprint.probe import synthetic_wav
from voiceprint.process_protocol import EncoderProcessError
from voiceprint.server import SERVICE, create_app
from voiceprint.spec import ENCODER_SHA256

HELPER = Path(__file__).with_name("_isolated_worker.py")
ROOT = HELPER.parents[1]


@pytest.fixture
def children(monkeypatch):
    processes, modes = [], []

    def spawn(job):
        mode = modes.pop(0) if modes else "normal"
        process = job.spawn(
            [sys.executable, str(HELPER), str(os.getpid()), mode],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        processes.append(process)
        return process

    monkeypatch.setattr(isolated_encoder, "spawn_model", spawn)
    yield processes, modes
    for process in processes:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=3)


def encoder(**kwargs):
    return IsolatedEncoder(
        ROOT / "private-model-path",
        expected_sha256=ENCODER_SHA256,
        startup_seconds=5,
        **kwargs,
    )


def test_warm_reuse_and_shutdown_reaps_child_and_pipe_threads(children):
    processes, _ = children
    model = encoder()
    try:
        model.start()
        child = model.child
        model.start()
        clip = decode_wav(synthetic_wav())
        assert model.extract(clip) == model.extract(clip)
        assert len(processes) == 1 and model.ready
    finally:
        model.close()
    assert processes[0].poll() is not None
    assert not child.reader.is_alive() and not child.writer.is_alive()
    assert not model.ready
    with pytest.raises(EncoderProcessError, match="encoder_unavailable"):
        model.start()


@pytest.mark.parametrize(
    "mode",
    [
        "hang",
        "crash",
        "garbage",
        "oversized",
        "wrong-id",
        "invalid-vector",
        "invalid-quality",
    ],
)
def test_native_failure_retires_and_recovers_in_fresh_process(children, mode):
    processes, modes = children
    modes.append(mode)
    model = encoder(inference_seconds=0.3)
    try:
        model.start()
        old = model.child
        started = time.monotonic()
        with pytest.raises(EncoderProcessError):
            model.extract(decode_wav(synthetic_wav()))
        assert time.monotonic() - started < 4
        assert not model.ready and processes[0].poll() is not None
        assert not old.reader.is_alive() and not old.writer.is_alive()
        model.start()
        assert model.extract(decode_wav(synthetic_wav()))["vector"][0] == 1.0
        assert len(processes) == 2
    finally:
        model.close()
    assert all(process.poll() is not None for process in processes)


@pytest.mark.parametrize("mode", ["startup-hang", "wrong-ready"])
def test_failed_startup_is_bounded_reaped_and_retryable(children, mode):
    processes, modes = children
    modes.append(mode)
    model = encoder()
    model.startup_seconds = 0.7 if mode == "startup-hang" else 5
    try:
        with pytest.raises(EncoderProcessError):
            model.start()
        assert not model.ready and processes[0].poll() is not None
        model.startup_seconds = 5
        model.start()
        assert model.ready and len(processes) == 2
    finally:
        model.close()


@pytest.mark.parametrize("stage", ["startup", "inference"])
def test_close_interrupts_pending_native_work(children, stage):
    processes, modes = children
    modes.append("startup-hang" if stage == "startup" else "hang")
    model = encoder()
    errors = []

    def run():
        try:
            model.start()
            if stage == "inference":
                model.extract(decode_wav(synthetic_wav()))
        except EncoderProcessError as error:
            errors.append(error)

    thread = threading.Thread(target=run)
    thread.start()
    try:
        deadline = time.monotonic() + 5
        while model.child is None or (stage == "inference" and not model.ready):
            assert time.monotonic() < deadline
            time.sleep(0.01)
        # Let the writer enter its blocking native IPC call.
        time.sleep(0.1)
        model.close()
        thread.join(timeout=3)
        assert not thread.is_alive() and errors
        assert processes[0].poll() is not None
    finally:
        model.close()
        thread.join(timeout=3)


def test_atomic_creation_failure_is_sanitized(monkeypatch):
    def fail(_job):
        raise OSError("private operator details")

    monkeypatch.setattr(isolated_encoder, "spawn_model", fail)
    model = encoder()
    with pytest.raises(EncoderProcessError, match="^encoder_startup_failed$"):
        model.start()
    assert not model.ready and model.child is None


async def test_http_timeout_liveness_recovery_replay_and_cleanup(children):
    processes, modes = children
    modes.append("hang")
    model = encoder(inference_seconds=0.3)
    body = synthetic_wav()
    auth = headers(body, space=model.space)
    async with TestClient(
        TestServer(create_app(model, token=TOKEN, permit_key=KEY))
    ) as client:
        result = await client.post("/v1/embeddings", data=body, headers=auth)
        assert result.status == 503
        assert await result.json() == {"code": "encoder_timeout"}
        assert (await client.get("/health/live")).status == 200
        service = client.app[SERVICE]
        if service.recovery is not None:
            await asyncio.wait_for(service.recovery, 5)
        assert (await client.get("/health/ready")).status == 200
        assert (
            await client.post("/v1/embeddings", data=body, headers=auth)
        ).status == 409
        assert (
            await client.post(
                "/v1/embeddings", data=body, headers=headers(body, space=model.space)
            )
        ).status == 200
    assert len(processes) == 2
    assert all(process.poll() is not None for process in processes)


@pytest.mark.parametrize("failure_at", [1, 2])
def test_thread_start_failure_reaps_process_and_closes_pipes(
    children, monkeypatch, failure_at
):
    processes, _ = children
    original = threading.Thread.start
    calls = []

    def start(thread):
        calls.append(True)
        if len(calls) == failure_at:
            raise RuntimeError("can't start thread fixture")
        return original(thread)

    monkeypatch.setattr(threading.Thread, "start", start)
    model = encoder()
    with pytest.raises(EncoderProcessError, match="^encoder_startup_failed$"):
        model.start()
    assert not model.ready and processes[0].poll() is not None
    assert processes[0].stdin.closed and processes[0].stdout.closed


@pytest.mark.parametrize("stage", ["startup", "running"])
def test_abrupt_parent_death_kills_model_child_without_python_cleanup(stage):
    script = """
import os, subprocess, sys, time
from voiceprint import isolated_encoder as module
from voiceprint.spec import ENCODER_SHA256
stage = sys.argv[2]
def spawn(job):
    process = job.spawn(
        [sys.executable, sys.argv[1], str(os.getpid()), "hang"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    if stage == "startup":
        print(process.pid, flush=True)
        time.sleep(120)
    return process
module.spawn_model = spawn
model = module.IsolatedEncoder("private-model", expected_sha256=ENCODER_SHA256)
model.start()
print(model.child.process.pid, flush=True)
time.sleep(120)
"""
    parent = subprocess.Popen(  # noqa: S603 -- Fixed, trusted local test script.
        [sys.executable, "-c", script, str(HELPER), stage],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    children = []
    try:
        # A timer bounds startup even if the fixture unexpectedly cannot boot.
        timeout = threading.Timer(10, parent.kill)
        timeout.start()
        try:
            child = psutil.Process(int(parent.stdout.readline()))
            if stage == "startup":
                time.sleep(0.2)  # Allow the venv redirector to start its interpreter.
            children = [child, *child.children(recursive=True)]
            if sys.platform == "win32":
                assert len(children) >= 2, "Venv fixture must cover descendants"
        finally:
            timeout.cancel()
            timeout.join()
        parent.kill()
        parent.wait(timeout=3)
        deadline = time.monotonic() + 5
        for child in children:
            while child.is_running():
                try:
                    if child.status() == psutil.STATUS_ZOMBIE:
                        break
                except psutil.NoSuchProcess:
                    break
                assert time.monotonic() < deadline, "Orphan model survived parent death"
                time.sleep(0.05)
    finally:
        if parent.poll() is None:
            parent.kill()
        parent.wait(timeout=3)
        parent.stdout.close()
        for child in children:
            if child.is_running():
                child.kill()


@pytest.mark.skipif(
    not os.environ.get("VOICEPRINT_TEST_MODEL_DIR"), reason="Audited model required"
)
def test_real_pinned_qwen_process_reuses_and_recovers_without_feature_changes():
    model = IsolatedEncoder(
        os.environ["VOICEPRINT_TEST_MODEL_DIR"],
        expected_sha256=ENCODER_SHA256,
    )
    old = None
    try:
        model.start()
        old = model.child
        clip = decode_wav(synthetic_wav())
        first = model.extract(clip)
        np.testing.assert_allclose(
            first["vector"], model.extract(clip)["vector"], atol=1e-6
        )
        assert model.child is old
        old.process.kill()
        old.process.wait(timeout=3)
        assert not model.ready
        model.start()
        assert model.child is not old
        np.testing.assert_allclose(
            first["vector"], model.extract(clip)["vector"], atol=1e-6
        )
        assert first["feature_space"] == model.space
        assert first["quality"]["speech_checked"] is False
    finally:
        model.close()
    assert old.process.poll() is not None
