"""Killable fixed-chunk S3 reads and gap-preserving PCM assembly; no ASR calls."""

import hashlib
import json
import os
import re
import sys
import time
import wave
from contextlib import closing
from pathlib import Path
from uuid import UUID

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from core.services import capture_pcm
from core.services.voiceprint_media_lifetime import contain_parent_exit
from core.services.voiceprint_query_files import directory
from core.services.voiceprint_source_storage import configuration

MAX_COMMAND_BYTES = 2 * 1024 * 1024
MAX_DURATION_MS = 7200000


def command(value):
    if not isinstance(value, dict) or set(value) != {
        "record_id",
        "capture_id",
        "chunks",
        "duration_ms",
        "config",
        "root",
        "expires",
    }:
        raise ValueError
    record, capture = UUID(value["record_id"]), UUID(value["capture_id"])
    duration, expires = value["duration_ms"], value["expires"]
    if (
        type(duration) is not int
        or not 0 < duration <= MAX_DURATION_MS
        or type(expires) is not int
        or not time.time() < expires <= time.time() + 900
        or not isinstance(value["chunks"], list)
        or not 1 <= len(value["chunks"]) <= 4320
    ):
        raise ValueError
    sequence, end = 0, 0
    chunks = []
    identifiers = set()
    for row in value["chunks"]:
        if not isinstance(row, dict) or set(row) != {
            "id",
            "sequence",
            "start_ms",
            "duration_ms",
            "checksum",
            "byte_size",
            "stored",
        }:
            raise ValueError
        identifier = UUID(row["id"])
        if (
            identifier in identifiers
            or any(
                type(row[key]) is not int
                for key in ("sequence", "start_ms", "duration_ms", "byte_size")
            )
            or not sequence < row["sequence"] <= 4320
            or not 1 <= row["duration_ms"] <= 10000
            or not end
            <= row["start_ms"]
            < row["start_ms"] + row["duration_ms"]
            <= duration
            or not 44 <= row["byte_size"] <= capture_pcm.MAX_BYTES
            or row["stored"] is not True
            or not isinstance(row["checksum"], str)
            or re.fullmatch(r"[0-9a-f]{64}", row["checksum"]) is None
        ):
            raise ValueError
        chunks.append((row, f"capture-audio/{record}/{capture}/{identifier}.wav"))
        identifiers.add(identifier)
        sequence, end = row["sequence"], row["start_ms"] + row["duration_ms"]
    if not isinstance(value["root"], str) or len(value["root"]) > 2048:
        raise ValueError
    root = Path(value["root"])
    if (
        not root.is_absolute()
        or root.is_symlink()
        or not root.is_dir()
        or root.resolve().parent != directory()
        or not root.name.startswith("query-")
    ):
        raise ValueError
    return configuration(value["config"]), root.resolve(), chunks


def _check_deadline(value):
    if time.time() >= value["expires"]:
        raise ValueError


def _read(client, config, key, row, value):
    key = "/".join(part for part in (config.prefix, key) if part)
    _check_deadline(value)
    response = client.get_object(Bucket=config.bucket, Key=key)
    with closing(response["Body"]) as stream:
        if (
            response.get("ContentLength") != row["byte_size"]
            or response.get("ContentEncoding", "identity") != "identity"
        ):
            raise ValueError
        data = stream.read(capture_pcm.MAX_BYTES + 1)
    _check_deadline(value)
    if (
        len(data) != row["byte_size"]
        or hashlib.sha256(data).hexdigest() != row["checksum"]
    ):
        raise ValueError
    pcm = capture_pcm.frames(data)
    if len(pcm) != row["duration_ms"] * 32:
        raise ValueError
    return pcm


def _silence(output, milliseconds, value):
    remaining = milliseconds * 32
    block = bytes(65536)
    while remaining:
        _check_deadline(value)
        size = min(remaining, len(block))
        output.writeframesraw(block[:size])
        remaining -= size


def execute(value):
    config, root, chunks = command(value)
    with closing(
        boto3.client(
            "s3",
            endpoint_url=config.endpoint,
            region_name=config.region,
            aws_access_key_id=config.access_key,
            aws_secret_access_key=config.secret_key,
            aws_session_token=config.session_token,
            verify=config.ca_bundle,
            config=Config(
                connect_timeout=3,
                read_timeout=5,
                retries={"total_max_attempts": 1},
                signature_version="s3v4",
                proxies={},
                s3={"addressing_style": config.addressing_style},
            ),
        )
    ) as client:
        descriptor = os.open(
            root / "source.media", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
        )
        with os.fdopen(descriptor, "wb") as file, wave.open(file, "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(capture_pcm.SAMPLE_RATE)
            output.setnframes(value["duration_ms"] * 16)
            end = 0
            for row, key in chunks:
                pcm = _read(client, config, key, row, value)
                _silence(output, row["start_ms"] - end, value)
                output.writeframesraw(pcm)
                end = row["start_ms"] + row["duration_ms"]
            _silence(output, value["duration_ms"] - end, value)
    checksum, size = hashlib.sha256(), 0
    with (root / "source.media").open("rb") as stream:
        while block := stream.read(65536):
            _check_deadline(value)
            size += len(block)
            checksum.update(block)
    if size != 44 + value["duration_ms"] * 32:
        raise ValueError
    return {"sha256": checksum.hexdigest(), "size": size}


def main():
    try:
        contain_parent_exit(int(sys.argv[1]))
        if sys.platform.startswith("linux"):
            import resource  # noqa: PLC0415 -- Linux-only process bounds.

            resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
            resource.setrlimit(resource.RLIMIT_CPU, (90, 90))
            resource.setrlimit(resource.RLIMIT_FSIZE, (44 + MAX_DURATION_MS * 32,) * 2)
        encoded = sys.stdin.buffer.read(MAX_COMMAND_BYTES + 1)
        if len(encoded) > MAX_COMMAND_BYTES:
            raise ValueError
        result = execute(json.loads(encoded))
    except (BotoCoreError, ClientError):
        result = {"error": "media_storage_unavailable", "retryable": True}
    except Exception:  # noqa: BLE001 -- No source paths, audio or SDK diagnostics leave the child.
        result = {"error": "media_source_integrity_unavailable", "retryable": False}
    sys.stdout.buffer.write(json.dumps(result, separators=(",", ":")).encode("ascii"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
