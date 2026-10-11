"""Bounded PCM acceptance. Signal checks are not speech or single-speaker checks."""

import io
import math
import wave
from dataclasses import dataclass

import numpy as np

from voiceprint.spec import MAX_BODY_BYTES, MAX_SECONDS, MIN_SECONDS, SAMPLE_RATE


class AudioRejected(ValueError):
    """Stable non-sensitive rejection code, safe to return without input details."""


@dataclass(frozen=True)
class AudioClip:
    samples: np.ndarray
    quality: dict


def decode_wav(body: bytes) -> AudioClip:
    if not body or len(body) > MAX_BODY_BYTES:
        raise AudioRejected("audio_size_invalid")
    try:
        with wave.open(io.BytesIO(body), "rb") as stream:
            if (
                stream.getnchannels(),
                stream.getsampwidth(),
                stream.getframerate(),
                stream.getcomptype(),
            ) != (1, 2, SAMPLE_RATE, "NONE"):
                raise AudioRejected("pcm_format_invalid")
            frames = stream.getnframes()
            if not MIN_SECONDS * SAMPLE_RATE <= frames <= MAX_SECONDS * SAMPLE_RATE:
                raise AudioRejected("audio_duration_invalid")
            pcm = stream.readframes(frames)
            if len(pcm) != frames * 2:
                raise AudioRejected("audio_truncated")
    except (wave.Error, EOFError, RuntimeError) as error:
        raise AudioRejected("wav_invalid") from error
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    rms = float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))
    ac_rms = float(np.std(samples.astype(np.float64)))
    clipped_fraction = float(np.mean(np.abs(samples) >= 32760 / 32768))
    if ac_rms < 0.001:
        raise AudioRejected("signal_too_quiet")
    if clipped_fraction > 0.02:
        raise AudioRejected("signal_clipped")
    return AudioClip(
        samples,
        {
            "duration_ms": frames * 1000 // SAMPLE_RATE,
            "rms_dbfs": round(20 * math.log10(max(rms, 1e-12)), 3),
            "ac_rms_dbfs": round(20 * math.log10(max(ac_rms, 1e-12)), 3),
            "clipped_fraction": clipped_fraction,
            "validation": "signal-only-v1",
            "speech_checked": False,
            "speaker_consistency_checked": False,
        },
    )
