"""Frozen Qwen feature space; changing any extraction rule creates a new space."""

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

MODEL_ID = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
MODEL_REVISION = "5d83992436eae1d760afd27aff78a71d676296fc"
SOURCE_REVISION = "022e286b98fbec7e1e916cb940cdf532cd9f488e"
SOURCE_SHA256 = "25c42656bcf810f06ef6bc1839bd7083f3c8cfedac3a147c4060b4262b1c96a0"
VENDOR_SHA256 = "b7534e8a6eeeccdff991da4ee20d3baa923f765a03f985567429963fed6297d7"
CONFIG_SHA256 = "2e714c787c8edb98b05432685cddb634add2de4d4e645f653d68251ef72ba011"
WEIGHTS_SHA256 = "180b3b10eb1c9f1b4db7806d5475bae3071c0243c299d49926bab1da3b6946f6"
ENCODER_SHA256 = "f8b8aa2a5a7e7ddc9043b4979a07bbefca13bfd402a0464a19c1974ea1f6a71a"
WEIGHTS_BYTES = 1829344272
SAMPLE_RATE = 24000
DIMENSION = 1024
MIN_SECONDS = 3
MAX_SECONDS = 10
MAX_BODY_BYTES = SAMPLE_RATE * MAX_SECONDS * 2 + 4096
PREPROCESS_VERSION = "qwen3tts-24k-mel128-fp32-l2-v1"


@dataclass(frozen=True)
class SpeakerEncoderConfig:
    """Defaults from the pinned official config; no Transformers/TTS dependency."""

    mel_dim: int = 128
    enc_dim: int = DIMENSION
    enc_channels: tuple[int, ...] = (512, 512, 512, 512, 1536)
    enc_kernel_sizes: tuple[int, ...] = (5, 3, 3, 3, 1)
    enc_dilations: tuple[int, ...] = (1, 2, 3, 4, 1)
    enc_attention_channels: int = 128
    enc_res2net_scale: int = 8
    enc_se_channels: int = 128
    sample_rate: int = SAMPLE_RATE


def sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def feature_space(encoder_sha256: str) -> str:
    contract = {
        "model_id": MODEL_ID,
        "model_revision": MODEL_REVISION,
        "source_revision": SOURCE_REVISION,
        "source_sha256": SOURCE_SHA256,
        "vendor_sha256": VENDOR_SHA256,
        "weights_sha256": WEIGHTS_SHA256,
        "encoder_sha256": encoder_sha256,
        "preprocess_version": PREPROCESS_VERSION,
        "sample_rate": SAMPLE_RATE,
        "dimension": DIMENSION,
        "inference_dtype": "float32",
        "normalization": "l2",
        "device": "cpu",
        "dependencies": {"torch": "2.10.0", "librosa": "0.11.0", "numpy": "2.2.6"},
        "mel": {
            "n_fft": 1024,
            "hop_size": 256,
            "win_size": 1024,
            "fmin": 0,
            "fmax": 12000,
            "center": False,
            "norm": "slaney",
            "log_floor": 1e-5,
            "magnitude_eps": 1e-9,
        },
    }
    encoded = json.dumps(contract, sort_keys=True, separators=(",", ":")).encode()
    return "qwen3tts-speaker:" + hashlib.sha256(encoded).hexdigest()
