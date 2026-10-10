"""Private bounded S3 reads into disposable directories; no signed media URL."""

import json
import re
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from storages.backends.s3 import S3Storage

from core.services.voiceprint_media import MAX_SOURCE_BYTES, MediaFile
from core.services.voiceprint_media_process import MediaError, invoke
from core.services.voiceprint_query_files import leased_directory
from core.services.voiceprint_source_objects import parse


@dataclass(frozen=True, repr=False)
class StorageConfiguration:
    bucket: str
    prefix: str
    region: str | None
    endpoint: str | None
    access_key: str
    secret_key: str
    session_token: str | None = field(default=None)
    ca_bundle: bool | str = True
    addressing_style: str = "auto"

    def validate(self):
        if (
            not isinstance(self.bucket, str)
            or re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}", self.bucket) is None
            or not isinstance(self.prefix, str)
            or len(self.prefix) > 500
            or self.prefix.startswith("/")
            or self.prefix
            and any(part in {"", ".", ".."} for part in self.prefix.split("/"))
            or any(ord(char) < 32 or char in "\\:" for char in self.prefix)
            or self.region is not None
            and (
                not isinstance(self.region, str)
                or re.fullmatch(r"[a-zA-Z0-9-]{1,64}", self.region) is None
            )
            or self.endpoint is not None
            and (
                not isinstance(self.endpoint, str)
                or not 1 <= len(self.endpoint) <= 2048
                or any(ord(char) <= 32 or ord(char) == 127 for char in self.endpoint)
            )
            or not isinstance(self.addressing_style, str)
            or self.addressing_style not in {"auto", "path", "virtual"}
            or not (
                self.ca_bundle is True
                or isinstance(self.ca_bundle, str)
                and Path(self.ca_bundle).is_file()
            )
            or any(
                not isinstance(value, str)
                or not 16 <= len(value) <= 256
                or not all(33 <= ord(char) <= 126 for char in value)
                for value in (self.access_key, self.secret_key)
            )
            or self.session_token is not None
            and (
                not isinstance(self.session_token, str)
                or not 1 <= len(self.session_token) <= 8192
                or not all(33 <= ord(char) <= 126 for char in self.session_token)
            )
        ):
            raise MediaError("media_storage_configuration_invalid")
        if self.endpoint is not None:
            try:
                value = urlsplit(self.endpoint)
                if (
                    not value.hostname
                    or value.username
                    or value.password
                    or value.query
                    or value.fragment
                    or value.path not in {"", "/"}
                    or any(char.isspace() for char in self.endpoint)
                    or value.port is not None
                    and not 1 <= value.port <= 65535
                    or not (
                        value.scheme == "https"
                        or value.scheme == "http"
                        and value.hostname in {"127.0.0.1", "::1", "localhost"}
                    )
                ):
                    raise ValueError
            except (ValueError, TypeError):
                raise MediaError("media_storage_configuration_invalid") from None
        return self

    def payload(self):
        return asdict(self)


def from_storage(storage):
    if not isinstance(storage, S3Storage):
        raise MediaError("media_storage_configuration_invalid")
    # Only explicit service credentials cross the pipe. No ambient SDK metadata
    # credential discovery, environment fallback or application key is accepted.
    return StorageConfiguration(
        storage.bucket_name,
        storage.location.strip("/"),
        storage.region_name,
        storage.endpoint_url,
        storage.access_key,
        storage.secret_key,
        storage.security_token,
        storage.verify if storage.verify is not None else True,
        storage.addressing_style or "auto",
    ).validate()


def configuration(value):
    if not isinstance(value, dict) or set(value) != set(
        StorageConfiguration.__dataclass_fields__
    ):
        raise MediaError("media_storage_configuration_invalid")
    try:
        return StorageConfiguration(**value).validate()
    except (ValueError, TypeError, OSError):
        raise MediaError("media_storage_configuration_invalid") from None


@dataclass(frozen=True)
class DownloadedSource:
    media: MediaFile = field(repr=False)
    sha256: str = field(repr=False)
    size: int


@contextmanager
def download(receipt, *, config, expires, authorized, seconds=90):
    config.validate()
    receipt = parse(receipt.payload())
    if (
        receipt.size > MAX_SOURCE_BYTES
        or type(expires) is not int
        or expires <= time.time()
    ):
        raise MediaError("media_input_invalid")
    with leased_directory(expires) as root:
        # The child creates one fixed filename exclusively. No client path, file
        # name or URL is passed to the native decoder; every exit cleans it up.
        encoded = invoke(
            {
                "receipt": receipt.payload(),
                "config": config.payload(),
                "root": root,
                "expires": expires,
            },
            maximum=4096,
            expires=expires,
            authorized=authorized,
            seconds=seconds,
            purpose="storage",
        )
        try:
            result = json.loads(encoded)
            if isinstance(result, dict) and set(result) == {"error", "retryable"}:
                if (
                    result["error"]
                    not in {
                        "media_storage_unavailable",
                        "media_source_integrity_unavailable",
                    }
                    or type(result["retryable"]) is not bool
                ):
                    raise ValueError
                raise MediaError(result["error"], retryable=result["retryable"])
            if (
                not isinstance(result, dict)
                or set(result) != {"sha256", "size"}
                or type(result["size"]) is not int
                or result["size"] != receipt.size
                or not isinstance(result["sha256"], str)
                or re.fullmatch(r"[0-9a-f]{64}", result["sha256"]) is None
                or receipt.kind == "content_sha256"
                and result["sha256"] != receipt.sha256
            ):
                raise ValueError
        except (ValueError, TypeError, RecursionError) as error:
            if isinstance(error, MediaError):
                raise
            raise MediaError("media_storage_response_invalid") from None
        media = MediaFile(str(Path(root) / "source.media"), root)
        if (
            media.stat()[2] != receipt.size
            or not authorized()
            or time.time() >= expires
        ):
            raise MediaError("media_authorization_revoked")
        yield DownloadedSource(media, result["sha256"], result["size"])
