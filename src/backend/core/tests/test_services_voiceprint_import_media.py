"""Actual bounded mono preparation using synthetic local tones, never an ASR call."""

import hashlib
import os
import time
import wave
from pathlib import Path
from unittest.mock import patch

import pytest

from core.services import voiceprint_import_media as service
from core.services import voiceprint_media as media
from core.services import voiceprint_media_process as process
from core.services.voiceprint_import_worker import configuration
from core.tests.test_services_voiceprint_media import (
    config,
    tones,
)


def expiry():
    return int(time.time()) + 30


@pytest.mark.parametrize("rate,channels", [(16000, 2), (24000, 2), (48000, 6)])
def test_stereo_and_multichannel_derivatives_keep_original_sample_clock(
    config, tmp_path, rate, channels
):
    source = tones(tmp_path / "source.media", rate=rate, channels=channels)
    before = source.stat()
    with service.prepare(
        source, config=config, expires=expiry(), authorized=lambda: True
    ) as prepared:
        assert prepared.derived and prepared.time_offset_ms == 0
        assert prepared.original_duration_ms == prepared.info.duration_ms == 8000
        assert (prepared.info.channels, prepared.info.sample_rate) == (1, 24000)
        result = media.decode(
            prepared.source,
            prepared.info,
            config=config,
            start_ms=4500,
            end_ms=7500,
            expires=expiry(),
            authorized=lambda: True,
        )
        # Compare the interior of the same original interval, excluding the
        # short resampling transient introduced when seeking a separate clip.
        # A clock shift would differ despite both lengths matching.
        info = media.probe(
            source, config=config, expires=expiry(), authorized=lambda: True
        )
        expected = media.decode(
            source,
            info,
            config=config,
            start_ms=4500,
            end_ms=7500,
            expires=expiry(),
            authorized=lambda: True,
        )
        assert (
            hashlib.sha256(result.wav[48044:96044]).hexdigest()
            == hashlib.sha256(expected.wav[48044:96044]).hexdigest()
        )
        output = Path(prepared.source.path)
        assert output.stat().st_size == 8000 * 48 + 44
    assert source.stat() == before
    assert not output.exists()


def test_mono_source_does_not_make_an_unnecessary_copy(config, tmp_path):
    source = tones(tmp_path / "source.media", channels=1)
    with service.prepare(
        source, config=config, expires=expiry(), authorized=lambda: True
    ) as prepared:
        assert not prepared.derived and prepared.source == source
    assert source.stat()
    assert not (tmp_path / "diarization.wav").exists()


def test_actual_two_hour_stereo_boundary_streams_to_bounded_mono_file(config, tmp_path):
    path = tmp_path / "source.media"
    # The longest supported source, generated/written in fixed 64 KiB blocks;
    # no multi-hour PCM array is ever allocated in the app or fixture.
    block = bytes(65536)
    remaining = 7200 * 8000 * 4
    try:
        with wave.open(str(path), "wb") as source:
            source.setnchannels(2)
            source.setsampwidth(2)
            source.setframerate(8000)
            while remaining:
                part = block[: min(remaining, len(block))]
                source.writeframesraw(part)
                remaining -= len(part)
        with service.prepare(
            media.MediaFile(str(path), str(tmp_path)),
            config=config,
            expires=int(time.time()) + 240,
            authorized=lambda: True,
        ) as prepared:
            assert prepared.original_duration_ms == prepared.info.duration_ms == 7200000
            assert prepared.info.channels == 1
            assert Path(prepared.source.path).stat().st_size == 7200000 * 48 + 44
        assert not (tmp_path / "diarization.wav").exists()
    finally:
        path.unlink(missing_ok=True)


def test_reserved_destination_is_never_overwritten_or_deleted(config, tmp_path):
    source = tones(tmp_path / "source.media", channels=2)
    destination = tmp_path / "diarization.wav"
    destination.write_bytes(b"another operation's file")
    with pytest.raises(media.MediaError, match="media_derivative_unavailable"):
        with service.prepare(
            source, config=config, expires=expiry(), authorized=lambda: True
        ):
            pytest.fail("A competing output must not be adopted")
    assert destination.read_bytes() == b"another operation's file"


def test_caller_exception_cleans_derivative_without_deleting_original(config, tmp_path):
    source = tones(tmp_path / "source.media", channels=2)
    with pytest.raises(ValueError, match="synthetic caller failure"):
        with service.prepare(
            source, config=config, expires=expiry(), authorized=lambda: True
        ):
            raise ValueError("synthetic caller failure")
    assert source.stat() and not (tmp_path / "diarization.wav").exists()


def test_revoked_conversion_reaps_process_and_removes_reserved_file(
    config, tmp_path, monkeypatch
):
    source = tones(tmp_path / "source.media", channels=2)
    transports = []
    initialize = process.MediaTransport.__init__

    def observe(self, *args, **kwargs):
        initialize(self, *args, **kwargs)
        transports.append(self)

    monkeypatch.setattr(process.MediaTransport, "__init__", observe)
    allowed = True

    def live():
        return allowed

    real_invoke = service.invoke

    def revoke(*args, **kwargs):
        nonlocal allowed

        def check():
            nonlocal allowed
            if len(transports) > 1:
                allowed = False
            return allowed

        kwargs["authorized"] = check
        return real_invoke(*args, **kwargs)

    monkeypatch.setattr(service, "invoke", revoke)
    with pytest.raises(media.MediaError, match="media_authorization_revoked"):
        with service.prepare(source, config=config, expires=expiry(), authorized=live):
            pytest.fail("Revoked conversion must not publish a file")
    assert len(transports) == 2 and all(
        row.process.poll() is not None for row in transports
    )
    assert source.stat() and not (tmp_path / "diarization.wav").exists()


def test_stale_probe_cannot_publish_a_derivative(config, tmp_path):
    source = tones(tmp_path / "source.media", channels=2)
    invoke = service.invoke

    def replace(*args, **kwargs):
        result = invoke(*args, **kwargs)
        os.utime(source.path, ns=(1, 1))
        return result

    with patch.object(service, "invoke", side_effect=replace):
        with pytest.raises(media.MediaError, match="media_source_changed"):
            with service.prepare(
                source, config=config, expires=expiry(), authorized=lambda: True
            ):
                pytest.fail("A changed source must not be published")
    assert not (tmp_path / "diarization.wav").exists()


def test_replaced_derivative_is_neither_adopted_nor_deleted(config, tmp_path):
    source = tones(tmp_path / "source.media", channels=2)
    replacement = tones(tmp_path / "replacement.wav", channels=1)
    destination = tmp_path / "diarization.wav"
    invoke = service.invoke

    def replace(*args, **kwargs):
        result = invoke(*args, **kwargs)
        os.replace(replacement.path, destination)
        return result

    with patch.object(service, "invoke", side_effect=replace):
        with pytest.raises(media.MediaError, match="media_derivative_unavailable"):
            with service.prepare(
                source, config=config, expires=expiry(), authorized=lambda: True
            ):
                pytest.fail("An unrelated replacement is not this derivative")
    assert destination.stat().st_size == 8000 * 48 + 44
    assert source.stat()


@pytest.mark.parametrize(
    "duration,index,identity",
    [(True, 0, [0, 0]), (7200001, 0, [0, 0]), (1, True, [0, 0]), (1, 0, [True, 0])],
)
def test_worker_rejects_unbounded_or_ambiguous_fields(duration, index, identity):
    with pytest.raises(ValueError):
        configuration(
            {
                "source": {"path": "unused", "root": "unused"},
                "config": {"ffmpeg": "unused", "ffprobe": "unused"},
                "expires": expiry(),
                "duration_ms": duration,
                "audio_index": index,
                "output_identity": identity,
            }
        )
