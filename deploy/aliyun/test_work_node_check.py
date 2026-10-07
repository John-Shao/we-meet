"""Node/image boundaries, owned cleanup and a synthetic HTTP probe; no models."""

import copy
import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
import urllib.error
import urllib.request
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "nodecheck", Path(__file__).with_name("check-work-node.py")
)
nodecheck = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nodecheck)
IMAGE = "fixture.invalid/pi@sha256:" + "a" * 64
ID = "sha256:" + "b" * 64
CONTAINER = "c" * 64


class DockerFixture:
    context = "default"

    def __init__(self):
        self.calls = []
        self.endpoint = "unix:///var/run/docker.sock"
        self.info = {
            "Name": "dedicated-node",
            "OSType": "linux",
            "Architecture": "x86_64",
        }
        self.image = {
            "Id": ID,
            "RepoDigests": [IMAGE],
            "Os": "linux",
            "Architecture": "amd64",
            "Config": {"Env": []},
        }
        self.row = None
        self.lose_ack = False
        self.fail_start = False
        self.request_path = None
        self.probe_version = "1.0.4"
        self.error_step = None

    def json(self, *args):
        if args[:2] == ("context", "inspect"):
            return [{"Endpoints": {"docker": {"Host": self.endpoint}}}]
        if args[0] == "info":
            return self.info
        if args[:2] == ("image", "inspect"):
            return [self.image]
        if args[:2] == ("container", "inspect"):
            if self.row:
                return [self.row]
            raise nodecheck.NodeError("docker_command_failed")
        raise AssertionError(args)

    def run(self, *args, timeout=15):
        self.calls.append(args)
        if args[:2] == ("container", "create"):
            label = args[args.index("--label") + 1].split("=", 1)[1]
            self.row = {
                "Id": CONTAINER,
                "Image": ID,
                "Config": {"Labels": {nodecheck.LABEL: label}},
            }
            mount = args[args.index("--mount") + 1]
            self.request_path = (
                Path(mount.split("source=", 1)[1].split(",target=", 1)[0])
                / "request.json"
            )
            if self.lose_ack:
                raise nodecheck.NodeError("docker_command_failed")
        elif args[:2] == ("container", "start"):
            if self.fail_start:
                raise nodecheck.NodeError("docker_command_failed")
            request = json.loads(self.request_path.read_text())
            if self.error_step:
                self.request_path.with_name("result.json").write_text(
                    json.dumps(
                        {"marker": request["marker"], "error_step": self.error_step}
                    )
                )
                raise nodecheck.NodeError("docker_command_failed")
            # Unit fixture checks the HTTP/auth protocol; real Docker proves the host alias separately.
            endpoint = request["endpoint"].replace("host.docker.internal", "127.0.0.1")
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            try:
                opener.open(endpoint, timeout=2)
                raise AssertionError("Anonymous probe succeeded")
            except urllib.error.HTTPError as error:
                assert error.code == 401
            call = urllib.request.Request(
                endpoint, headers={"Authorization": "Bearer " + request["token"]}
            )
            with opener.open(call, timeout=2) as response:
                assert response.read().decode() == request["marker"]
            result = {
                "marker": request["marker"],
                "runtime_version": self.probe_version,
                "mount_round_trip": True,
                "broker_route": True,
                "unauthorized_denied": True,
                "provider_credentials_absent": True,
                "read_only_root": True,
            }
            self.request_path.with_name("result.json").write_text(json.dumps(result))
        elif args[:2] == ("container", "rm"):
            self.row = None
        elif args[:2] == ("container", "ls"):
            return b"" if not self.row else CONTAINER.encode()
        return b""


class NodeCheckTests(unittest.TestCase):
    def test_local_socket_daemon_image_digest_architecture_and_credentials(self):
        docker = DockerFixture()
        with patch.object(nodecheck.sys, "platform", "linux"):
            self.assertEqual(
                ID, nodecheck.validate_node(docker, "dedicated-node", IMAGE)
            )
            for mutate in (
                lambda d: setattr(d, "endpoint", "ssh://wrong-node"),
                lambda d: d.info.update(Name="business-node"),
                lambda d: d.image.update(RepoDigests=[]),
                lambda d: d.image.update(Architecture="arm64"),
                lambda d: d.image["Config"].update(
                    Env=["DASHSCOPE_API_KEY=sk-canary-never-print-123456"]
                ),
            ):
                bad = DockerFixture()
                mutate(bad)
                with self.assertRaises(nodecheck.NodeError):
                    nodecheck.validate_node(bad, "dedicated-node", IMAGE)
            with self.assertRaises(nodecheck.NodeError):
                nodecheck.validate_node(
                    docker, "dedicated-node", "fixture.invalid/pi:latest"
                )
        with patch.object(nodecheck.sys, "platform", "win32"):
            with self.assertRaisesRegex(
                nodecheck.NodeError, "local_linux_node_required"
            ):
                nodecheck.validate_node(docker, "dedicated-node", IMAGE)

    def test_probe_binds_only_owned_directory_and_removes_own_container_and_files(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory).resolve()
            sentinel = state / "existing-inbox"
            sentinel.write_text("keep")
            docker = DockerFixture()
            result = nodecheck.container_probe(docker, state, ID, "pi", "1.0.4")
            self.assertTrue(result["broker_route"])
            self.assertNotIn("marker", result)
            self.assertEqual([sentinel], list(state.iterdir()))
            self.assertEqual("keep", sentinel.read_text())
            self.assertIsNone(docker.row)
            create = next(
                args for args in docker.calls if args[:2] == ("container", "create")
            )
            self.assertIn("host.docker.internal:host-gateway", create)
            self.assertIn("--read-only", create)
            self.assertIn("--pull=never", create)
            self.assertIn(ID, create)
            self.assertFalse(any(arg == "-e" for arg in create))
            self.assertIn(("container", "rm", "--force", CONTAINER), docker.calls)

    def test_lost_create_ack_and_start_failure_still_clean_owned_resources(self):
        for mode in ("lose_ack", "fail_start"):
            with tempfile.TemporaryDirectory() as directory:
                state = Path(directory).resolve()
                docker = DockerFixture()
                setattr(docker, mode, True)
                with self.assertRaises(nodecheck.NodeError):
                    nodecheck.container_probe(docker, state, ID, "pi", "1.0.4")
                self.assertIsNone(docker.row)
                self.assertEqual([], list(state.iterdir()))
                self.assertIn(("container", "rm", "--force", CONTAINER), docker.calls)

    def test_wrong_owner_or_image_is_never_removed(self):
        docker = DockerFixture()
        original = {
            "Id": CONTAINER,
            "Image": ID,
            "Config": {"Labels": {nodecheck.LABEL: "owned"}},
        }
        for mutate in (
            lambda r: r.update(Image="sha256:" + "d" * 64),
            lambda r: r["Config"]["Labels"].update({nodecheck.LABEL: "other"}),
        ):
            row = copy.deepcopy(original)
            mutate(row)
            docker.row = row
            with self.assertRaisesRegex(
                nodecheck.NodeError, "cleanup_identity_mismatch"
            ):
                nodecheck.cleanup_container(
                    docker, "work-node-probe-owned", "owned", ID
                )
        self.assertFalse(any(args[:2] == ("container", "rm") for args in docker.calls))
        docker.row = None
        nodecheck.cleanup_container(docker, "work-node-probe-owned", "owned", ID)

    def test_runtime_mismatch_rejects_result_and_cleans_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            docker = DockerFixture()
            docker.probe_version = "wrong-version"
            with self.assertRaisesRegex(nodecheck.NodeError, "probe_result_invalid"):
                nodecheck.container_probe(
                    docker, Path(directory).resolve(), ID, "pi", "1.0.4"
                )
            self.assertEqual([], list(Path(directory).iterdir()))
            self.assertIsNone(docker.row)

    def test_worker_failure_stage_is_allowlisted_and_cleanup_survives_failed_start(
        self,
    ):
        for stage, code in (
            ("runtime", "probe_failed_runtime"),
            ("broker_route", "probe_failed_broker_route"),
            ("isolation", "probe_failed_isolation"),
            ("sk-canary-never-print-123456", "docker_command_failed"),
        ):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as directory:
                docker = DockerFixture()
                docker.error_step = stage
                with self.assertRaisesRegex(nodecheck.NodeError, "^" + code + "$"):
                    nodecheck.container_probe(
                        docker, Path(directory).resolve(), ID, "pi", "1.0.4"
                    )
                self.assertEqual([], list(Path(directory).iterdir()))
                self.assertIsNone(docker.row)

    def test_directory_requires_existing_dedicated_path_without_world_write(self):
        with (
            patch.object(nodecheck.Path, "is_symlink", return_value=False),
            patch.object(nodecheck.Path, "is_dir", return_value=True),
            patch.object(nodecheck.Path, "resolve", lambda path: path),
            patch.object(
                nodecheck.Path,
                "stat",
                return_value=type("Info", (), {"st_mode": 0o700})(),
            ),
            patch.object(nodecheck.os, "access", return_value=True),
        ):
            self.assertEqual(
                Path("/var/lib/work-review"),
                nodecheck.state_directory("/var/lib/work-review"),
            )
            for value in ("/", "/var/lib", "/var/lib/work/../data", "/tmp/work"):
                with self.assertRaises(nodecheck.NodeError):
                    nodecheck.state_directory(value)
            with patch.object(nodecheck.Path, "is_symlink", return_value=True):
                with self.assertRaises(nodecheck.NodeError):
                    nodecheck.state_directory("/var/lib/work-review")
            with patch.object(
                nodecheck.Path,
                "stat",
                return_value=type("Info", (), {"st_mode": 0o777})(),
            ):
                with self.assertRaises(nodecheck.NodeError):
                    nodecheck.state_directory("/var/lib/work-review")

    def test_cli_defaults_to_read_only_redacts_diagnostics_and_never_overwrites_report(
        self,
    ):
        args = [
            "--docker-context",
            "default",
            "--expected-node",
            "dedicated-node",
            "--state-directory",
            "/var/lib/work-review",
            "--worker-image",
            IMAGE,
            "--runtime-version",
            "1.0.4",
        ]
        with (
            patch.object(nodecheck, "validate_node", return_value=ID),
            patch.object(
                nodecheck, "state_directory", return_value=Path("/var/lib/work-review")
            ),
            patch.object(nodecheck, "container_probe") as probe,
            redirect_stdout(io.StringIO()) as output,
        ):
            self.assertEqual(0, nodecheck.main(args))
            self.assertTrue(json.loads(output.getvalue())["passed"])
            probe.assert_not_called()
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "report.json"
            report.write_text("keep")
            with (
                patch.object(
                    nodecheck,
                    "validate_node",
                    side_effect=RuntimeError("sk-canary-never-print-123456"),
                ),
                redirect_stdout(io.StringIO()) as output,
            ):
                self.assertEqual(1, nodecheck.main(args + ["--report", str(report)]))
                self.assertNotIn("sk-canary", output.getvalue())
            self.assertEqual("keep", report.read_text())

    def test_docker_diagnostics_do_not_leave_public_error_channel(self):
        docker = nodecheck.Docker("default")
        with patch.object(
            nodecheck.subprocess,
            "run",
            return_value=subprocess.CompletedProcess([], 1, b"", b"sk-private-canary"),
        ):
            with self.assertRaisesRegex(nodecheck.NodeError, "^docker_command_failed$"):
                docker.run("info")


if __name__ == "__main__":
    unittest.main()
