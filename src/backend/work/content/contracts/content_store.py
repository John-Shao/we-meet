"""Content Store contract (D4). Content never enters DB rows or logs."""

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class StoredObject:
    ref: str
    content_hash: str
    bytes: int


class ContentStoreError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class ContentStore(Protocol):
    def put(
        self, org_id: str, data: bytes, *, suffix: str = ".bin"
    ) -> StoredObject: ...

    def get(self, org_id: str, ref: str) -> bytes: ...

    def delete(self, org_id: str, ref: str) -> None: ...
