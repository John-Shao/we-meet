"""Bounded serial worker; per-job container has no business credentials or DB."""

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from .contract import MAX_RESULT_BYTES, canonical, digest, validate_result
from .process import kill_tree, spawn_options


class Worker:
    def __init__(self, config, store, broker=None):
        self.config = config
        self.store = store
        self.broker = broker
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.loop, daemon=True)
        self.owner_label = "we-meet-work-owner=" + digest(str(config.root).encode())

    def start(self):
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
