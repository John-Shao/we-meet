"""One private fixed-object S3 read, under its parent's process-tree budget."""

import hashlib
import json
import sys
import time
from contextlib import closing
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from core.services.voiceprint_media import MAX_SOURCE_BYTES
from core.services.voiceprint_media_lifetime import contain_parent_exit
from core.services.voiceprint_source_objects import parse
from core.services.voiceprint_source_storage import configuration


def execute(value):  # noqa: PLR0912 -- Validate object evidence at every I/O boundary.
    if not isinstance(value, dict) or set(value) != {
        "receipt",
        "config",
        "root",
        "expires",
    }:
        raise ValueError
    receipt, config = parse(value["receipt"]), configuration(value["config"])
    if (
        type(value["expires"]) is not int
        or value["expires"] <= time.time()
        or receipt.size > MAX_SOURCE_BYTES
    ):
        raise ValueError
    if not isinstance(value["root"], str) or len(value["root"]) > 2048:
        raise ValueError
    root = Path(value["root"])
    if not root.is_absolute() or not root.is_dir() or root.is_symlink():
        raise ValueError
    key = "/".join(item for item in (config.prefix, receipt.key) if item)
    kwargs = {"Bucket": config.bucket, "Key": key}
    if receipt.kind == "s3_object":
        kwargs["IfMatch"] = receipt.etag
        if receipt.version_id is not None:
            kwargs["VersionId"] = receipt.version_id
    # No proxies, ambient credentials, compressed transfer or automatic retry.
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
        response = client.get_object(**kwargs)
        stream = response["Body"]
        try:
            if (
                type(response.get("ContentLength")) is not int
                or response["ContentLength"] != receipt.size
                or response.get("ContentEncoding", "identity") != "identity"
            ):
                raise ValueError
            if receipt.kind == "s3_object" and (
                response.get("ETag") != receipt.etag
                or receipt.version_id is not None
                and response.get("VersionId") != receipt.version_id
            ):
                raise ValueError
            checksum, size = hashlib.sha256(), 0
            with (root / "source.media").open("xb") as output:
                while True:
                    if time.time() >= value["expires"]:
                        raise ValueError
                    chunk = stream.read(65536)
                    if time.time() >= value["expires"]:
                        raise ValueError
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > receipt.size:
                        raise ValueError
                    checksum.update(chunk)
                    output.write(chunk)
            if (
                size != receipt.size
                or receipt.kind == "content_sha256"
                and checksum.hexdigest() != receipt.sha256
            ):
                raise ValueError
            # A conditional post-read HEAD binds the result to the same live
            # object token. Versioned reads explicitly request that version.
            head = client.head_object(**kwargs)
            if (
                head.get("ContentLength") != receipt.size
                or receipt.kind == "s3_object"
                and (
                    head.get("ETag") != receipt.etag
                    or receipt.version_id is not None
                    and head.get("VersionId") != receipt.version_id
                )
            ):
                raise ValueError
            if time.time() >= value["expires"]:
                raise ValueError
            return {"sha256": checksum.hexdigest(), "size": size}
        finally:
            stream.close()


def main():
    try:
        contain_parent_exit(int(sys.argv[1]))
        if sys.platform.startswith("linux"):
            import resource  # noqa: PLC0415 -- Linux-only process bounds.

            resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
            resource.setrlimit(resource.RLIMIT_CPU, (25, 25))
            resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_SOURCE_BYTES,) * 2)
        encoded = sys.stdin.buffer.read(32769)
        if len(encoded) > 32768:
            raise ValueError
        result = execute(json.loads(encoded))
    except ClientError as error:
        result = {
            "error": "media_storage_unavailable",
            "retryable": error.response.get("ResponseMetadata", {}).get(
                "HTTPStatusCode"
            )
            in {408, 429, 500, 502, 503, 504},
        }
    except BotoCoreError:
        result = {"error": "media_storage_unavailable", "retryable": True}
    except (
        ValueError,
        TypeError,
        KeyError,
        IndexError,
        OSError,
        RecursionError,
    ):
        result = {"error": "media_source_integrity_unavailable", "retryable": False}
    sys.stdout.buffer.write(json.dumps(result, separators=(",", ":")).encode("ascii"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
