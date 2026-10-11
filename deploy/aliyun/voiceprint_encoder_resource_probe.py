"""Measure the pinned production encoder with synthetic PCM on Linux.

No network client, human audio, embedding output, or database writes are used.
Unlike the workstation probe this runs without optional psutil dependencies.
"""

import argparse
import hashlib
import importlib.metadata
import inspect
import io
import json
import os
import platform
import resource
import statistics
import time
import wave
from pathlib import Path


def read_cgroup(name):
    root = Path("/sys/fs/cgroup")
    candidates = []
    try:
        for line in Path("/proc/self/cgroup").read_text().splitlines():
            if line.startswith("0::"):
                relative = Path(line[3:].lstrip("/"))
                if ".." not in relative.parts:
                    candidates.append(root / relative / name)
    except OSError:
        pass
    candidates.append(root / name)
    for path in candidates:
        try:
            return path.read_text().strip()
        except OSError:
            continue
    return None


def synthetic_wav(seconds, numpy):
    t = numpy.arange(seconds * 24000, dtype=numpy.float64) / 24000
    envelope = 0.15 * (0.6 + 0.4 * numpy.sin(2 * numpy.pi * 2.3 * t) ** 2)
    signal = envelope * (
        numpy.sin(2 * numpy.pi * (180 * t + 2 * numpy.sin(t)))
        + 0.3 * numpy.sin(2 * numpy.pi * 730 * t)
    )
    pcm = numpy.rint(signal * 32767).astype("<i2").tobytes()
    output = io.BytesIO()
    with wave.open(output, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(24000)
        stream.writeframes(pcm)
    return output.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--encoder-sha256", required=True)
    parser.add_argument("--threads", type=int, choices=[1, 2], required=True)
    args = parser.parse_args()
    if platform.system() != "Linux" or os.getuid() != 10001:
        raise SystemExit("A Linux container with UID 10001 is required.")
    started = time.perf_counter()
    import numpy as np

    from voiceprint.audio import decode_wav
    from voiceprint.encoder import QwenEncoder

    imported = time.perf_counter()
    encoder = QwenEncoder(
        args.model_dir, expected_sha256=args.encoder_sha256, threads=args.threads
    )
    loaded = time.perf_counter()
    timings = []
    repeat_error = 0.0
    for seconds in [3, 10]:
        clip = decode_wav(synthetic_wav(seconds, np))
        reference = None
        elapsed = []
        for _ in range(4):
            before = time.perf_counter()
            encoded = encoder.extract(clip)
            elapsed.append(time.perf_counter() - before)
            vector = np.asarray(encoded["vector"], dtype=np.float32)
            if (
                vector.shape != (1024,)
                or not np.isfinite(vector).all()
                or abs(float(np.linalg.norm(vector)) - 1) > 1e-5
            ):
                raise RuntimeError("technical_output_invalid")
            if reference is not None:
                repeat_error = max(
                    repeat_error, float(np.max(np.abs(vector - reference)))
                )
            reference = vector
        timings.append(
            {
                "clip_seconds": seconds,
                "runs": 4,
                "first_seconds": elapsed[0],
                "warm_median_seconds": statistics.median(elapsed[1:]),
                "warm_max_seconds": max(elapsed[1:]),
            }
        )
    print(
        json.dumps(
            {
                "scope": "synthetic_encoder_resource_only",
                "human_audio_used": False,
                "identity_accuracy_verified": False,
                "uid": os.getuid(),
                "python": platform.python_version(),
                "machine": platform.machine(),
                "host_logical_cpus": os.cpu_count(),
                "cpu_threads": args.threads,
                "feature_space": encoder.space,
                "encoder_sha256": args.encoder_sha256,
                "model_mount_read_only": bool(
                    os.statvfs(args.model_dir).f_flag & os.ST_RDONLY
                ),
                "probe_source_sha256": hashlib.sha256(
                    Path(__file__).read_bytes()
                ).hexdigest(),
                "encoder_source_sha256": hashlib.sha256(
                    Path(inspect.getfile(QwenEncoder))
                    .read_bytes()
                    .replace(b"\r\n", b"\n")
                ).hexdigest(),
                "dependencies": {
                    name: importlib.metadata.version(name)
                    for name in ["torch", "numpy", "librosa"]
                },
                "module_import_seconds": imported - started,
                "encoder_load_seconds_excluding_imports": loaded - imported,
                "peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
                * 1024,
                "total_seconds": time.perf_counter() - started,
                "repeat_max_absolute_difference": repeat_error,
                "finite_unit_vector_verified": True,
                "cgroup_cpu_max": read_cgroup("cpu.max"),
                "cgroup_memory_max": read_cgroup("memory.max"),
                "cgroup_memory_peak": read_cgroup("memory.peak"),
                "cgroup_cpu_stat": read_cgroup("cpu.stat"),
                "timings": timings,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
