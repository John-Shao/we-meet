"""Local Linux Docker node check; --probe-container adds one synthetic owned probe."""

import argparse
import hmac
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SECRET_ENV = {
    "DEEPSEEK_API_KEY",
    "DASHSCOPE_API_KEY",
    "WORK_AGENT_TOKEN",
    "WORK_AGENT_MODEL_TOKEN",
}
LABEL = "we-meet.node-probe"
IMAGE_ID = re.compile(r"sha256:[a-f0-9]{64}")

WORKER_PROBE = r"""
import importlib.metadata,json,os,pathlib,subprocess,sys,urllib.error,urllib.request
request=None
stage='mount'
try:
    request=json.loads(pathlib.Path('/job/request.json').read_text())
    stage='runtime'
    assert not any(os.environ.get(key) for key in request['secret_env'])
    assert sys.version_info[:2] == (3,13)
    if request['engine']=='pi':
        cli=pathlib.Path('/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js')
        assert cli.is_file()
        version=json.loads((cli.parents[2]/'package.json').read_text())['version']
        subprocess.run(['node','--version'],capture_output=True,timeout=5,check=True)
    else:
        version=importlib.metadata.version('deepseek-harness-sdk')
        assert importlib.metadata.version('deepseek-harness-runtime-bin')==version
    assert version==request['runtime_version']
    stage='broker_route'
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        opener.open(request['endpoint'],timeout=5)
        raise RuntimeError('unauthorized probe accepted')
    except urllib.error.HTTPError as error:
        assert error.code==401
    authorized=urllib.request.Request(request['endpoint'],headers={'Authorization':'Bearer '+request['token']})
    with opener.open(authorized,timeout=5) as response:
        assert response.status==200
        assert response.read(4096).decode()==request['marker']
    stage='isolation'
    root=pathlib.Path('/node-probe-'+request['marker'])
    try:
        root.write_text('synthetic')
        root.unlink()
        raise RuntimeError('root filesystem writable')
    except OSError:
        pass
    stage='result'
    pathlib.Path('/job/result.json').write_text(json.dumps({'marker':request['marker'],'runtime_version':version,'mount_round_trip':True,'broker_route':True,'unauthorized_denied':True,'provider_credentials_absent':True,'read_only_root':True}))
except Exception:
    if request:
        try:
            pathlib.Path('/job/result.json').write_text(json.dumps({'marker':request['marker'],'error_step':stage}))
        except Exception:
            pass
    sys.exit(1)
"""


class NodeError(ValueError):
    """Public error code, never raw Docker output."""


class Docker:
    def __init__(self, context):
        if (
            not context
            or context.startswith("-")
            or len(context) > 128
            or any(ord(c) < 32 for c in context)
        ):
            raise NodeError("invalid_docker_context")
        self.context = context

    def run(self, *args, timeout=15):
        try:
            result = subprocess.run(
                ["docker", "--context=" + self.context, *args],
                capture_output=True,
                timeout=timeout,
                check=False,
            )
            if result.returncode or len(result.stdout) > 2_000_000:
                raise NodeError("docker_command_failed")
            return result.stdout
        except (OSError, subprocess.TimeoutExpired):
            raise NodeError("docker_command_failed") from None

    def json(self, *args):
        try:
            return json.loads(self.run(*args))
        except (TypeError, ValueError):
            raise NodeError("docker_response_invalid") from None


def validate_node(docker, expected_node, worker_image):
    if sys.platform != "linux":
        raise NodeError("local_linux_node_required")
    if not re.fullmatch(r"[^\s@]+@sha256:[a-f0-9]{64}", worker_image):
        raise NodeError("immutable_worker_image_required")
    contexts = docker.json("context", "inspect", docker.context)
    if (
        len(contexts) != 1
        or contexts[0].get("Endpoints", {}).get("docker", {}).get("Host")
        != "unix:///var/run/docker.sock"
    ):
        raise NodeError("local_docker_socket_required")
    info = docker.json("info", "--format", "{{json .}}")
    if info.get("OSType") != "linux" or info.get("Name") != expected_node:
        raise NodeError("docker_node_mismatch")
    images = docker.json("image", "inspect", worker_image)
    if len(images) != 1:
        raise NodeError("worker_image_unavailable")
    image = images[0]
    if not IMAGE_ID.fullmatch(image.get("Id", "")) or worker_image not in (
        image.get("RepoDigests") or []
    ):
        raise NodeError("worker_image_digest_mismatch")
    if image.get("Os") != "linux" or image.get("Architecture") != info.get(
        "Architecture"
    ):
        aliases = {"x86_64": "amd64", "aarch64": "arm64"}
        if image.get("Os") != "linux" or image.get("Architecture") != aliases.get(
            info.get("Architecture")
        ):
            raise NodeError("worker_image_platform_mismatch")
    if any(
        item.partition("=")[0] in SECRET_ENV and item.partition("=")[2]
        for item in image.get("Config", {}).get("Env", [])
    ):
        raise NodeError("provider_credential_in_worker_image")
    return image["Id"]


def state_directory(path):
    path = Path(path)
    if (
        not re.fullmatch(r"/var/lib/[A-Za-z0-9_-]+", path.as_posix())
        or path.is_symlink()
        or path.resolve() != path
        or not path.is_dir()
    ):
        raise NodeError("existing_dedicated_state_directory_required")
    if path.stat().st_mode & stat.S_IWOTH:
        raise NodeError("state_directory_world_writable")
    if not os.access(path, os.R_OK | os.W_OK | os.X_OK):
        raise NodeError("state_directory_not_accessible")
    return path


def cleanup_container(docker, name, marker, image_id):
    try:
        rows = docker.json("container", "inspect", name)
    except NodeError:
        # Absence is verified separately; a daemon outage is not successful cleanup.
        rows = docker.run(
            "container",
            "ls",
            "--all",
            "--filter",
            "name=^/" + name + "$",
            "--format",
            "{{.ID}}",
        )
        if not rows.strip():
            return
        raise NodeError("probe_cleanup_unconfirmed")
    if (
        len(rows) != 1
        or rows[0].get("Config", {}).get("Labels", {}).get(LABEL) != marker
        or rows[0].get("Image") != image_id
    ):
        raise NodeError("probe_cleanup_identity_mismatch")
    identifier = rows[0].get("Id", "")
    if not re.fullmatch(r"[a-f0-9]{64}", identifier):
        raise NodeError("probe_cleanup_identity_mismatch")
    docker.run("container", "rm", "--force", identifier)


def container_probe(docker, state, image_id, engine, runtime_version, port=0):
    marker = uuid.uuid4().hex
    name = "work-node-probe-" + marker
    probe = state / ("_node-probe-" + marker)
    probe_root = probe.resolve()
    if not probe_root.is_relative_to(state.resolve()):
        raise NodeError("invalid_probe_directory")
    probe.mkdir(mode=0o700, exist_ok=False)
    token = secrets.token_urlsafe(32)
    visits = {"authorized": 0, "denied": 0}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            if self.path != "/probe/" + marker:
                self.send_response(404)
                self.end_headers()
                return
            if not hmac.compare_digest(
                self.headers.get("Authorization", "").encode(),
                ("Bearer " + token).encode(),
            ):
                visits["denied"] += 1
                self.send_response(401)
                self.end_headers()
                return
            visits["authorized"] += 1
            self.send_response(200)
            self.end_headers()
            self.wfile.write(marker.encode())

    server = thread = None
    created = False
    try:
        server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        request = {
            "endpoint": f"http://host.docker.internal:{server.server_port}/probe/{marker}",
            "token": token,
            "marker": marker,
            "engine": engine,
            "runtime_version": runtime_version,
            "secret_env": sorted(SECRET_ENV),
        }
        (probe / "request.json").write_text(json.dumps(request), encoding="utf-8")
        # Frozen image ID, same mount and isolation flags as the production worker.
        created = (
            True  # Even a lost create ACK must attempt an identity-fenced cleanup.
        )
        docker.run(
            "container",
            "create",
            "--pull=never",
            "--name",
            name,
            "--label",
            LABEL + "=" + marker,
            "--init",
            "--add-host",
            "host.docker.internal:host-gateway",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--pids-limit=128",
            "--memory=1g",
            "--cpus=1",
            "--tmpfs",
            "/tmp:rw,size=128m",
            "--mount",
            f"type=bind,source={probe},target=/job",
            "--entrypoint",
            "python",
            image_id,
            "-c",
            WORKER_PROBE,
        )
        start_error = None
        try:
            docker.run("container", "start", "--attach", name, timeout=30)
        except NodeError as error:
            start_error = error
        result_path = probe / "result.json"
        if (
            probe.resolve() != probe_root
            or result_path.is_symlink()
            or not result_path.is_file()
            or result_path.stat().st_size > 8192
        ):
            raise NodeError("probe_mount_round_trip_failed")
        result = json.loads(result_path.read_text("utf-8"))
        if result.get("marker") == marker and result.get("error_step") in {
            "mount",
            "runtime",
            "broker_route",
            "isolation",
            "result",
        }:
            raise NodeError("probe_failed_" + result["error_step"])
        if start_error:
            raise start_error
        if (
            result.get("marker") != marker
            or result.get("runtime_version") != runtime_version
            or any(
                result.get(key) is not True
                for key in (
                    "mount_round_trip",
                    "broker_route",
                    "unauthorized_denied",
                    "provider_credentials_absent",
                    "read_only_root",
                )
            )
            or visits != {"authorized": 1, "denied": 1}
        ):
            raise NodeError("probe_result_invalid")
        return {key: value for key, value in result.items() if key != "marker"}
    finally:
        cleanup_error = None
        if created:
            try:
                cleanup_container(docker, name, marker, image_id)
            except NodeError as error:
                cleanup_error = error
        if server:
            server.shutdown()
            server.server_close()
        if thread:
            thread.join(timeout=5)
        if probe.resolve() != probe_root:
            raise NodeError("probe_cleanup_path_mismatch")
        for filename in ("request.json", "result.json"):
            path = probe / filename
            if not path.resolve().is_relative_to(probe_root):
                raise NodeError("probe_cleanup_path_mismatch")
            path.unlink(missing_ok=True)
        probe.rmdir()
        if cleanup_error:
            raise cleanup_error


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--docker-context", required=True)
    parser.add_argument(
        "--expected-node",
        required=True,
        help="Expected Docker daemon Name on the dedicated node",
    )
    parser.add_argument("--state-directory", type=Path, required=True)
    parser.add_argument(
        "--worker-image",
        required=True,
        help="Already pulled repo@sha256 reference; never pulls automatically",
    )
    parser.add_argument("--engine", choices=("pi", "dsh"), default="pi")
    parser.add_argument("--runtime-version", required=True)
    parser.add_argument("--probe-container", action="store_true")
    parser.add_argument(
        "--probe-port",
        type=int,
        default=0,
        help="Optional fixed synthetic broker port for a fixture relay",
    )
    parser.add_argument("--report", type=Path)
    args = parser.parse_args(argv)
    report = {
        "schema": "work-node-check/v1",
        "scope": "local-linux-docker-runtime",
        "passed": False,
        "node": args.expected_node,
        "docker_context": args.docker_context,
        "engine": args.engine,
        "probe_requested": args.probe_container,
        "model_calls": 0,
        "deployment_performed": False,
        "not_checked": [
            "dedicated Kubernetes scheduling and workloads",
            "state backup and host firewall",
            "provider access and deployed gateway HTTPS",
        ],
    }
    try:
        if (
            not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,126}", args.expected_node)
            or not re.fullmatch(r"[0-9][A-Za-z0-9.+_-]{0,62}", args.runtime_version)
            or not 0 <= args.probe_port <= 65535
        ):
            raise NodeError("invalid_node_check_arguments")
        docker = Docker(args.docker_context)
        image_id = validate_node(docker, args.expected_node, args.worker_image)
        state = state_directory(args.state_directory)
        report["worker_image_id"] = image_id
        if args.probe_container:
            report["probe"] = container_probe(
                docker,
                state,
                image_id,
                args.engine,
                args.runtime_version,
                args.probe_port,
            )
        else:
            report["not_checked"].append(
                "container runtime version, mount round-trip and ModelBroker route"
            )
        report["passed"] = True
    except NodeError as error:
        report["code"] = str(error)
    except Exception:
        report["code"] = "node_check_failed"
    encoded = json.dumps(report, indent=2) + "\n"
    if args.report:
        try:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            descriptor = os.open(
                args.report, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
            )
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
                stream.write(encoded)
        except OSError:
            report["passed"] = False
            report["code"] = "report_write_failed"
            encoded = json.dumps(report, indent=2) + "\n"
    print(encoded, end="")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
