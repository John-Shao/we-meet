"""Probe a restricted production image with public model weights and synthetic audio.

No human recording, database, provider, persistent audio, vectors or credential output.
The caller supplies ephemeral test secrets and mounts the backend transport at /backend.
"""

import hashlib
import io
import json
import math
import os
import subprocess
import sys
import time
import wave
from pathlib import Path
from uuid import uuid4

import jwt
import requests

from voiceprint.spec import ENCODER_SHA256, feature_space


def synthetic_wav():
    """Fixed three-second FM signal; no optional resource-probe dependencies."""
    samples = (
        int(
            9000
            * math.sin(
                2 * math.pi * 180 * index / 24000
                + math.sin(2 * math.pi * 5 * index / 24000)
            )
        )
        for index in range(72000)
    )
    pcm = b"".join(value.to_bytes(2, "little", signed=True) for value in samples)
    output = io.BytesIO()
    with wave.open(output, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(24000)
        stream.writeframes(pcm)
    return output.getvalue()


def stopped(pid):
    path = Path(f"/proc/{pid}/stat")
    return not path.exists()


def main():
    stage = "configuration"
    server = None
    children = []
    result = {}
    try:
        assert sys.platform == "linux" and os.getuid() == 10001
        token = Path(os.environ["VOICEPRINT_API_TOKEN_FILE"]).read_bytes().strip()
        key = Path(os.environ["VOICEPRINT_PERMIT_KEY_FILE"]).read_bytes().strip()
        ca = "/run/fixture-secrets/ca.crt"
        base = "https://127.0.0.1:8093"
        stage = "startup"
        started = time.monotonic()
        server = subprocess.Popen(  # noqa: S603 -- Fixed internal process, no input in argv.
            ["meet-voiceprint", "--host", "0.0.0.0", "--port", "8093"],  # noqa: S104,S607 -- TLS in a network-none fixture namespace, image-pinned PATH.
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        session = requests.Session()
        session.trust_env = False
        deadline = started + 30
        while True:
            assert server.poll() is None
            try:
                ready = session.get(base + "/health/ready", verify=ca, timeout=2)
                if ready.status_code == 200:
                    break
            except requests.RequestException:
                pass
            assert time.monotonic() < deadline
            time.sleep(0.1)
        result["cold_ready_seconds"] = round(time.monotonic() - started, 3)
        stage = "health"
        assert ready.json() == {"status": "ready"}
        assert ready.headers["Cache-Control"] == "private, no-store"
        assert session.get(base + "/health/live", verify=ca, timeout=2).json() == {
            "status": "alive"
        }
        # Linux records children under the spawning thread, including to_thread.
        stage = "model_child"
        children = sorted(
            {
                pid
                for path in Path(f"/proc/{server.pid}/task").glob("*/children")
                for pid in path.read_text().split()
            }
        )
        assert len(children) == 1
        stage = "unauthorized"
        wav = synthetic_wav()
        assert (
            session.post(
                base + "/v1/embeddings", data=wav, verify=ca, timeout=5
            ).status_code
            == 401
        )
        stage = "backend_rpc"
        sys.path.insert(0, "/backend")
        from core.services.voiceprint_encoder import EncoderClient  # noqa: PLC0415

        client = EncoderClient(base, api_token=token, permit_key=key, ca_bundle=ca)
        rpc_started = time.monotonic()
        encoded = client.extract(
            wav, job_id=uuid4(), lease_expires_at=int(time.time()) + 60
        )
        assert len(encoded.vector) == 1024
        assert (
            abs(math.sqrt(math.fsum(value**2 for value in encoded.vector)) - 1) < 1e-4
        )
        assert encoded.feature_space == feature_space(ENCODER_SHA256)
        result["first_rpc_seconds"] = round(time.monotonic() - rpc_started, 3)
        stage = "replay"
        now = int(time.time())
        claims = dict(
            iss="we-meet",
            aud="voiceprint-encoder",
            sub=str(uuid4()),
            jti=str(uuid4()),
            iat=now,
            nbf=now,
            exp=now + 60,
            scope="embedding",
            sha256=hashlib.sha256(wav).hexdigest(),
            bytes=len(wav),
            space=encoded.feature_space,
        )
        permit = jwt.encode(claims, key, algorithm="HS256")
        headers = {
            "Authorization": "Bearer " + token.decode(),
            "X-Voiceprint-Permit": permit,
            "Content-Type": "audio/wav",
        }
        assert (
            session.post(
                base + "/v1/embeddings", data=wav, headers=headers, verify=ca, timeout=5
            ).status_code
            == 200
        )
        assert (
            session.post(
                base + "/v1/embeddings", data=wav, headers=headers, verify=ca, timeout=5
            ).status_code
            == 409
        )
        stage = "metrics"
        response = session.get(base + "/metrics", verify=ca, timeout=2)
        assert (
            response.status_code == 200
            and response.headers["Cache-Control"] == "private, no-store"
        )
        body = response.text
        assert 'voiceprint_encoder_requests_total{outcome="2xx"} 2' in body
        assert 'voiceprint_encoder_requests_total{outcome="4xx"} 2' in body
        assert token.decode() not in body and permit not in body
        assert "vector" not in body and "sha256" not in body
        stage = "shutdown"
        server.terminate()
        assert server.wait(timeout=10) == 0
        deadline = time.monotonic() + 3
        while not all(stopped(pid) for pid in children) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert all(stopped(pid) for pid in children)
        peak = Path("/sys/fs/cgroup/memory.peak")
        if peak.exists():
            result["cgroup_peak_bytes"] = int(peak.read_text())
        result.update(
            status="passed",
            tls_verified=True,
            backend_rpc=True,
            replay_rejected=True,
            model_process_stopped=True,
            dimension=1024,
            uid=10001,
        )
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception:
        print(json.dumps({"status": "failed", "stage": stage}, sort_keys=True))
        return 1
    finally:
        if server is not None and server.poll() is None:
            server.kill()
            server.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
