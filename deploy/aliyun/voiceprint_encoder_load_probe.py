"""Bounded synthetic HTTPS overload probe in a restricted Linux image.

Runs a real encoder on loopback. The operator supplies temporary TLS/credentials,
public model weights and the actual backend transport under /backend. No human
audio, credentials, permits, vectors or request IDs are emitted.
"""

import hashlib
import io
import json
import math
import os
import statistics
import subprocess
import sys
import threading
import time
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import jwt
import requests


def wav_bytes(seconds):
    pcm = b"".join(
        int(
            9000 * math.sin(2 * math.pi * 180 * i / 24000 + math.sin(i / 1000))
        ).to_bytes(2, "little", signed=True)
        for i in range(seconds * 24000)
    )
    output = io.BytesIO()
    with wave.open(output, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(24000)
        stream.writeframes(pcm)
    return output.getvalue()


def distribution(values):
    ordered = sorted(values)
    return {
        "n": len(values),
        "median_ms": round(statistics.median(values) * 1000, 3),
        "p95_ms": round(ordered[math.ceil(len(values) * 0.95) - 1] * 1000, 3),
        "max_ms": round(ordered[-1] * 1000, 3),
    }


def main():  # noqa: PLR0915 -- One bounded process/fixture lifetime.
    sys.path.insert(0, "/backend")
    from core.services.voiceprint_encoder import FEATURE_SPACE, decode_result

    assert sys.platform == "linux" and os.getuid() == 10001
    token = Path(os.environ["VOICEPRINT_API_TOKEN_FILE"]).read_bytes().strip()
    key = Path(os.environ["VOICEPRINT_PERMIT_KEY_FILE"]).read_bytes().strip()
    ca = "/run/fixture/ca.crt"
    base = "https://127.0.0.1:8093"
    server = None
    children = []
    stop = threading.Event()
    monitor = None
    samples = {"rss_peak_bytes": 0, "active_peak": 0, "uploads_peak": 0, "n": 0}
    monitor_errors = []
    stage = "startup"
    last_readiness = "not_attempted"
    result = {
        "status": "failed",
        "scope": "local_synthetic_https_overload",
        "cases": [],
    }

    def session():
        client = requests.Session()
        client.trust_env = False
        client.verify = ca
        return client

    def gauge(body, name):
        return int(
            next(
                row.split()[1]
                for row in body.splitlines()
                if row.startswith(name + " ")
            )
        )

    def sample():
        with session() as client:
            while not stop.is_set():
                try:
                    metrics = client.get(base + "/metrics", timeout=2)
                    assert metrics.status_code == 200
                    active = gauge(metrics.text, "voiceprint_encoder_active")
                    uploads = gauge(metrics.text, "voiceprint_encoder_uploads")
                    assert 0 <= active <= 1 and 0 <= uploads <= 2
                    rss = 0
                    for pid in [str(server.pid), *children]:
                        rows = Path(f"/proc/{pid}/status").read_text().splitlines()
                        rss += (
                            int(
                                next(
                                    row.split()[1]
                                    for row in rows
                                    if row.startswith("VmRSS:")
                                )
                            )
                            * 1024
                        )
                    samples["rss_peak_bytes"] = max(samples["rss_peak_bytes"], rss)
                    samples["active_peak"] = max(samples["active_peak"], active)
                    samples["uploads_peak"] = max(samples["uploads_peak"], uploads)
                    samples["n"] += 1
                except Exception:
                    monitor_errors.append("monitor_failed")
                    return
                stop.wait(0.025)

    try:
        started = time.monotonic()
        server = subprocess.Popen(
            ["meet-voiceprint", "--host", "0.0.0.0", "--port", "8093"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        with session() as client:
            while True:
                assert server.poll() is None and time.monotonic() - started < 40
                try:
                    ready = client.get(base + "/health/ready", timeout=2)
                    last_readiness = str(ready.status_code)
                    if ready.status_code == 200:
                        break
                except requests.RequestException as exc:
                    last_readiness = type(exc).__name__
                time.sleep(0.1)
        result["cold_ready_seconds"] = round(time.monotonic() - started, 3)
        children = sorted(
            {
                pid
                for p in Path(f"/proc/{server.pid}/task").glob("*/children")
                for pid in p.read_text().split()
            }
        )
        assert len(children) == 1
        monitor = threading.Thread(target=sample, daemon=True)
        monitor.start()
        for seconds in (3, 10):
            body = wav_bytes(seconds)
            digest = hashlib.sha256(body).hexdigest()

            def submit(barrier=None):
                now = int(time.time())
                permit = jwt.encode(
                    {
                        "iss": "we-meet",
                        "aud": "voiceprint-encoder",
                        "sub": str(uuid4()),
                        "jti": str(uuid4()),
                        "iat": now,
                        "nbf": now,
                        "exp": now + 60,
                        "scope": "embedding",
                        "sha256": digest,
                        "bytes": len(body),
                        "space": FEATURE_SPACE,
                    },
                    key,
                    algorithm="HS256",
                )
                headers = {
                    "Authorization": "Bearer " + token.decode(),
                    "X-Voiceprint-Permit": permit,
                    "Content-Type": "audio/wav",
                }
                with session() as client:
                    if barrier:
                        barrier.wait(timeout=10)
                    begin = time.monotonic()
                    response = client.post(
                        base + "/v1/embeddings", data=body, headers=headers, timeout=25
                    )
                    elapsed = time.monotonic() - begin
                    assert response.headers["Cache-Control"] == "private, no-store"
                    if response.status_code == 200:
                        decode_result(response.json(), digest)
                    else:
                        assert response.status_code == 503 and response.json() == {
                            "code": "encoder_busy"
                        }
                    return response.status_code, elapsed

            for concurrency in (1, 2, 4, 8):
                stage = f"load_{seconds}s_{concurrency}"
                admitted, busy, recovery = [], [], []
                begin = time.monotonic()
                with ThreadPoolExecutor(max_workers=concurrency) as pool:
                    for _ in range(30):
                        barrier = threading.Barrier(concurrency)
                        futures = [
                            pool.submit(submit, barrier) for _ in range(concurrency)
                        ]
                        wave_results = [future.result(timeout=30) for future in futures]
                        assert any(status == 200 for status, _ in wave_results)
                        for status, elapsed in wave_results:
                            (admitted if status == 200 else busy).append(elapsed)
                        status, elapsed = submit()
                        assert status == 200
                        recovery.append(elapsed)
                        with session() as client:
                            assert (
                                client.get(
                                    base + "/health/ready", timeout=2
                                ).status_code
                                == 200
                            )
                            assert (
                                client.get(base + "/health/live", timeout=2).status_code
                                == 200
                            )
                assert concurrency != 1 or not busy
                case = {
                    "seconds": seconds,
                    "concurrency": concurrency,
                    "waves": 30,
                    "wave_requests": concurrency * 30,
                    "admitted": distribution(admitted),
                    "busy": distribution(busy) if busy else {"n": 0},
                    "serial_recovery": distribution(recovery),
                    "wall_seconds": round(time.monotonic() - begin, 3),
                }
                result["cases"].append(case)
                print(json.dumps({"case_completed": case}), flush=True)
        assert any(c["busy"]["n"] > 0 for c in result["cases"])
        stop.set()
        monitor.join(timeout=5)
        assert not monitor.is_alive() and not monitor_errors and samples["n"] > 0
        current_children = sorted(
            {
                pid
                for p in Path(f"/proc/{server.pid}/task").glob("*/children")
                for pid in p.read_text().split()
            }
        )
        assert current_children == children
        result["samples"] = samples
        result["cgroup_peak_bytes"] = int(
            Path("/sys/fs/cgroup/memory.peak").read_text()
        )
        result["cpu_max"] = Path("/sys/fs/cgroup/cpu.max").read_text().strip()
        result["memory_max"] = int(Path("/sys/fs/cgroup/memory.max").read_text())
        stage = "shutdown"
        server.terminate()
        assert server.wait(timeout=10) == 0
        deadline = time.monotonic() + 3
        while (
            any(Path(f"/proc/{pid}").exists() for pid in children)
            and time.monotonic() < deadline
        ):
            time.sleep(0.05)
        assert all(not Path(f"/proc/{pid}").exists() for pid in children)
        result.update(
            status="passed",
            human_audio_used=False,
            identity_accuracy_verified=False,
            model_child_unchanged=True,
            model_child_stopped=True,
            uid=os.getuid(),
            backend_transport_sha256=hashlib.sha256(
                Path(sys.modules[decode_result.__module__].__file__).read_bytes()
            ).hexdigest(),
        )
    except Exception as exc:
        result.update(
            status="failed", failed_stage=stage, error_type=type(exc).__name__
        )
        if stage == "startup":
            result["last_readiness"] = last_readiness
            result["server_exit"] = server.poll() if server is not None else None
    finally:
        stop.set()
        if monitor:
            monitor.join(timeout=5)
        if server is not None and server.poll() is None:
            server.kill()
            server.wait(timeout=5)
    print(json.dumps(result), flush=True)
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
