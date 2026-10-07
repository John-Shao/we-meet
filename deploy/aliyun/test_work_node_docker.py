"""Opt-in real dsh/Pi probes with disposable state on an explicitly named local daemon."""

import importlib.util
import json
import os
import re
import socket
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location(
    "realnodecheck", Path(__file__).with_name("check-work-node.py")
)
nodecheck = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nodecheck)
ROOT = Path(__file__).resolve().parents[2]
IMMUTABLE = re.compile(r"[^\s@]+@sha256:[a-f0-9]{64}")


@unittest.skipUnless(
    os.environ.get("WORK_NODE_DOCKER_TEST") == "1", "real Docker node probe opt-in"
)
class RealNodeDockerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        required = (
            "WORK_NODE_TEST_CONTEXT",
            "WORK_NODE_TEST_DAEMON",
            "WORK_NODE_TEST_GATEWAY_IMAGE",
            "WORK_NODE_TEST_PI_IMAGE",
            "WORK_NODE_TEST_DSH_IMAGE",
            "WORK_NODE_TEST_PI_VERSION",
            "WORK_NODE_TEST_DSH_VERSION",
        )
        if any(not os.environ.get(key) for key in required):
            raise nodecheck.NodeError("explicit_fixture_configuration_required")
        cls.docker = nodecheck.Docker(os.environ["WORK_NODE_TEST_CONTEXT"])
        cls.daemon = os.environ["WORK_NODE_TEST_DAEMON"]
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,126}", cls.daemon):
            raise nodecheck.NodeError("invalid_fixture_daemon_name")
        contexts = cls.docker.json("context", "inspect", cls.docker.context)
        if len(contexts) != 1 or contexts[0].get("Endpoints", {}).get("docker", {}).get(
            "Host"
        ) not in {
            "unix:///var/run/docker.sock",
            "npipe:////./pipe/docker_engine",
            "npipe:////./pipe/dockerDesktopLinuxEngine",
        }:
            raise nodecheck.NodeError("local_fixture_docker_socket_required")
        info = cls.docker.json("info", "--format", "{{json .}}")
        if info.get("Name") != cls.daemon or info.get("OSType") != "linux":
            raise nodecheck.NodeError("fixture_daemon_mismatch")
        cls.desktop = info.get("OperatingSystem") == "Docker Desktop"
        cls.gateway = cls.image_id(os.environ["WORK_NODE_TEST_GATEWAY_IMAGE"])
        cls.workers = {}
        for engine in ("pi", "dsh"):
            reference = os.environ[f"WORK_NODE_TEST_{engine.upper()}_IMAGE"]
            cls.image_id(reference)
            version = os.environ[f"WORK_NODE_TEST_{engine.upper()}_VERSION"]
            if not re.fullmatch(r"[0-9][A-Za-z0-9.+_-]{0,62}", version):
                raise nodecheck.NodeError("invalid_fixture_runtime_version")
            cls.workers[engine] = (reference, version)

    @classmethod
    def image_id(cls, reference):
        if not IMMUTABLE.fullmatch(reference):
            raise nodecheck.NodeError("immutable_fixture_image_required")
        rows = cls.docker.json("image", "inspect", reference)
        if len(rows) != 1 or reference not in (rows[0].get("RepoDigests") or []):
            raise nodecheck.NodeError("fixture_image_digest_mismatch")
        item = rows[0]
        if not nodecheck.IMAGE_ID.fullmatch(item.get("Id", "")):
            raise nodecheck.NodeError("fixture_image_digest_mismatch")
        if item.get("Os") != "linux" or any(
            entry.partition("=")[0] in nodecheck.SECRET_ENV and entry.partition("=")[2]
            for entry in item.get("Config", {}).get("Env", [])
        ):
            raise nodecheck.NodeError("unsafe_fixture_image")
        return item["Id"]

    def container(self, arguments, *, allow_failed=False):
        """Even a lost create/start reply must clean only this frozen image and label."""
        marker = uuid.uuid4().hex
        name = "work-node-acceptance-" + marker
        try:
            self.docker.run(
                "container",
                "create",
                "--pull=never",
                "--name",
                name,
                "--label",
                nodecheck.LABEL + "=" + marker,
                "--read-only",
                "--cap-drop=ALL",
                "--security-opt=no-new-privileges",
                *arguments,
            )
            # Probe failures are JSON results; retain only the container's public stdout.
            try:
                return self.docker.run(
                    "container", "start", "--attach", name, timeout=60
                )
            except nodecheck.NodeError:
                rows = self.docker.json("container", "inspect", name)
                if (
                    len(rows) != 1
                    or rows[0].get("State", {}).get("Running")
                    or (
                        not allow_failed
                        and rows[0].get("State", {}).get("ExitCode") != 0
                    )
                ):
                    raise nodecheck.NodeError("fixture_container_failed") from None
                return self.docker.run("container", "logs", name)
        finally:
            nodecheck.cleanup_container(self.docker, name, marker, self.gateway)

    def directory_helper(self, basename, operation):
        # Mount the daemon's /var/lib but touch only our exact freshly generated child.
        script = (
            "from pathlib import Path\nroot=Path('/fixture-root').resolve()\n"
            f"path=root/{basename!r}\n"
            "assert path.resolve().parent==root\n" + operation
        )
        self.container(
            [
                "--mount",
                "type=bind,source=/var/lib,target=/fixture-root",
                "--entrypoint",
                "python",
                self.gateway,
                "-c",
                script,
            ]
        )

    def probe(self, state, engine, version, port=None, container_probe=True):
        reference, _ = self.workers[engine]
        network = (
            ["--network", "host"]
            if port is None
            else ["--publish", f"127.0.0.1:{port}:{port}"]
        )
        arguments = [
            *network,
            "--mount",
            f"type=bind,source={state},target={state}",
            "--mount",
            "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock",
            "--mount",
            f"type=bind,source={ROOT / 'deploy/aliyun/check-work-node.py'},target=/node-check.py,readonly",
            "--entrypoint",
            "python",
            self.gateway,
            "/node-check.py",
            "--docker-context",
            "default",
            "--expected-node",
            self.daemon,
            "--state-directory",
            state,
            "--worker-image",
            reference,
            "--engine",
            engine,
            "--runtime-version",
            version,
        ]
        if container_probe:
            arguments.append("--probe-container")
        if port is not None:
            arguments.extend(["--probe-port", str(port)])
        result = json.loads(self.container(arguments, allow_failed=True))
        self.assertEqual(result["schema"], "work-node-check/v1")
        self.assertEqual(result["engine"], engine)
        self.assertEqual(result["model_calls"], 0)
        self.assertFalse(result["deployment_performed"])
        return result

    @staticmethod
    def free_loopback_port():
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            return reservation.getsockname()[1]

    def exercise(self, engine):
        reference, version = self.workers[engine]
        basename = "we-meet-node-acceptance-" + uuid.uuid4().hex
        state = "/var/lib/" + basename
        try:
            self.directory_helper(
                basename,
                "assert not path.exists(); path.mkdir(mode=0o700); "
                f"(path/'existing-inbox').write_text({basename!r})",
            )
            readonly = self.probe(state, engine, version, container_probe=False)
            self.assertTrue(readonly["passed"])
            self.assertEqual(readonly["worker_image_id"], self.image_id(reference))
            native = self.probe(state, engine, version)
            if self.desktop:
                # Desktop behavior is reported separately, never a Linux readiness assertion.
                self.assertTrue(
                    native["passed"]
                    or native.get("code") == "probe_failed_broker_route"
                )
            else:
                self.assertTrue(
                    native["passed"], "native Linux host-network probe failed"
                )
            port = self.free_loopback_port() if self.desktop else None
            positive = (
                self.probe(state, engine, version, port) if self.desktop else native
            )
            self.assertTrue(positive["passed"])
            self.assertEqual(positive["probe"]["runtime_version"], version)
            for key in (
                "mount_round_trip",
                "broker_route",
                "unauthorized_denied",
                "provider_credentials_absent",
                "read_only_root",
            ):
                self.assertTrue(positive["probe"][key])
            negative = self.probe(state, engine, "0.0.0-invalid-fixture", port)
            self.assertFalse(negative["passed"])
            self.assertEqual(negative["code"], "probe_failed_runtime")
        finally:
            # No recursive delete: unexpected leftover files make acceptance fail for review.
            self.directory_helper(
                basename,
                "if path.exists():\n"
                "    assert sorted(p.name for p in path.iterdir())==['existing-inbox']\n"
                f"    assert (path/'existing-inbox').read_text()=={basename!r}\n"
                "    (path/'existing-inbox').unlink()\n"
                "    path.rmdir()",
            )
        receipt = {
            "schema": "work-node-docker-acceptance/v1",
            "scope": "desktop-published-port-fixture"
            if self.desktop
            else "native-linux-host-network-fixture",
            "fixture_acceptance_passed": True,
            "native_linux_runtime_probe_verified": not self.desktop,
            "model_calls": 0,
            "deployment_performed": False,
            "fixture_state_removed": True,
            "readonly": readonly,
            "host_network": native,
            "positive": positive,
            "runtime_mismatch": negative,
        }
        report_directory = os.environ.get("WORK_NODE_TEST_REPORT_DIRECTORY")
        if report_directory:
            directory = Path(report_directory)
            directory.mkdir(parents=True, exist_ok=True)
            report_path = directory / f"{engine}-{uuid.uuid4().hex}.json"
            descriptor = os.open(
                report_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
            )
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(receipt, stream, indent=2)

    def test_real_pi_mount_route_isolation_runtime_failure_and_cleanup(self):
        self.exercise("pi")

    def test_real_dsh_mount_route_isolation_runtime_failure_and_cleanup(self):
        self.exercise("dsh")


class DockerFixtureBoundaryTests(unittest.TestCase):
    def test_wrong_host_mutable_images_and_missing_configuration_prevent_mutation(self):
        digest = "fixture.invalid/runtime@sha256:" + "a" * 64
        environment = {
            "WORK_NODE_TEST_CONTEXT": "fixture",
            "WORK_NODE_TEST_DAEMON": "fixture-daemon",
            "WORK_NODE_TEST_GATEWAY_IMAGE": digest,
            "WORK_NODE_TEST_PI_IMAGE": digest,
            "WORK_NODE_TEST_DSH_IMAGE": digest,
            "WORK_NODE_TEST_PI_VERSION": "1.0.4",
            "WORK_NODE_TEST_DSH_VERSION": "0.1.5rc1",
        }
        cases = (
            (
                {},
                "unix:///var/run/docker.sock",
                "fixture-daemon",
                "explicit_fixture_configuration_required",
            ),
            (
                environment,
                "ssh://business-node",
                "fixture-daemon",
                "local_fixture_docker_socket_required",
            ),
            (
                environment,
                "unix:///var/run/docker.sock",
                "business-node",
                "fixture_daemon_mismatch",
            ),
            (
                {
                    **environment,
                    "WORK_NODE_TEST_GATEWAY_IMAGE": "fixture.invalid/runtime:latest",
                },
                "unix:///var/run/docker.sock",
                "fixture-daemon",
                "immutable_fixture_image_required",
            ),
        )
        for values, endpoint, daemon, code in cases:
            with self.subTest(code=code):
                docker = Mock(context="fixture")
                docker.json.side_effect = [
                    [{"Endpoints": {"docker": {"Host": endpoint}}}],
                    {"Name": daemon, "OSType": "linux"},
                ]
                with (
                    patch.dict(os.environ, values, clear=True),
                    patch.object(nodecheck, "Docker", return_value=docker),
                ):
                    with self.assertRaisesRegex(nodecheck.NodeError, "^" + code + "$"):
                        RealNodeDockerTests.setUpClass()
                docker.run.assert_not_called()

    def test_helper_failure_is_not_accepted_as_success_and_still_attempts_owned_cleanup(
        self,
    ):
        docker = Mock()
        docker.run.side_effect = [b"", nodecheck.NodeError("docker_command_failed")]
        docker.json.return_value = [{"State": {"Running": False, "ExitCode": 2}}]
        gateway = "sha256:" + "b" * 64
        with (
            patch.object(RealNodeDockerTests, "docker", docker, create=True),
            patch.object(RealNodeDockerTests, "gateway", gateway, create=True),
            patch.object(nodecheck, "cleanup_container") as cleanup,
        ):
            with self.assertRaisesRegex(
                nodecheck.NodeError, "^fixture_container_failed$"
            ):
                RealNodeDockerTests().container(["--entrypoint", "python", gateway])
            cleanup.assert_called_once()
            self.assertIs(cleanup.call_args.args[0], docker)
            self.assertEqual(cleanup.call_args.args[-1], gateway)
            self.assertTrue(
                cleanup.call_args.args[1].startswith("work-node-acceptance-")
            )
            self.assertFalse(
                any(
                    call.args[:2] == ("container", "logs")
                    for call in docker.run.call_args_list
                )
            )


if __name__ == "__main__":
    unittest.main()
