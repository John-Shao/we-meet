"""Measure bounded matching with synthetic vectors, without database or RPC.

Run in an isolated Linux backend container with all voiceprint flags disabled.
The in-memory synthetic policy is never written as a calibration artifact.
"""

import hashlib
import inspect
import json
import math
import os
import platform
import random
import resource
import statistics
import time
from pathlib import Path
from uuid import UUID


def main():
    if platform.system() != "Linux" or os.getuid() != 10001:
        raise SystemExit("A Linux container with UID 10001 is required.")
    from configurations import importer

    importer.install()
    import django

    django.setup()
    from django.conf import settings

    from core.services import voiceprint_matching as matching
    from core.services import voiceprint_vectors as vectors

    if any(
        getattr(settings, name)
        for name in (
            "MEETING_VOICEPRINT_ENABLED",
            "MEETING_VOICEPRINT_SAMPLING_ENABLED",
            "MEETING_VOICEPRINT_MATCHING_ENABLED",
        )
    ):
        raise RuntimeError("voiceprint_flags_must_be_disabled")
    policy = matching.ThresholdPolicy(
        threshold_version="synthetic-resource-only-v1",
        feature_space=matching.FEATURE_SPACE,
        score_policy=matching.SCORE_POLICY,
        accept=0.85,
        margin=0.05,
        min_pair_cosine=0.85,
        min_query_clips=3,
        min_query_speech_ms=9000,
        max_candidates=50,
        max_device_groups=5,
        calibration_sha256="a" * 64,
        calibrated=True,
    )
    rng = random.Random(20261011)
    bases = [
        vectors.unit_vector(tuple(rng.uniform(-1, 1) for _ in range(1024)))
        for _ in range(50)
    ]
    templates = [
        tuple(
            vectors.unit_vector(
                tuple(value + rng.uniform(-0.001, 0.001) for value in base)
            )
            for _ in range(5)
        )
        for base in bases
    ]
    rows = []
    for count in (1, 10, 50):
        for groups in (1, 5):
            pool = tuple(
                matching.Candidate(UUID(int=index + 1), templates[index][:groups])
                for index in range(count)
            )
            for clip_count in (3, 12):
                clips = tuple(
                    matching.QueryClip(
                        start_ms=index * 10000,
                        end_ms=index * 10000 + 3000,
                        valid_speech_ms=3000,
                        audio_sha256=f"{index + 1:064x}",
                        vector=bases[0],
                        speech_checked=True,
                        speaker_consistency_checked=True,
                        speaker_count=1,
                    )
                    for index in range(clip_count)
                )
                elapsed = []
                for _ in range(31):
                    started = time.perf_counter()
                    result = matching.match(clips, pool, policy=policy)
                    elapsed.append(time.perf_counter() - started)
                    if result.status != "suggested" or result.user_id != UUID(int=1):
                        raise RuntimeError("synthetic_matching_result_changed")
                warm = elapsed[1:]
                rows.append(
                    {
                        "candidate_count": count,
                        "device_groups_per_candidate": groups,
                        "query_clips": clip_count,
                        "runs": len(elapsed),
                        "warm_runs": len(warm),
                        "first_seconds": elapsed[0],
                        "warm_median_seconds": statistics.median(warm),
                        "warm_p95_seconds": sorted(warm)[
                            math.ceil(0.95 * len(warm)) - 1
                        ],
                        "warm_max_seconds": max(warm),
                    }
                )
                print(json.dumps({"completed_case": len(rows)}), flush=True)
    print(
        json.dumps(
            {
                "status": "passed",
                "scope": "synthetic_matching_cpu_only",
                "human_audio_used": False,
                "identity_accuracy_verified": False,
                "production_threshold_written": False,
                "database_or_rpc_used": False,
                "uid": os.getuid(),
                "python": platform.python_version(),
                "host_logical_cpus": os.cpu_count(),
                "percentile_method": "nearest_rank",
                "peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
                * 1024,
                "source_sha256": {
                    module.__name__: hashlib.sha256(
                        Path(inspect.getfile(module))
                        .read_bytes()
                        .replace(b"\r\n", b"\n")
                    ).hexdigest()
                    for module in (matching, vectors)
                },
                "cases": rows,
            },
            sort_keys=True,
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
