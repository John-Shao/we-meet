"""Local Content Store mock (E5 swaps this for the platform object store)."""

import hashlib
import os
import tempfile
import uuid
from pathlib import Path

from work.content.contracts.content_store import ContentStoreError, StoredObject

PREFIX = "content://"
DEFAULT_ROOT = Path(tempfile.gettempdir()) / "we-meet-work-content"


class LocalFilesystemContentStore:
    def __init__(self, root: str | Path | None = None):
        self.root = Path(root or os.environ.get("WORK_CONTENT_ROOT") or DEFAULT_ROOT)

    def _path(self, org_id: str, ref: str) -> Path:
        if not ref.startswith(PREFIX):
            raise ContentStoreError("content_ref_invalid")
        owner, _, name = ref[len(PREFIX) :].partition("/")
        if owner != org_id or not name or "/" in name or name in (".", ".."):
            raise ContentStoreError("content_ref_invalid")
        return self.root / org_id / name

    def put(self, org_id: str, data: bytes, *, suffix: str = ".bin") -> StoredObject:
        name = f"{uuid.uuid4().hex}{suffix}"
        path = self.root / org_id / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return StoredObject(
            ref=f"{PREFIX}{org_id}/{name}",
            content_hash=f"sha256:{hashlib.sha256(data).hexdigest()}",
            bytes=len(data),
        )

    def get(self, org_id: str, ref: str) -> bytes:
        try:
            return self._path(org_id, ref).read_bytes()
        except FileNotFoundError as error:
            raise ContentStoreError("content_not_found") from error

    def delete(self, org_id: str, ref: str) -> None:
        try:
            self._path(org_id, ref).unlink()
        except FileNotFoundError:
            pass
