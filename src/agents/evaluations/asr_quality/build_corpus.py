"""Freeze synthetic turns and deterministic noise pairs; no provider requests."""

import argparse
import array
import hashlib
import io
import json
import math
import random
import sys
import wave
import zipfile
from pathlib import Path

ROOT = Path(__file__).parent
RATE = 16000


def decode(data):
    """Decode only the frozen mono PCM format."""
    with wave.open(io.BytesIO(data), "rb") as stream:
        if stream.getparams()[:3] != (1, 2, RATE):
            raise ValueError("Expected PCM16 mono 16kHz")
        samples = array.array("h", stream.readframes(stream.getnframes()))
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def encode(samples):
    """Write portable little-endian WAV bytes."""
    samples = array.array("h", samples)
    if sys.byteorder != "little":
        samples.byteswap()
    output = io.BytesIO()
    with wave.open(output, "wb") as stream:
        stream.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        stream.writeframes(samples.tobytes())
    return output.getvalue()


def noisy(samples, snr_db):
    """Set whole-file RMS SNR, then scale both signal and noise to avoid clipping."""
    rng = random.Random(20260921)  # noqa: S311 -- reproducible noise, not secrets
    noise = [rng.gauss(0, 1) for _ in samples]
    signal_power = sum(x * x for x in samples) / len(samples)
    noise_power = sum(x * x for x in noise) / len(noise)
    gain = math.sqrt(signal_power / (noise_power * 10 ** (snr_db / 10)))
    mixed = [x + n * gain for x, n in zip(samples, noise, strict=True)]
    peak = max(abs(x) for x in mixed)
    scale = min(1, 30000 / peak)
    return [round(x * scale) for x in mixed]


def build(turn_directory, destination):
    """Freeze clean/noisy pairs, silence and source hashes in one version."""
    script = json.loads((ROOT / "script.json").read_text(encoding="utf-8"))
    cases, files = [], {}
    for scenario in script["scenarios"]:
        samples, segments = [], []
        for index, turn in enumerate(scenario["turns"]):
            pcm = decode(
                (turn_directory / f"{scenario['id']}-{index}.wav").read_bytes()
            )
            start = len(samples) * 1000 / RATE
            samples.extend(pcm)
            segments.append(
                {
                    "start_ms": start,
                    "end_ms": len(samples) * 1000 / RATE,
                    "speaker": turn["speaker"],
                    "text": turn["text"],
                }
            )
            samples.extend([0] * 8000)
        variants = [("clean", None), ("noise10", 10)]
        if scenario["category"] == "multi_speaker":
            variants.append(("noise0", 0))
        for suffix, snr in variants:
            case_id = scenario["id"] + "-" + suffix
            data = encode(samples if snr is None else noisy(samples, snr))
            files[case_id + ".wav"] = data
            cases.append(
                {
                    "id": case_id,
                    "category": scenario["category"],
                    "synthetic": True,
                    "snr_db": snr,
                    "clean_case": scenario["id"] + "-clean",
                    "duration_ms": len(samples) * 1000 / RATE,
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "segments": segments,
                    "terms": scenario["terms"],
                    "manual_checks": scenario["manual_checks"],
                }
            )
    silence = encode([0] * (RATE * 3))
    files["silence.wav"] = silence
    cases.append(
        {
            "id": "silence",
            "category": "silence",
            "synthetic": True,
            "duration_ms": 3000,
            "snr_db": None,
            "segments": [],
            "terms": [],
            "sha256": hashlib.sha256(silence).hexdigest(),
            "manual_checks": ["No invented speech, summary or action items."],
        }
    )
    manifest = {
        "version": 1,
        "provenance": script["provenance"],
        "noise": (
            "Seed 20260921, Gaussian white noise, whole-file RMS SNR. "
            "Not real room noise."
        ),
        "speaker_metric": (
            "Best one-to-one speaker mapping over TTS utterance windows; not DER."
        ),
        "cases": cases,
    }
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(
        destination / "fixtures.zip", "w", zipfile.ZIP_DEFLATED
    ) as archive:
        for name, data in files.items():
            item = zipfile.ZipInfo(name, date_time=(2026, 9, 21, 0, 0, 0))
            item.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(item, data)
    (destination / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--turns", required=True, type=Path)
    parser.add_argument("--output", type=Path, default=ROOT)
    arguments = parser.parse_args()
    build(arguments.turns, arguments.output)
