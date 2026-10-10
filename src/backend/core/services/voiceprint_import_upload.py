"""Killable private derivative PUT. No application credential environment."""

import hashlib
import json
import re
import sys
import time
from contextlib import closing
from uuid import UUID

import boto3
from botocore.config import Config

from core.services.voiceprint_media import MediaFile
from core.services.voiceprint_media_lifetime import contain_parent_exit
from core.services.voiceprint_source_objects import from_head, parse
from core.services.voiceprint_source_storage import configuration


def execute(value):
    if not isinstance(value, dict) or set(value) != {
        "source",
        "config",
        "expires",
        "input_id",
    }:
        raise ValueError
    if not isinstance(value["source"], dict) or set(value["source"]) != {
        "path",
        "root",
    }:
        raise ValueError
    if type(value["expires"]) is not int or value["expires"] <= time.time():
        raise ValueError
    identifier = UUID(value["input_id"])
    config = configuration(value["config"])
    source = MediaFile(**value["source"])
    snapshot = source.stat()
    name = f"record-uploads/identity-input-{identifier}.wav"
    key = "/".join(part for part in (config.prefix, name) if part)
    checksum = hashlib.sha256()
    with open(source.path, "rb") as stream:
        while chunk := stream.read(65536):
            if time.time() >= value["expires"]:
                raise ValueError
            checksum.update(chunk)
    if source.stat() != snapshot:
        raise ValueError
    digest = checksum.hexdigest()
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
        with open(source.path, "rb") as stream:
            result = client.put_object(
                Bucket=config.bucket,
                Key=key,
                Body=stream,
                ContentLength=snapshot[2],
                ContentType="audio/wav",
                Metadata={"identity-input": str(identifier), "sha256": digest},
            )
        # The same pinned object serves ASR and later identity queries. An
        # ambiguous PUT or absent version never silently chooses the live key.
        version = result.get("VersionId")
        if not isinstance(version, str) or not version or version == "null":
            raise ValueError
        head = client.head_object(Bucket=config.bucket, Key=key, VersionId=version)
        receipt = parse(from_head(name, snapshot[2], head))
        if (
            receipt.version_id != version
            or head.get("Metadata", {}).get("identity-input") != str(identifier)
            or head.get("Metadata", {}).get("sha256") != digest
            or source.stat() != snapshot
            or time.time() >= value["expires"]
        ):
            raise ValueError
        return {"receipt": receipt.payload(), "sha256": digest}


def main():
    try:
        contain_parent_exit(int(sys.argv[1]))
        if sys.platform.startswith("linux"):
            import resource  # noqa: PLC0415 -- Linux-only limits.

            resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
            resource.setrlimit(resource.RLIMIT_CPU, (25, 25))
        value = sys.stdin.buffer.read(32769)
        if len(value) > 32768:
            raise ValueError
        result = execute(json.loads(value))
        if re.fullmatch(r"[0-9a-f]{64}", result["sha256"]) is None:
            raise ValueError
        sys.stdout.buffer.write(
            json.dumps(result, separators=(",", ":")).encode("ascii")
        )
        return 0
    except Exception:  # noqa: BLE001 -- No keys, URLs, paths or SDK diagnostics cross this boundary.
        return 1


if __name__ == "__main__":
    sys.exit(main())
