"""Synthetic technical probe only; never reports human identification accuracy."""

import argparse
import importlib.metadata
import io
import json
import platform
import statistics
import threading
import time
import wave
from pathlib import Path

import numpy as np
import psutil

from voiceprint.audio import decode_wav
from voiceprint.encoder import QwenEncoder
from voiceprint.spec import DIMENSION, SAMPLE_RATE


def synthetic_wav(seconds: int = 3, *, sample_rate: int = SAMPLE_RATE) -> bytes:
    # Deterministic frequency-modulated tones, not recorded or generated speech.
    t = np.arange(seconds * sample_rate, dtype=np.float64) / sample_rate
    envelope = 0.15 * (0.6 + 0.4 * np.sin(2 * np.pi * 2.3 * t) ** 2)
    signal = envelope * (
        np.sin(2 * np.pi * (180 * t + 2 * np.sin(t)))
        + 0.3 * np.sin(2 * np.pi * 730 * t)
    )
    pcm = np.rint(signal * 32767).astype("<i2").tobytes()
    out = io.BytesIO()
    with wave.open(out, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(sample_rate)
        stream.writeframes(pcm)
    return out.getvalue()


def probe(model_dir: Path, expected_sha256: str, threads: int = 2) -> dict:
    process = psutil.Process()
    peak = [process.memory_info().rss]
    stopped = threading.Event()

    def sample_memory():
        while not stopped.wait(0.02):
            peak[0] = max(peak[0], process.memory_info().rss)

    monitor = threading.Thread(target=sample_memory, daemon=True)
    monitor.start()
    try:
        started = time.perf_counter()
        encoder = QwenEncoder(
            model_dir, expected_sha256=expected_sha256, threads=threads
        )
        load_seconds = time.perf_counter() - started
        results = []
        reference = None
        repeat_error = 0.0
        for seconds in (3, 10):
            clip = decode_wav(synthetic_wav(seconds))
            elapsed = []
            for _ in range(4):
                before = time.perf_counter()
                result = encoder.extract(clip)
                elapsed.append(time.perf_counter() - before)
                vector = np.asarray(result["vector"], dtype=np.float32)
                if vector.shape != (DIMENSION,) or not np.isfinite(vector).all():
                    raise RuntimeError("technical_output_invalid")
                if abs(float(np.linalg.norm(vector)) - 1) > 1e-5:
                    raise RuntimeError("technical_normalization_invalid")
                if reference is not None:
                    repeat_error = max(
                        repeat_error, float(np.max(np.abs(vector - reference)))
                    )
                reference = vector
            reference = None
            results.append(
                {
                    "clip_seconds": seconds,
                    "runs": len(elapsed),
                    "first_seconds": elapsed[0],
                    "warm_median_seconds": statistics.median(elapsed[1:]),
                    "warm_max_seconds": max(elapsed[1:]),
                }
            )
        return {
            "scope": "synthetic_technical_only",
            "human_samples_used": False,
            "identity_accuracy_verified": False,
            "speech_detection_verified": False,
            "mixed_speaker_detection_verified": False,
            "feature_space": encoder.space,
            "encoder_sha256": expected_sha256,
            "dimension": DIMENSION,
            "sample_rate": SAMPLE_RATE,
            "device": "cpu",
            "cpu_threads": threads,
            "environment": {
                "system": platform.system(),
                "machine": platform.machine(),
                "processor": platform.processor(),
                "python": platform.python_version(),
                "logical_cpus": psutil.cpu_count(),
                "physical_cpus": psutil.cpu_count(logical=False),
            },
            "dependencies": {
                name: importlib.metadata.version(name)
                for name in (
                    "torch",
                    "numpy",
                    "librosa",
                    "safetensors",
                    "scipy",
                    "numba",
                )
            },
            "encoder_load_seconds_excluding_imports": load_seconds,
            "sampled_peak_rss_bytes": peak[0],
            "rss_sampling_interval_ms": 20,
            "repeat_max_absolute_difference": repeat_error,
            "finite_unit_vector_verified": True,
            "timings": results,
        }
    finally:
        stopped.set()
        monitor.join(timeout=1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("--encoder-sha256", required=True)
    parser.add_argument("--threads", default=2, type=int)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = json.dumps(
        probe(args.model_dir, args.encoder_sha256, args.threads), indent=2
    )
    if args.output:
        args.output.write_text(report + "\n", encoding="utf-8")
    print(report)


if __name__ == "__main__":
    main()
