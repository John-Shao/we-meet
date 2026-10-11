"""Real private storage/decoder/ASR transport with synthetic source and vectors."""

import hashlib
import io
import math
import os
import socket
import struct
import subprocess
import sys
import time
import wave
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
import requests

from core.services import voiceprint_query_producer as service
from core.services import voiceprint_source_intervals as intervals
from core.services.capture_diarization_objects import configuration_digest
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_encoder import EncoderResult
from core.services.voiceprint_media import MediaConfiguration
from core.services.voiceprint_query import QueryOutcome
from core.services.voiceprint_rpc_process import EncoderConfiguration
from core.services.voiceprint_rpc_process import extract as actual_extract
from core.services.voiceprint_sources import SourceSnapshot
from core.tests.test_services_voiceprint_matching import policy, vector
from core.tests.test_services_voiceprint_quality_process import short_asr
from core.tests.test_services_voiceprint_source_storage import private_s3, proof


def synthetic_source(*, channels=1):
    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(2)
        writer.setframerate(24000)
        writer.writeframes(
            b"".join(
                struct.pack(
                    "<h",
                    int(
                        (2500 + (i // 120000) * 150)
                        * math.sin(2 * math.pi * 300 * i / 24000)
                    ),
                )
                * channels
                for i in range(720000)
            )
        )
    return output.getvalue()


@pytest.fixture
def pipeline(private_s3, short_asr, monkeypatch):
    if not os.environ.get("VOICEPRINT_TEST_FFMPEG") or not os.environ.get(
        "VOICEPRINT_TEST_FFPROBE"
    ):
        pytest.skip("An audited local FFmpeg build is required.")
    private_s3.data = synthetic_source()
    short_asr.duration = 5000
    short_asr.prompt = (
        "Synthetic query evidence for a meeting, without an enrollment challenge."
    )
    speaker = uuid4()
    source = SourceSnapshot(
        uuid4(),
        uuid4(),
        1,
        "a" * 64,
        "b" * 64,
        proof(private_s3, kind="content_sha256"),
        (intervals.SourceInterval(speaker, 0, 30000),),
        None,
    )
    state = SimpleNamespace(
        source=source,
        speaker=speaker,
        live=True,
        valid=True,
        decoded=[],
        angles=[],
        requests=0,
    )
    monkeypatch.setattr(service.sources, "authorized", lambda *_args: state.live)
    monkeypatch.setattr(service.sources, "revalidate", lambda *_args: state.valid)
    decode = service.media.decode

    def observe_decode(*args, **kwargs):
        state.decoded.append(Path(args[0].path))
        return decode(*args, **kwargs)

    monkeypatch.setattr(service.media, "decode", observe_decode)

    def encode(wav, **_kwargs):
        duration = service.query.quality.audio_duration(wav)
        angle = state.angles[state.requests] if state.angles else 0
        state.requests += 1
        return EncoderResult(
            vector(angle),
            {
                "duration_ms": duration,
                "rms_dbfs": -20,
                "ac_rms_dbfs": -20,
                "clipped_fraction": 0,
                "validation": "signal-only-v1",
                "speech_checked": False,
                "speaker_consistency_checked": False,
            },
            hashlib.sha256(wav).hexdigest(),
        )

    monkeypatch.setattr(service.query.encoder_process, "extract", encode)
    state.kwargs = {
        "policy": policy(),
        "media_config": MediaConfiguration(
            os.environ["VOICEPRINT_TEST_FFMPEG"], os.environ["VOICEPRINT_TEST_FFPROBE"]
        ),
        "storage_config": private_s3.config,
        "encoder_config": EncoderConfiguration(
            "http://127.0.0.1:9999",
            b"synthetic-encoder-token-0123456789",
            b"synthetic-permit-key-0123456789012",
        ),
        "quality_config": short_asr.config,
        "job_id": uuid4(),
        "expires": int(time.time()) + 60,
        "authorized": lambda: state.live,
    }
    return state


def run(state, **changes):
    return service.produce(state.source, state.speaker, **{**state.kwargs, **changes})


def test_real_private_multi_clip_producer_cleans_source_and_returns_no_identity(
    pipeline, short_asr
):
    result = run(pipeline)
    assert result.status == "ready" and len(result.clips) == 5
    assert len({clip.audio_sha256 for clip in result.clips}) == 5
    assert all(clip.valid_speech_ms == 5000 for clip in result.clips)
    assert result.source_digest == pipeline.source.fingerprint
    assert len(result.media_sha256) == 64
    assert short_asr.requests == 5 and pipeline.requests == 5
    assert all(
        not path.exists() and not path.parent.exists() for path in pipeline.decoded
    )
    assert "vector" not in repr(result) and str(pipeline.speaker) not in repr(result)


def test_capture_expected_sha_rejects_download_before_decoder_or_providers(
    pipeline, private_s3, short_asr, monkeypatch
):
    pipeline.source = replace(
        pipeline.source,
        receipt=proof(private_s3, kind="s3_object"),
        storage_kind="capture",
        storage_digest=configuration_digest(private_s3.config),
        media_sha256="0" * 64,
    )
    paths = []
    download = service.storage.download

    @contextmanager
    def observe_download(*args, **kwargs):
        with download(*args, **kwargs) as local:
            paths.append(Path(local.media.path))
            yield local

    monkeypatch.setattr(service.storage, "download", observe_download)
    monkeypatch.setattr(
        service.media,
        "probe",
        lambda *args, **kwargs: pytest.fail("Changed media must not reach the decoder"),
    )
    with pytest.raises(VoiceprintError, match="integrity_unavailable"):
        run(pipeline)
    assert private_s3.requests and not short_asr.requests and not pipeline.requests
    assert paths and all(
        not path.exists() and not path.parent.exists() for path in paths
    )


def test_capture_storage_change_is_refused_before_any_private_or_provider_io(
    pipeline, private_s3, short_asr
):
    pipeline.source = replace(
        pipeline.source,
        storage_kind="capture",
        storage_digest=configuration_digest(private_s3.config),
    )
    with pytest.raises(VoiceprintError, match="storage_changed"):
        run(
            pipeline,
            storage_config=replace(private_s3.config, bucket="different-bucket"),
        )
    assert not private_s3.requests and not short_asr.requests and not pipeline.requests


@pytest.mark.parametrize(
    "failure", ["uncalibrated", "revoked", "stale_source", "wrong_speaker", "expired"]
)
def test_preflight_never_reads_media_or_calls_providers(
    pipeline, private_s3, short_asr, failure
):
    changes = {}
    if failure == "uncalibrated":
        assert (
            run(pipeline, policy=policy(calibrated=False)).reason
            == "calibration_required"
        )
    else:
        if failure == "revoked":
            pipeline.live = False
        elif failure == "stale_source":
            pipeline.valid = False
        elif failure == "wrong_speaker":
            pipeline.speaker = uuid4()
        else:
            changes["expires"] = int(time.time()) - 1
        with pytest.raises(VoiceprintError):
            run(pipeline, **changes)
    assert not private_s3.requests and not short_asr.requests and not pipeline.requests


def test_stereo_source_not_promoted_by_mono_conversion(pipeline, private_s3, short_asr):
    private_s3.data = synthetic_source(channels=2)
    pipeline.source = replace(
        pipeline.source, receipt=proof(private_s3, kind="content_sha256")
    )
    result = run(pipeline)
    assert result.reason == "source_channels_unsupported" and not result.clips
    assert short_asr.requests == 0 and not pipeline.decoded


def test_short_clean_intervals_never_start_billed_asr(pipeline, short_asr):
    pipeline.source = replace(
        pipeline.source,
        intervals=(intervals.SourceInterval(pipeline.speaker, 0, 5000),),
    )
    result = run(pipeline)
    assert result.status == "insufficient_audio" and not result.clips
    assert not short_asr.requests and not pipeline.requests


def test_single_mixed_clip_refuses_entire_group_without_majority_vote(
    pipeline, monkeypatch
):
    calls = []
    original = service.query.extract_clip

    def mixed(*args, **kwargs):
        calls.append(1)
        return (
            QueryOutcome("mixed_speaker", "mixed_speaker")
            if len(calls) == 3
            else original(*args, **kwargs)
        )

    monkeypatch.setattr(service.query, "extract_clip", mixed)
    result = run(pipeline)
    assert result.status == "mixed_speaker" and not result.clips and len(calls) == 3
    assert all(not path.exists() for path in pipeline.decoded)


def test_pairwise_inconsistent_queries_are_refused(pipeline):
    pipeline.angles = [0, 0, math.pi / 2, 0, 0]
    result = run(pipeline)
    assert result.status == "mixed_speaker" and result.reason == "query_inconsistent"
    assert not result.clips


def test_late_source_change_cannot_release_query_features(pipeline, monkeypatch):
    original = service.query.extract_clip

    def late(*args, **kwargs):
        result = original(*args, **kwargs)
        if pipeline.requests == 5:
            pipeline.valid = False
        return result

    monkeypatch.setattr(service.query, "extract_clip", late)
    with pytest.raises(VoiceprintError, match="source_changed"):
        run(pipeline)
    assert all(not path.exists() for path in pipeline.decoded)


@pytest.fixture
def actual_encoder(tmp_path):
    required = (
        "VOICEPRINT_FLOW_PYTHON",
        "VOICEPRINT_TEST_MODEL_DIR",
        "VOICEPRINT_TEST_ENCODER_SHA256",
    )
    if any(not os.environ.get(key) for key in required):
        pytest.skip(
            "An audited external Qwen pack and its isolated runtime are required."
        )
    token, key = (
        os.urandom(32).hex().encode("ascii"),
        os.urandom(32).hex().encode("ascii"),
    )
    token_file, key_file = tmp_path / "token", tmp_path / "key"
    token_file.write_bytes(token)
    key_file.write_bytes(key)
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        port = reserved.getsockname()[1]
    process = subprocess.Popen(
        [
            os.environ["VOICEPRINT_FLOW_PYTHON"],
            "-m",
            "voiceprint.server",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ],
        cwd=str(Path(__file__).resolve().parents[3] / "voiceprint"),
        env={
            **os.environ,
            "VOICEPRINT_MODEL_DIR": os.environ[required[1]],
            "VOICEPRINT_ENCODER_SHA256": os.environ[required[2]],
            "VOICEPRINT_API_TOKEN_FILE": str(token_file),
            "VOICEPRINT_PERMIT_KEY_FILE": str(key_file),
        },
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    try:
        with requests.Session() as session:
            session.trust_env = False
            end = time.monotonic() + 20
            while True:
                assert process.poll() is None
                try:
                    if (
                        session.get(
                            f"http://127.0.0.1:{port}/health/ready", timeout=0.3
                        ).status_code
                        == 200
                    ):
                        break
                except requests.RequestException:
                    pass
                assert time.monotonic() < end
                time.sleep(0.1)
        yield EncoderConfiguration(f"http://127.0.0.1:{port}", token, key)
    finally:
        process.kill()
        process.wait(timeout=3)


def test_full_private_query_with_actual_fixed_qwen_encoder(
    pipeline, actual_encoder, short_asr, monkeypatch
):
    encoded = []

    def actual(wav, **kwargs):
        result = actual_extract(wav, **kwargs)
        encoded.append(result)
        return result

    monkeypatch.setattr(service.query.encoder_process, "extract", actual)
    result = run(pipeline, encoder_config=actual_encoder)
    assert len(encoded) == 5 and short_asr.requests == 5
    assert all(
        len(item.vector) == 1024
        and abs(math.sqrt(math.fsum(value**2 for value in item.vector)) - 1) < 1e-4
        for item in encoded
    )
    # Synthetic tones and mocked ASR speech evidence cannot prove identity.
    # Preserve the actual model's consistency outcome; never relax a threshold.
    assert result.status in {"ready", "mixed_speaker"}
    if result.status == "mixed_speaker":
        assert result.reason == "query_inconsistent" and not result.clips
    else:
        assert len(result.clips) == 5
    assert all(
        not path.exists() and not path.parent.exists() for path in pipeline.decoded
    )
