"""Offline, encoder-only inference. The expected artifact hash is operator-pinned."""

import hashlib
import json
from importlib.metadata import version
from pathlib import Path

import numpy as np
import torch
from safetensors.torch import load_file

from voiceprint.audio import AudioClip
from voiceprint.spec import (
    DIMENSION,
    ENCODER_SHA256,
    MAX_SECONDS,
    MIN_SECONDS,
    MODEL_ID,
    MODEL_REVISION,
    PREPROCESS_VERSION,
    SAMPLE_RATE,
    SOURCE_REVISION,
    SOURCE_SHA256,
    VENDOR_SHA256,
    WEIGHTS_SHA256,
    SpeakerEncoderConfig,
    feature_space,
    sha256_file,
)


class QwenEncoder:
    def __init__(self, model_dir: Path, *, expected_sha256: str, threads: int = 2):
        for library, expected_version in {
            "torch": "2.10.0",
            "librosa": "0.11.0",
            "numpy": "2.2.6",
        }.items():
            if version(library).split("+", 1)[0] != expected_version:
                raise ValueError("encoder_dependencies_mismatch")
        vendor = Path(__file__).parent / "_vendor" / "qwen3tts.py"
        if (
            hashlib.sha256(vendor.read_bytes().replace(b"\r\n", b"\n")).hexdigest()
            != VENDOR_SHA256
        ):
            raise ValueError("encoder_source_integrity_failed")
        if len(expected_sha256) != 64 or any(
            c not in "0123456789abcdef" for c in expected_sha256
        ):
            raise ValueError("encoder_pin_invalid")
        if expected_sha256 != ENCODER_SHA256:
            raise ValueError("encoder_pin_mismatch")
        if not 1 <= threads <= 8:
            raise ValueError("thread_budget_invalid")
        artifact = model_dir / "encoder.safetensors"
        if not artifact.is_file() or artifact.stat().st_size > 100 * 1024 * 1024:
            raise ValueError("encoder_artifact_invalid")
        if sha256_file(artifact) != expected_sha256:
            raise ValueError("encoder_integrity_failed")
        manifest_path = model_dir / "manifest.json"
        if manifest_path.stat().st_size > 8192:
            raise ValueError("manifest_invalid")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.space = feature_space(expected_sha256)
        expected = {
            "model_id": MODEL_ID,
            "model_revision": MODEL_REVISION,
            "source_revision": SOURCE_REVISION,
            "source_sha256": SOURCE_SHA256,
            "upstream_weights_sha256": WEIGHTS_SHA256,
            "encoder_sha256": expected_sha256,
            "dimension": DIMENSION,
            "sample_rate": SAMPLE_RATE,
            "preprocess_version": PREPROCESS_VERSION,
            "inference_dtype": "float32",
            "normalization": "l2",
            "feature_space": self.space,
        }
        if not isinstance(manifest, dict) or any(
            manifest.get(key) != value for key, value in expected.items()
        ):
            raise ValueError("feature_space_mismatch")
        from voiceprint._vendor.qwen3tts import Qwen3TTSSpeakerEncoder, mel_spectrogram

        self.mel_spectrogram = mel_spectrogram
        torch.set_num_threads(threads)
        self.model = Qwen3TTSSpeakerEncoder(SpeakerEncoderConfig()).float().eval()
        self.model.load_state_dict(load_file(str(artifact), device="cpu"), strict=True)
        self.model.requires_grad_(False)

    @torch.inference_mode()
    def extract(self, clip: AudioClip) -> dict:
        samples = clip.samples
        if (
            samples.ndim != 1
            or samples.dtype != np.float32
            or not np.isfinite(samples).all()
            or not SAMPLE_RATE * MIN_SECONDS
            <= samples.size
            <= SAMPLE_RATE * MAX_SECONDS
            or np.max(np.abs(samples)) > 1.0
        ):
            raise ValueError("pcm_invalid")
        mel = self.mel_spectrogram(
            torch.from_numpy(samples).unsqueeze(0),
            n_fft=1024,
            num_mels=128,
            sampling_rate=SAMPLE_RATE,
            hop_size=256,
            win_size=1024,
            fmin=0,
            fmax=12000,
        ).transpose(1, 2)
        vector = self.model(mel)[0].float()
        norm = torch.linalg.vector_norm(vector)
        if (
            vector.shape != (DIMENSION,)
            or not torch.isfinite(vector).all()
            or not torch.isfinite(norm)
            or norm <= 1e-8
        ):
            raise ValueError("encoder_output_invalid")
        vector = vector / norm
        return {
            "feature_space": self.space,
            "model_id": MODEL_ID,
            "model_revision": MODEL_REVISION,
            "preprocess_version": PREPROCESS_VERSION,
            "dimension": DIMENSION,
            "sample_rate": SAMPLE_RATE,
            "normalization": "l2",
            "vector": vector.tolist(),
            "quality": clip.quality,
        }
