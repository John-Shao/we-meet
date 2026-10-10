"""Local synthetic media only; no human recordings or ASR provider calls."""

import io
import json
import math
import os
import struct
import subprocess
import time
import wave

import pytest

from core.services import voiceprint_media as media
from core.services import voiceprint_media_process as process
from core.services.voiceprint_media_worker import command


@pytest.fixture
def config():
    if not os.environ.get("VOICEPRINT_TEST_FFMPEG") or not os.environ.get(
        "VOICEPRINT_TEST_FFPROBE"
    ):
        pytest.skip("An external audited local FFmpeg/FFprobe build is required.")
    return media.MediaConfiguration(
        os.environ["VOICEPRINT_TEST_FFMPEG"], os.environ["VOICEPRINT_TEST_FFPROBE"]
    )


def tones(path, *, rate=24000, channels=1, duration=8000):
    with wave.open(str(path), "wb") as output:
        output.setnchannels(channels)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(
            b"".join(
                struct.pack(
                    "<h",
                    int(
                        4000
                        * math.sin(
                            2 * math.pi * (300 if i < rate * 4 else 900) * i / rate
                        )
                    ),
                )
                * channels
                for i in range(rate * duration // 1000)
            )
        )
    return media.MediaFile(str(path), str(path.parent))


def deadline():
    return int(time.time()) + 30


@pytest.mark.parametrize(("rate", "channels"), [(16000, 1), (24000, 1), (48000, 2)])
def test_actual_probe_decode_canonical_exact_interval(config, tmp_path, rate, channels):
    source = tones(tmp_path / "synthetic.wav", rate=rate, channels=channels)
    info = media.probe(
        source, config=config, expires=deadline(), authorized=lambda: True
    )
    assert (info.duration_ms, info.sample_rate, info.channels) == (8000, rate, channels)
    result = media.decode(
        source,
        info,
        config=config,
        start_ms=4500,
        end_ms=7500,
        expires=deadline(),
        authorized=lambda: True,
    )
    assert (result.start_ms, result.end_ms) == (4500, 7500)
    with wave.open(io.BytesIO(result.wav)) as decoded:
        assert (
            decoded.getnchannels(),
            decoded.getsampwidth(),
            decoded.getframerate(),
            decoded.getnframes(),
        ) == (1, 2, 24000, 72000)
        samples = struct.unpack("<" + "h" * 24000, decoded.readframes(24000))
    crossings = sum(
        left <= 0 < right for left, right in zip(samples, samples[1:], strict=False)
    )
    assert 899 <= crossings <= 901  # Correctly sought the second (900 Hz) interval.


@pytest.mark.parametrize("suffix", ["flac", "mp3", "m4a", "webm"])
def test_actual_compressed_media(config, tmp_path, suffix):
    wav = tones(tmp_path / "input.wav")
    target = tmp_path / f"synthetic.{suffix}"
    subprocess.run(
        [config.ffmpeg, "-v", "error", "-nostdin", "-i", wav.path, str(target)],
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=10,
    )
    source = media.MediaFile(str(target), str(tmp_path))
    info = media.probe(
        source, config=config, expires=deadline(), authorized=lambda: True
    )
    result = media.decode(
        source,
        info,
        config=config,
        start_ms=1000,
        end_ms=4000,
        expires=deadline(),
        authorized=lambda: True,
    )
    assert len(result.wav) == 144044


def test_initial_and_midflight_revocation_reaps_process(config, tmp_path, monkeypatch):
    source = tones(tmp_path / "source.wav")
    created = []
    original = process.MediaTransport.__init__

    def observe(self, *args, **kwargs):
        original(self, *args, **kwargs)
        created.append(self)

    monkeypatch.setattr(process.MediaTransport, "__init__", observe)
    with pytest.raises(media.MediaError, match="media_authorization_revoked"):
        media.probe(source, config=config, expires=deadline(), authorized=lambda: False)
    assert not created
    calls = []

    def revoke():
        calls.append(1)
        return len(calls) == 1

    with pytest.raises(media.MediaError, match="media_authorization_revoked"):
        media.probe(source, config=config, expires=deadline(), authorized=revoke)
    assert created and created[0].process.poll() is not None
    assert not created[0].reader.is_alive() and not created[0].writer.is_alive()


def test_native_deadline_reaps_worker(config, tmp_path, monkeypatch):
    source = tones(tmp_path / "source.wav")
    created = []
    original = process.MediaTransport.__init__

    def observe(self, *args, **kwargs):
        original(self, *args, **kwargs)
        created.append(self)

    monkeypatch.setattr(process.MediaTransport, "__init__", observe)
    with pytest.raises(media.MediaError, match="media_deadline_exceeded"):
        media.probe(
            source,
            config=config,
            expires=deadline(),
            authorized=lambda: True,
            seconds=0.001,
        )
    assert created[0].process.poll() is not None
    assert not created[0].reader.is_alive() and not created[0].writer.is_alive()


@pytest.mark.parametrize("kind", ["concat", "hls"])
def test_playlist_containers_refused(config, tmp_path, kind):
    tones(tmp_path / "private.wav")
    target = tmp_path / "untrusted"
    target.write_text(
        "ffconcat version 1.0\nfile 'private.wav'\n"
        if kind == "concat"
        else "#EXTM3U\n#EXT-X-TARGETDURATION:8\n#EXTINF:8,\nprivate.wav\n#EXT-X-ENDLIST\n"
    )
    with pytest.raises(media.MediaError, match="media_decode_unavailable"):
        media.probe(
            media.MediaFile(str(target), str(tmp_path)),
            config=config,
            expires=deadline(),
            authorized=lambda: True,
        )


def test_changed_source_rejected_before_native(config, tmp_path):
    source = tones(tmp_path / "source.wav")
    info = media.probe(
        source, config=config, expires=deadline(), authorized=lambda: True
    )
    with open(source.path, "ab") as changed:
        changed.write(b"changed")
    with pytest.raises(media.MediaError, match="media_source_changed"):
        media.decode(
            source,
            info,
            config=config,
            start_ms=0,
            end_ms=3000,
            expires=deadline(),
            authorized=lambda: True,
        )


def test_outside_missing_nonregular_sources(tmp_path):
    outside = tones(tmp_path / "outside.wav")
    root = tmp_path / "root"
    root.mkdir()
    for path in (
        outside.path,
        str(root),
        str(root / "missing"),
        "https://example.com/media.wav",
    ):
        with pytest.raises(media.MediaError, match="media_source_unavailable"):
            media.MediaFile(path, str(root)).stat()


def probe_body():
    return {
        "format": {"duration": "8.000000", "start_time": "0.000000"},
        "streams": [
            {"index": 0, "codec_type": "audio", "sample_rate": "24000", "channels": 1}
        ],
    }


@pytest.mark.parametrize("value", ["nan", "inf", "7200.01", "0", "0.00001", 8, True])
def test_invalid_probe_duration(value):
    body = probe_body()
    body["format"]["duration"] = value
    with pytest.raises(media.MediaError, match="media_probe_invalid"):
        media.parse_probe(json.dumps(body).encode(), ())


@pytest.mark.parametrize(
    "change", ["multi_audio", "no_audio", "offset", "bool_index", "bad_rate"]
)
def test_unsupported_probe_sources(change):
    body = probe_body()
    if change == "multi_audio":
        body["streams"] *= 2
    elif change == "no_audio":
        body["streams"] = []
    elif change == "offset":
        body["streams"][0]["start_time"] = "0.1"
    elif change == "bool_index":
        body["streams"][0]["index"] = True
    else:
        body["streams"][0]["sample_rate"] = "24e3"
    with pytest.raises(media.MediaError):
        media.parse_probe(json.dumps(body).encode(), ())


def test_fixed_command_no_user_options(config, tmp_path):
    source = tones(tmp_path / "source.wav")
    payload = {
        "operation": "decode",
        "config": config.payload(),
        "source": source.payload(),
        "expires": deadline(),
        "start_ms": 1234,
        "end_ms": 4234,
        "audio_index": 0,
    }
    args = command(payload)
    assert args[0] == config.ffmpeg and args[-1] == "pipe:1"
    assert args[args.index("-ss") + 1] == "1.234"
    assert args[args.index("-protocol_whitelist") + 1] == "file,pipe"
    for changes in (
        {"url": "https://example.com"},
        {"start_ms": True},
        {"audio_index": -1},
        {"end_ms": 2000},
        {"operation": "other"},
        {"expires": True},
    ):
        with pytest.raises(ValueError):
            command({**payload, **changes})


@pytest.mark.parametrize(
    "pcm", [b"x", b"\x00" * 143998], ids=["odd_sample", "too_short"]
)
def test_incomplete_pcm_not_padded(config, tmp_path, monkeypatch, pcm):
    source = tones(tmp_path / "source.wav")
    info = media.MediaInfo(8000, 0, 1, 24000, source.stat())
    monkeypatch.setattr(media, "invoke", lambda *args, **kwargs: pcm)
    with pytest.raises(media.MediaError, match="media_audio_incomplete"):
        media.decode(
            source,
            info,
            config=config,
            start_ms=0,
            end_ms=3000,
            expires=deadline(),
            authorized=lambda: True,
        )


def test_job_creation_failure_sanitized(monkeypatch):
    def unavailable():
        raise OSError("internal sensitive native details")

    monkeypatch.setattr(process, "ParentDeathJob", unavailable)
    with pytest.raises(media.MediaError, match="^media_worker_unavailable$"):
        process.invoke(
            {}, maximum=100, expires=deadline(), authorized=lambda: True, seconds=1
        )


def test_native_output_bounded(config, tmp_path, monkeypatch):
    source = tones(tmp_path / "source.wav")
    created = []
    original = process.MediaTransport.__init__

    def observe(self, *args, **kwargs):
        original(self, *args, **kwargs)
        created.append(self)

    monkeypatch.setattr(process.MediaTransport, "__init__", observe)
    payload = {
        "operation": "probe",
        "config": config.payload(),
        "source": source.payload(),
        "expires": deadline(),
    }
    with pytest.raises(media.MediaError, match="media_response_too_large"):
        process.invoke(
            payload,
            maximum=10,
            expires=payload["expires"],
            authorized=lambda: True,
            seconds=10,
        )
    assert len(created[0].output) == 11
    assert created[0].process.poll() is not None and not created[0].reader.is_alive()


def test_independent_timer_during_slow_authorization(config, tmp_path, monkeypatch):
    source = tones(tmp_path / "source.wav")
    created, calls = [], []
    original = process.MediaTransport.__init__

    def observe(self, *args, **kwargs):
        original(self, *args, **kwargs)
        created.append(self)

    def slow():
        calls.append(1)
        if len(calls) > 1:
            time.sleep(0.3)
            assert created[0].process.poll() is not None
        return True

    monkeypatch.setattr(process.MediaTransport, "__init__", observe)
    with pytest.raises(media.MediaError, match="media_deadline_exceeded"):
        media.probe(
            source, config=config, expires=deadline(), authorized=slow, seconds=0.05
        )
    assert created[0].process.poll() is not None


def test_short_native_result_adjusts_end_instead_of_padding(
    config, tmp_path, monkeypatch
):
    source = tones(tmp_path / "source.wav")
    info = media.MediaInfo(8000, 0, 1, 24000, source.stat())
    monkeypatch.setattr(media, "invoke", lambda *args, **kwargs: b"\x00" * 48000 * 3)
    result = media.decode(
        source,
        info,
        config=config,
        start_ms=1000,
        end_ms=5000,
        expires=deadline(),
        authorized=lambda: True,
    )
    assert (result.start_ms, result.end_ms, len(result.wav)) == (1000, 4000, 144044)
