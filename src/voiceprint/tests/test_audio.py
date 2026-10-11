import io
import struct
import wave

import numpy as np
import pytest

from voiceprint.audio import AudioRejected, decode_wav
from voiceprint.probe import synthetic_wav
from voiceprint.spec import MAX_BODY_BYTES, SAMPLE_RATE


def wav(pcm, *, rate=SAMPLE_RATE, channels=1, width=2):
    output = io.BytesIO()
    with wave.open(output, "wb") as stream:
        stream.setframerate(rate)
        stream.setnchannels(channels)
        stream.setsampwidth(width)
        stream.writeframes(pcm)
    return output.getvalue()


def test_decodes_exact_bounded_pcm_without_claiming_speech_quality():
    clip = decode_wav(synthetic_wav())
    assert clip.samples.dtype == np.float32
    assert clip.samples.shape == (SAMPLE_RATE * 3,)
    assert np.isfinite(clip.samples).all()
    assert clip.quality["duration_ms"] == 3000
    assert clip.quality["speech_checked"] is False
    assert clip.quality["speaker_consistency_checked"] is False


@pytest.mark.parametrize(
    "body,code",
    [
        (b"", "audio_size_invalid"),
        (b"x" * (MAX_BODY_BYTES + 1), "audio_size_invalid"),
        (b"not a wav", "wav_invalid"),
        (synthetic_wav(2), "audio_duration_invalid"),
        (synthetic_wav(11), "audio_size_invalid"),
        (synthetic_wav(sample_rate=16000), "pcm_format_invalid"),
        (wav(b"\0" * (SAMPLE_RATE * 3 * 4), channels=2), "pcm_format_invalid"),
        (wav(b"\0" * (SAMPLE_RATE * 3 * 4), width=4), "pcm_format_invalid"),
        (synthetic_wav()[:-20], "audio_truncated"),
        (wav(b"\0" * (SAMPLE_RATE * 3 * 2)), "signal_too_quiet"),
        (
            wav(np.full(SAMPLE_RATE * 3, 3000, dtype="<i2").tobytes()),
            "signal_too_quiet",
        ),
        (
            wav(
                np.tile(
                    np.array([-32768, 32767], dtype="<i2"), SAMPLE_RATE * 3 // 2
                ).tobytes()
            ),
            "signal_clipped",
        ),
    ],
    ids=lambda value: f"wav-{len(value)}" if isinstance(value, bytes) else value,
)
def test_rejects_unsupported_corrupt_or_unusable_signal(body, code):
    with pytest.raises(AudioRejected, match=code):
        decode_wav(body)


def test_accepts_the_maximum_clip_without_resampling_or_trimming():
    clip = decode_wav(synthetic_wav(10))
    assert clip.samples.size == SAMPLE_RATE * 10
    assert clip.quality["duration_ms"] == 10000


@pytest.mark.parametrize("kind", ["oversized-junk", "oversized-fmt", "small-riff"])
def test_malformed_riff_chunk_lengths_are_sanitized(kind):
    body = synthetic_wav()
    if kind == "oversized-junk":
        body = body[:12] + b"JUNK" + struct.pack("<I", 0xFFFFFFFF) + body[12:]
    elif kind == "oversized-fmt":
        body = body[:16] + struct.pack("<I", 0xFFFFFFFF) + body[20:]
    else:
        body = body[:4] + struct.pack("<I", 4) + body[8:]
    with pytest.raises(AudioRejected, match="wav_invalid"):
        decode_wav(body)
