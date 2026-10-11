"""Deterministic local IPC failure fixtures; never packaged or production selected."""

import json
import os
import sys
import time

from voiceprint.process_lifetime import contain_parent_exit
from voiceprint.spec import (
    DIMENSION,
    ENCODER_SHA256,
    MODEL_ID,
    MODEL_REVISION,
    PREPROCESS_VERSION,
    SAMPLE_RATE,
    feature_space,
)


def write(value):
    print(json.dumps(value), flush=True)


def main():
    contain_parent_exit(int(sys.argv[1]))
    mode = sys.argv[2]
    if mode == "startup-hang":
        time.sleep(120)
    config = json.loads(sys.stdin.buffer.readline())
    assert config["sha256"] == ENCODER_SHA256
    write(
        {
            "ready": 1 if mode == "wrong-ready" else True,
            "space": feature_space(ENCODER_SHA256),
        }
    )
    while True:
        header = sys.stdin.buffer.readline()
        if not header:
            return
        header = json.loads(header)
        # Stall before reading PCM, exercising cancellation of a blocked writer.
        if mode == "hang":
            time.sleep(120)
        if mode == "crash":
            os._exit(1)
        if mode == "oversized":
            print("x" * 65537, flush=True)
            return
        if mode == "garbage":
            print("not-json", flush=True)
            return
        pcm = sys.stdin.buffer.read(header["frames"] * 4)
        assert len(pcm) == header["frames"] * 4
        result = {
            "feature_space": feature_space(ENCODER_SHA256),
            "model_id": MODEL_ID,
            "model_revision": MODEL_REVISION,
            "preprocess_version": PREPROCESS_VERSION,
            "dimension": DIMENSION,
            "sample_rate": SAMPLE_RATE,
            "normalization": "l2",
            "vector": [1.0] + [0.0] * (DIMENSION - 1),
            "quality": header["quality"],
        }
        if mode == "invalid-vector":
            result["vector"][0] = float("nan")
        if mode == "invalid-quality":
            result["quality"]["speech_checked"] = 0
        write(
            {"id": "wrong-id" if mode == "wrong-id" else header["id"], "result": result}
        )


if __name__ == "__main__":
    main()
