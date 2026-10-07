import base64
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "provision", Path(__file__).with_name("provision-work-k3s.py")
)
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)


class ProvisionTests(unittest.TestCase):
    def test_registry_copy_only_requested_host(self):
        raw = {
            "auths": {
                provision.REGISTRY: {"auth": "private-placeholder"},
                "unrelated.example": {"auth": "other"},
            }
        }
        result = provision.scoped_registry(
            {".dockerconfigjson": base64.b64encode(json.dumps(raw).encode()).decode()}
        )
        decoded = json.loads(base64.b64decode(result[".dockerconfigjson"]))
        self.assertEqual(set(decoded["auths"]), {provision.REGISTRY})

    def test_registry_copy_requires_exact_host(self):
        raw = {"auths": {provision.REGISTRY + ".attacker.example": {"auth": "other"}}}
        with self.assertRaisesRegex(
            provision.ProvisionError, "registry_credential_missing"
        ):
            provision.scoped_registry(
                {
                    ".dockerconfigjson": base64.b64encode(
                        json.dumps(raw).encode()
                    ).decode()
                }
            )

    def test_chart_traversal_rejected(self):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w:gz") as tar:
            entry = tarfile.TarInfo("work-agent-k8s/../../escape")
            entry.size = 1
            tar.addfile(entry, io.BytesIO(b"x"))
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(provision.ProvisionError, "unsafe_chart_path"):
                provision.unpack_chart(
                    base64.b64encode(output.getvalue()), Path(folder)
                )

    def test_chart_symlink_rejected(self):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w:gz") as tar:
            entry = tarfile.TarInfo("work-agent-k8s/link")
            entry.type = tarfile.SYMTYPE
            entry.linkname = "/etc"
            tar.addfile(entry)
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(
                provision.ProvisionError, "unsafe_chart_member"
            ):
                provision.unpack_chart(
                    base64.b64encode(output.getvalue()), Path(folder)
                )

    def test_lost_create_ack_refuses_unrelated_secret(self):
        resource = {
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": {"name": "fixed", "namespace": "ns"},
            "data": {"one": "a"},
        }
        other = {
            "metadata": {
                "uid": "unrelated",
                "labels": {provision.OWNER: "someone-else"},
            },
            "data": {"one": "a"},
        }
        with patch.object(
            provision, "api", side_effect=[provision.ProvisionError("lost_ack"), other]
        ) as api:
            with self.assertRaisesRegex(
                provision.ProvisionError, "resource_creation_unknown"
            ):
                provision.create(resource, {"id": "mine", "resources": []})
        self.assertEqual(api.call_count, 2)
        self.assertEqual(api.call_args_list[0].args[0], "create")
        self.assertEqual(api.call_args_list[1].args[0], "get")

    def test_lost_create_ack_refuses_changed_credential_payload(self):
        resource = {
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": {"name": "fixed", "namespace": "ns"},
            "data": {"one": "a"},
        }
        changed = {
            "metadata": {"uid": "owned", "labels": {provision.OWNER: "mine"}},
            "data": {"one": "different"},
        }
        with patch.object(
            provision,
            "api",
            side_effect=[provision.ProvisionError("lost_ack"), changed],
        ):
            with self.assertRaisesRegex(
                provision.ProvisionError, "secret_creation_unknown"
            ):
                provision.create(resource, {"id": "mine", "resources": []})


if __name__ == "__main__":
    unittest.main()
