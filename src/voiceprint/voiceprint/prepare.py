"""Provisioning only: extract encoder tensors from verified pinned local weights."""

import argparse
import json
from pathlib import Path

from safetensors import safe_open
from safetensors.torch import save_file

from voiceprint.spec import (
    CONFIG_SHA256,
    DIMENSION,
    ENCODER_SHA256,
    MODEL_ID,
    MODEL_REVISION,
    PREPROCESS_VERSION,
    SAMPLE_RATE,
    SOURCE_REVISION,
    SOURCE_SHA256,
    WEIGHTS_BYTES,
    WEIGHTS_SHA256,
    feature_space,
    sha256_file,
)


def prepare(source: Path, destination: Path) -> dict:
    if source.stat().st_size != WEIGHTS_BYTES or sha256_file(source) != WEIGHTS_SHA256:
        raise ValueError("upstream_weights_integrity_failed")
    if destination.exists():
        raise ValueError("destination_already_exists")
    prefix = "speaker_encoder."
    with safe_open(source, framework="pt", device="cpu") as weights:
        selected = {
            key.removeprefix(prefix): weights.get_tensor(key).contiguous()
            for key in weights.keys()
            if key.startswith(prefix)
        }
    if not selected:
        raise ValueError("encoder_namespace_missing")
    # Strict shape/key verification before publishing an artifact.
    from voiceprint._vendor.qwen3tts import Qwen3TTSSpeakerEncoder
    from voiceprint.spec import SpeakerEncoderConfig

    encoder = Qwen3TTSSpeakerEncoder(SpeakerEncoderConfig())
    encoder.load_state_dict(selected, strict=True)
    destination.mkdir(parents=True)
    artifact = destination / "encoder.safetensors"
    # Keep tensor packing deterministic; provenance lives in the manifest.
    save_file(selected, str(artifact))
    digest = sha256_file(artifact)
    if digest != ENCODER_SHA256:
        raise ValueError("encoder_packing_mismatch")
    manifest = {
        "model_id": MODEL_ID,
        "model_revision": MODEL_REVISION,
        "source_revision": SOURCE_REVISION,
        "source_sha256": SOURCE_SHA256,
        "upstream_config_sha256": CONFIG_SHA256,
        "upstream_weights_sha256": WEIGHTS_SHA256,
        "upstream_weights_bytes": WEIGHTS_BYTES,
        "encoder_sha256": digest,
        "encoder_bytes": artifact.stat().st_size,
        "tensor_count": len(selected),
        "parameters": sum(tensor.numel() for tensor in selected.values()),
        "dimension": DIMENSION,
        "sample_rate": SAMPLE_RATE,
        "preprocess_version": PREPROCESS_VERSION,
        "inference_dtype": "float32",
        "normalization": "l2",
        "feature_space": feature_space(digest),
    }
    (destination / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-model", required=True, type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(prepare(args.source_model, args.destination), sort_keys=True))


if __name__ == "__main__":
    main()
