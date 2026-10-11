"""Server-issued object receipts; upload intent hashes are not content digests."""

import re
from dataclasses import asdict, dataclass, field


@dataclass(frozen=True)
class ObjectReceipt:
    kind: str
    key: str = field(repr=False)
    size: int
    sha256: str = field(default="", repr=False)
    etag: str = field(default="", repr=False)
    version_id: str | None = field(default=None, repr=False)

    def validate(self):
        if (
            not isinstance(self.key, str)
            or not self.key.startswith("record-uploads/")
            or len(self.key) > 500
            or any(part in {"", ".", ".."} for part in self.key.split("/"))
            or any(ord(char) < 32 or char in "\\:" for char in self.key)
            or type(self.size) is not int
            or not 0 < self.size <= 2**63 - 1
        ):
            raise ValueError("voiceprint_object_receipt_invalid")
        if self.kind == "content_sha256":
            valid = (
                isinstance(self.sha256, str)
                and re.fullmatch(r"[0-9a-f]{64}", self.sha256)
                and self.etag == ""
                and self.version_id is None
            )
        elif self.kind == "s3_object":
            valid = (
                self.sha256 == ""
                and isinstance(self.etag, str)
                and re.fullmatch(r'"[!#-\[\]-~]{1,126}"', self.etag)
                and (
                    self.version_id is None
                    or isinstance(self.version_id, str)
                    and 0 < len(self.version_id) <= 1024
                    and all(33 <= ord(char) <= 126 for char in self.version_id)
                )
            )
        else:
            valid = False
        if not valid:
            raise ValueError("voiceprint_object_receipt_invalid")
        return self

    def payload(self):
        return {"schema": 1, **asdict(self)}


def parse(value):
    if (
        not isinstance(value, dict)
        or set(value)
        != {"schema", "kind", "key", "size", "sha256", "etag", "version_id"}
        or type(value["schema"]) is not int
        or value["schema"] != 1
    ):
        raise ValueError("voiceprint_object_receipt_invalid")
    return ObjectReceipt(
        **{key: item for key, item in value.items() if key != "schema"}
    ).validate()


def from_head(key, size, head):
    """Missing provider tokens disable identity reads, never ordinary ASR."""
    try:
        if (
            not isinstance(head, dict)
            or type(head.get("ContentLength")) is not int
            or head["ContentLength"] != size
        ):
            raise ValueError
        return (
            ObjectReceipt(
                "s3_object",
                key,
                size,
                etag=head.get("ETag"),
                version_id=head.get("VersionId")
                if head.get("VersionId") != "null"
                else None,
            )
            .validate()
            .payload()
        )
    except (ValueError, TypeError):
        return None
