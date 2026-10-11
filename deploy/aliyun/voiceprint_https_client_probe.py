"""Synthetic TLS, authentication and rotation checks using the real transport.

Fixtures stay in Secret volumes; no credentials, audio, IDs or vectors are output.
"""

import argparse
import hashlib
import io
import json
import math
import os
import stat
import sys
import time
import wave
from pathlib import Path
from uuid import uuid4

import jwt
import requests


def synthetic_wav():
    output = io.BytesIO()
    pcm = b"".join(
        int(
            9000 * math.sin(2 * math.pi * 180 * index / 24000 + math.sin(index / 1000))
        ).to_bytes(2, "little", signed=True)
        for index in range(72000)
    )
    with wave.open(output, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(24000)
        stream.writeframes(pcm)
    return output.getvalue()


def run(phase, base, service_ip):
    from core.services.voiceprint_encoder import EncoderClient, FEATURE_SPACE

    assert os.getuid() == 10001 and phase in ("a", "b")
    root = Path("/run/fixture")
    material = {
        version: {
            "token": (root / (version + "-token")).read_bytes(),
            "key": (root / (version + "-key")).read_bytes(),
            "ca": str(root / (version + "-ca.crt")),
        }
        for version in ("a", "b")
    }
    for path in root.iterdir():
        if path.name.startswith("."):
            continue
        assert stat.S_IMODE(path.stat().st_mode) == 0o440
        assert path.stat().st_gid == 10001
    assert os.statvfs(root).f_flag & os.ST_RDONLY
    wav = synthetic_wav()
    current = material[phase]
    with requests.Session() as session:
        session.trust_env = False
        ready = session.get(base + "/health/ready", verify=current["ca"], timeout=5)
        assert ready.status_code == 200 and ready.json() == {"status": "ready"}
        assert ready.headers["Cache-Control"] == "private, no-store"
        assert (
            session.post(
                base + "/v1/embeddings", data=wav, verify=current["ca"], timeout=5
            ).status_code
            == 401
        )
        for url, ca in (
            (base + "/health/ready", material["b" if phase == "a" else "a"]["ca"]),
            ("https://" + service_ip + ":8093/health/ready", current["ca"]),
        ):
            try:
                session.get(url, verify=ca, timeout=5)
            except requests.exceptions.SSLError:
                pass
            else:
                raise AssertionError("untrusted_ca_or_hostname_accepted")
        client = EncoderClient(
            base,
            api_token=current["token"],
            permit_key=current["key"],
            ca_bundle=current["ca"],
        )
        started = time.monotonic()
        encoded = client.extract(
            wav, job_id=uuid4(), lease_expires_at=int(time.time()) + 60
        )
        elapsed = time.monotonic() - started
        assert len(encoded.vector) == 1024 and all(
            math.isfinite(value) for value in encoded.vector
        )
        assert (
            abs(math.sqrt(math.fsum(value * value for value in encoded.vector)) - 1)
            < 1e-4
        )
        assert encoded.feature_space == FEATURE_SPACE

        def headers(token, key):
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
                    "sha256": hashlib.sha256(wav).hexdigest(),
                    "bytes": len(wav),
                    "space": FEATURE_SPACE,
                },
                key,
                algorithm="HS256",
            )
            return {
                "Authorization": "Bearer " + token.decode(),
                "X-Voiceprint-Permit": permit,
                "Content-Type": "audio/wav",
            }

        if phase == "b":
            for token, key, expected in (
                (material["a"]["token"], material["a"]["key"], 401),
                (current["token"], material["a"]["key"], 403),
            ):
                response = session.post(
                    base + "/v1/embeddings",
                    data=wav,
                    headers=headers(token, key),
                    verify=current["ca"],
                    timeout=5,
                )
                assert response.status_code == expected
        replay = headers(current["token"], current["key"])
        for expected in (200, 409):
            response = session.post(
                base + "/v1/embeddings",
                data=wav,
                headers=replay,
                verify=current["ca"],
                timeout=5,
            )
            assert response.status_code == expected
        metrics = session.get(base + "/metrics", verify=current["ca"], timeout=5)
        assert (
            metrics.status_code == 200
            and metrics.headers["Cache-Control"] == "private, no-store"
        )
        assert all(
            item["token"].decode() not in metrics.text
            and item["key"].decode() not in metrics.text
            for item in material.values()
        )
        assert "vector" not in metrics.text and "sha256" not in metrics.text
    return {
        "status": "passed",
        "phase": phase,
        "scope": "synthetic_https_encoder_only",
        "human_audio_used": False,
        "identity_accuracy_verified": False,
        "uid": os.getuid(),
        "secret_mode": "0440",
        "secret_group": 10001,
        "secret_mount_read_only": True,
        "trusted_ca_and_hostname_verified": True,
        "wrong_ca_and_hostname_rejected": True,
        "unauthorized_rejected": True,
        "real_backend_rpc": True,
        "finite_unit_vector_verified": True,
        "replay_rejected": True,
        "metrics_private": True,
        "old_token_and_key_rejected": phase == "b",
        "rpc_seconds": round(elapsed, 6),
        "backend_transport_sha256": hashlib.sha256(
            Path(sys.modules[EncoderClient.__module__].__file__).read_bytes()
        ).hexdigest(),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=("a", "b"), required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--service-ip", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(run(args.phase, args.base, args.service_ip)), flush=True)
    except Exception:
        print(json.dumps({"status": "failed", "phase": args.phase}), flush=True)
        raise SystemExit(1) from None
