"""API-facing wrapper over the E5 Content Store contract."""

from work.content.mock.local_filesystem import LocalFilesystemContentStore


def put(org_id: str, data: bytes, *, suffix: str = ".bin") -> tuple[str, str, int]:
    stored = LocalFilesystemContentStore().put(org_id, data, suffix=suffix)
    return stored.ref, stored.content_hash, stored.bytes


def get(org_id: str, ref: str) -> bytes:
    return LocalFilesystemContentStore().get(org_id, ref)


def delete(org_id: str, ref: str) -> None:
    LocalFilesystemContentStore().delete(org_id, ref)
