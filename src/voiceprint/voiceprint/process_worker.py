"""Persistent offline native model child; fixed local module with bounded stdio IPC."""

import json
import sys
from pathlib import Path
from uuid import UUID

from voiceprint.process_lifetime import contain_parent_exit
from voiceprint.process_protocol import (
    MAX_HEADER_BYTES,
    MAX_OUTPUT_BYTES,
    validate_frames,
    validate_quality,
)


def read_header():
    encoded = sys.stdin.buffer.readline(MAX_HEADER_BYTES + 1)
    if not encoded:
        return None
    if len(encoded) > MAX_HEADER_BYTES or not encoded.endswith(b"\n"):
        raise ValueError
    return json.loads(encoded)


def write_response(value):
    encoded = (
        json.dumps(value, separators=(",", ":"), allow_nan=False).encode("ascii")
        + b"\n"
    )
    if len(encoded) > MAX_OUTPUT_BYTES:
        raise ValueError
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def main():
    try:
        contain_parent_exit(int(sys.argv[1]))
        config = read_header()
        if not isinstance(config, dict) or set(config) != {
            "model_dir",
            "sha256",
            "threads",
        }:
            raise ValueError
        if not isinstance(config["model_dir"], str) or len(config["model_dir"]) > 2048:
            raise ValueError
        if type(config["threads"]) is not int or not 1 <= config["threads"] <= 8:
            raise ValueError
        import numpy as np

        from voiceprint.audio import AudioClip
        from voiceprint.encoder import QwenEncoder

        encoder = QwenEncoder(
            Path(config["model_dir"]),
            expected_sha256=config["sha256"],
            threads=config["threads"],
        )
        write_response({"ready": True, "space": encoder.space})
    except Exception:  # Sanitized startup failures; no paths, config, or traceback.
        write_response({"error": "encoder_startup_failed"})
        return 1
    while True:
        try:
            header = read_header()
            if header is None:
                return 0
            if not isinstance(header, dict) or set(header) != {
                "id",
                "frames",
                "quality",
            }:
                raise ValueError
            identifier = header["id"]
            if not isinstance(identifier, str) or str(UUID(identifier)) != identifier:
                raise ValueError
            frames = header["frames"]
            validate_frames(frames)
            validate_quality(header["quality"], frames)
            pcm = sys.stdin.buffer.read(frames * 4)
            if len(pcm) != frames * 4:
                raise ValueError
            clip = AudioClip(
                np.frombuffer(pcm, dtype="<f4").astype(np.float32, copy=True),
                header["quality"],
            )
            result = encoder.extract(clip)
            write_response({"id": identifier, "result": result})
        except Exception:  # A malformed frame or model error retires this child.
            write_response({"error": "encoder_unavailable"})
            return 1


if __name__ == "__main__":
    sys.exit(main())
