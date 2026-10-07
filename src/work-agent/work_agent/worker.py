"""Bounded serial worker; per-job container has no business credentials or DB."""

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from .contract import MAX_RESULT_BYTES, canonical, digest, validate_result
from .pod_transport import TaskTransport
from .process import kill_tree, spawn_options


class Worker:
    def __init__(self, config, store, broker=None, *, tasks=None, kubernetes_api=None):
        self.config = config
        self.store = store
        self.broker = broker
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.loop, daemon=True)
        self.owner_label = "we-meet-work-owner=" + digest(str(config.root).encode())
        self.tasks = tasks
        self.pods = None
        if config.execution == "kubernetes":
            from .kubernetes import PodExecutor

            self.tasks = tasks or TaskTransport(store)
            self.pods = PodExecutor(config, kubernetes_api)

    def start(self):
        if self.pods:
            self.pods.recover()
        if self.config.execution == "docker":
            # Also catches a container whose cancellation was recorded before
            # the previous gateway process died during cleanup.
            containers = (
                subprocess.check_output(
                    ["docker", "ps", "-aq", "--filter", "label=" + self.owner_label],
                    timeout=10,
                    stderr=subprocess.DEVNULL,
                )
                .decode()
                .split()
            )
            for container in containers:
                subprocess.run(
                    ["docker", "rm", "-f", container],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=10,
                    check=True,
                )
        self.store.recover()
        self.thread.start()

    def close(self):
        self.stop.set()
        self.thread.join(timeout=20)
        if self.thread.is_alive():
            raise RuntimeError("worker did not stop")

    def loop(self):
        while not self.stop.is_set():
            request = self.store.claim()
            if request is None:
                self.stop.wait(0.1)
                continue
            try:
                self.execute(request)
            except Exception:
                self.store.finish(
                    request["run_id"], "failed", error="execution_unknown"
                )

    def execute(self, request):
        if self.pods:
            return self.execute_kubernetes(request)
        config = self.config
        run_id = request["run_id"]
        deadline = time.monotonic() + request["timeout_seconds"]
        if self.store.get(run_id)["deployment"] != config.capabilities():
            self.store.finish(run_id, "failed", error="deployment_changed")
            return
        directory = (config.root / "jobs" / run_id).resolve()
        # An existing workspace could contain an earlier unknown execution.
        directory.mkdir(parents=True, exist_ok=False)
        (directory / "request.json").write_bytes(canonical(request))
        env = {
            key: os.environ[key]
            for key in ("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP")
            if key in os.environ
        }
        env.update(
            WORK_AGENT_ENGINE=config.engine,
            WORK_AGENT_MODEL=config.model,
            WORK_AGENT_PROVIDER=getattr(config, "provider", "deepseek"),
            DEEPSEEK_BASE_URL=config.base_url,
        )
        if config.execution == "docker":
            if config.engine == "fixture":
                env["DEEPSEEK_API_KEY"] = "offline-not-a-key"
            else:
                if self.broker is None:
                    raise RuntimeError("model broker required")
                token, endpoint = self.broker.issue(run_id)
                env["DEEPSEEK_API_KEY"] = token
                env["DEEPSEEK_BASE_URL"] = endpoint
            # Legacy names remain for dsh. Pi uses provider-neutral names; both
            # contain the same short-lived broker credential, never a supplier key.
            env["WORK_AGENT_MODEL_TOKEN"] = env["DEEPSEEK_API_KEY"]
            env["WORK_AGENT_MODEL_BASE_URL"] = env["DEEPSEEK_BASE_URL"]
            command = [
                "docker",
                "create",
                "--rm",
                "--name",
                "work-poc-" + run_id,
                "--label",
                self.owner_label,
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
                f"type=bind,source={directory},target=/job",
                "-e",
                "DEEPSEEK_API_KEY",
                "-e",
                "WORK_AGENT_ENGINE",
                "-e",
                "WORK_AGENT_MODEL",
                "-e",
                "WORK_AGENT_PROVIDER",
                "-e",
                "WORK_AGENT_MODEL_TOKEN",
                "-e",
                "WORK_AGENT_MODEL_BASE_URL",
                "-e",
                "DEEPSEEK_BASE_URL",
                config.image,
                "python",
                "-m",
                "work_agent.runner",
                "/job",
            ]
        else:
            env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1])
            command = [sys.executable, "-m", "work_agent.runner", str(directory)]
        process = None
        try:
            if config.execution == "docker":
                # Create before start avoids cancel-vs-Docker-run creation races.
                subprocess.run(
                    command,
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=min(request["timeout_seconds"], 15),
                    check=True,
                )
                command = ["docker", "start", "-a", "work-poc-" + run_id]
            if self.store.get(run_id)["state"] == "cancelled":
                return
            if time.monotonic() >= deadline:
                self.store.finish(run_id, "failed", error="deadline_exceeded")
                return
            process = subprocess.Popen(
                command,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                **spawn_options(),
            )
            while process.poll() is None:
                if self.store.get(run_id)["state"] == "cancelled":
                    return
                if self.stop.is_set():
                    self.store.finish(run_id, "failed", error="execution_unknown")
                    return
                if time.monotonic() >= deadline:
                    self.store.finish(run_id, "failed", error="deadline_exceeded")
                    return
                self.stop.wait(0.05)
            if process.returncode != 0:
                meter = self.store.metering(run_id)
                self.store.finish(
                    run_id, "failed", error=meter["denial_code"] or "agent_failed"
                )
                return
            path = directory / "result.json"
            if path.is_symlink() or path.stat().st_size > MAX_RESULT_BYTES:
                raise RuntimeError("invalid_result")
            content = path.read_text("utf-8")
            secret = env.get("DEEPSEEK_API_KEY", "")
            if secret and secret in content:
                raise RuntimeError("invalid_result")
            result = validate_result(json.loads(content))
            if self.broker:
                meter = self.store.metering(run_id)
                result["usage"] = meter["usage"] if meter["complete"] else None
            result["execution"] = config.capabilities()
            self.store.finish(run_id, "succeeded", result=result)
        finally:
            if self.broker:
                self.broker.revoke(run_id)
            if config.execution == "docker":
                # Killing the Docker client does NOT kill the container.
                subprocess.run(
                    ["docker", "rm", "-f", "work-poc-" + run_id],
                    env=env,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=10,
                )
            if process is not None:
                kill_tree(process)

    def execute_kubernetes(self, request):
        config = self.config
        run_id = request["run_id"]
        deadline = time.monotonic() + request["timeout_seconds"]
        if self.store.get(run_id)["deployment"] != config.capabilities():
            self.store.finish(run_id, "failed", error="deployment_changed")
            return
        directory = config.root / "jobs" / run_id
        directory.mkdir(parents=True, exist_ok=False)
        (directory / "request.json").write_bytes(canonical(request))
        token, endpoint = self.broker.issue(run_id)
        environment = {
            "WORK_AGENT_ENGINE": config.engine,
            "WORK_AGENT_MODEL": config.model,
            "WORK_AGENT_PROVIDER": config.provider,
            "WORK_AGENT_MODEL_TOKEN": token,
            "WORK_AGENT_MODEL_BASE_URL": endpoint,
            "DEEPSEEK_API_KEY": token,
            "DEEPSEEK_BASE_URL": endpoint,
        }
        uid = None
        task_token = None
        try:
            task_token = self.tasks.register(request, environment)
            uid = self.pods.create(request, task_token)
            self.tasks.assign(run_id, uid)
            while True:
                if self.store.get(run_id)["state"] == "cancelled":
                    return
                if self.stop.is_set():
                    self.store.finish(run_id, "failed", error="execution_unknown")
                    return
                if time.monotonic() >= deadline:
                    self.store.finish(run_id, "failed", error="deadline_exceeded")
                    return
                pod = self.pods.get(run_id)
                if (
                    not pod
                    or not self.pods.owned(pod, run_id)
                    or pod["metadata"]["uid"] != uid
                ):
                    raise RuntimeError("kubernetes_execution_unknown")
                phase = pod.get("status", {}).get("phase")
                if phase == "Failed":
                    meter = self.store.metering(run_id)
                    self.store.finish(
                        run_id, "failed", error=meter["denial_code"] or "agent_failed"
                    )
                    return
                if phase == "Succeeded":
                    result = self.tasks.result(run_id)
                    if result is None:
                        raise RuntimeError("kubernetes_result_missing")
                    meter = self.store.metering(run_id)
                    result["usage"] = meter["usage"] if meter["complete"] else None
                    result["execution"] = config.capabilities()
                    (directory / "result.json").write_bytes(canonical(result))
                    self.store.finish(run_id, "succeeded", result=result)
                    return
                self.stop.wait(0.2)
        finally:
            # Revoke first: a partitioned node cannot make new model calls.
            self.broker.revoke(run_id)
            self.tasks.revoke(run_id)
            if task_token:
                self.pods.delete(run_id, uid, digest(task_token.encode()))
