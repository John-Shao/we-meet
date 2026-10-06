"""Safety boundaries; real restore validation is performed separately in Docker."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import types
import unittest
from unittest.mock import MagicMock, patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


backup = load("backup")
restore = load("verify_restore")


class Storage:
    def __init__(self, corrupt=False, public=False):
        self.data = b""
        self.corrupt = corrupt
        self.public = public

    def get_object_acl(self, **kwargs):
        grants = [{"Grantee": {"Type": "CanonicalUser", "ID": "owner"}, "Permission": "FULL_CONTROL"}]
        if self.public:
            grants.append({"Grantee": {"Type": "Group", "URI": "AllUsers"}, "Permission": "READ"})
        return {"Owner": {"ID": "owner"}, "Grants": grants}

    get_bucket_acl = get_object_acl

    def upload_file(self, path, bucket, key, ExtraArgs):
        assert ExtraArgs["ACL"] == "private"
        self.data = Path(path).read_bytes()

    def head_object(self, **kwargs):
        return {"ContentLength": len(self.data)}

    def get_object(self, **kwargs):
        return {"Body": io.BytesIO(b"bad" if self.corrupt else self.data)}


class BackupSafetyTests(unittest.TestCase):
    def test_object_client_supports_old_and_new_sdk_without_oss_trailers(self):
        for supported in [False, True]:
            constructor = MagicMock()
            constructor.OPTION_DEFAULTS = ({"request_checksum_calculation": None,
                                            "response_checksum_validation": None} if supported else {})
            sdk = types.ModuleType("boto3")
            sdk.client = MagicMock()
            config_module = types.ModuleType("botocore.config")
            config_module.Config = constructor
            with patch.dict("sys.modules", {"boto3": sdk, "botocore.config": config_module}):
                backup.object_client({"endpoint": "https://oss.example.com", "region": "region",
                                      "access_key": "test-id", "secret_key": "test-only"})
            options = constructor.call_args.kwargs
            self.assertEqual(options["signature_version"], "s3v4")
            for key in ["request_checksum_calculation", "response_checksum_validation"]:
                if supported:
                    self.assertEqual(options[key], "when_required")
                else:
                    self.assertNotIn(key, options)

    def test_plaintext_never_uploaded(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "data.age"
            path.write_bytes(b"plaintext credentials")
            storage = Storage()
            with self.assertRaises(ValueError):
                backup.upload_verified(storage, "bucket", "data.age", path)
            self.assertEqual(storage.data, b"")

    def test_success_requires_private_acl_and_complete_readback(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "data.age"
            path.write_bytes(b"age-encryption.org/v1\nnot-a-real-ciphertext")
            self.assertEqual(backup.upload_verified(Storage(), "b", "k.age", path), backup.sha256(path))
            for client in [Storage(corrupt=True), Storage(public=True)]:
                with self.assertRaises(RuntimeError):
                    backup.upload_verified(client, "b", "k.age", path)

    def test_public_bucket_rejected_before_backup(self):
        with self.assertRaises(RuntimeError):
            backup.require_private(Storage(public=True), "bucket")

    def test_extract_rejects_traversal_and_links(self):
        for name, link in [("../escape", False), ("symlink", True)]:
            with tempfile.TemporaryDirectory() as root:
                archive = Path(root) / "test.tar.gz"
                with tarfile.open(archive, "w:gz") as tar:
                    info = tarfile.TarInfo(name)
                    if link:
                        info.type = tarfile.SYMTYPE
                        info.linkname = "/etc/passwd"
                    tar.addfile(info)
                with self.assertRaises(ValueError):
                    restore.safe_extract(archive, Path(root) / "dest")

    def test_manifest_tampering_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            (path / "dump").write_bytes(b"database")
            manifest = {"files": {"dump": hashlib.sha256(b"database").hexdigest()}}
            restore.verify_files(path, manifest)
            (path / "dump").write_bytes(b"corrupt")
            with self.assertRaises(ValueError):
                restore.verify_files(path, manifest)

    def test_bad_archive_hash_never_starts_docker(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "backup.age"
            path.write_bytes(b"wrong")
            with patch.object(restore, "run") as run:
                with self.assertRaises(ValueError):
                    restore.drill(path, path, "0" * 64, path, "postgres:16-alpine")
                run.assert_not_called()

    def test_stale_offsite_receipt_fails(self):
        client = Storage()
        client.data = json.dumps({"completed_at": "2000-01-01T00:00:00+00:00"}).encode()
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / "storage.json").write_text(json.dumps({"bucket": "b", "prefix": "p/"}))
            with patch.object(backup, "object_client", return_value=client):
                with self.assertRaises(RuntimeError):
                    backup.check_backup({"config_dir": root}, 8)


if __name__ == "__main__":
    unittest.main()
