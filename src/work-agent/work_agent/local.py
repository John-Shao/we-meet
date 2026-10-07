"""Versioned stdio adapter for desktop-owned native dsh workspaces.

Only Electron's trusted main process talks to this service. It has no TCP job
API and receives folder grants from the native picker, never from web content.
"""

import argparse
import importlib.metadata
import json
import os
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from types import SimpleNamespace

from . import ADAPTER_VERSION, DSH_VERSION
from .approvals import ApprovalGate
from .contract import (
    DEFAULT_LIMITS,
    ContractError,
    canonical,
    validate_request,
    validate_result,
)
from .model_broker import ModelBroker
from .process import kill_tree, spawn_options
from .store import Store

CONTRACT = "work-local/v1"


class LocalService:
    def __init__(self, root, model="deepseek-flash", *, fixture=False):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.owner_lock = open(self.root / "local.lock", "a+b")
        self.owner_lock.seek(0)
        self.owner_lock.write(b"0")
        self.owner_lock.flush()
        self.owner_lock.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self.owner_lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.owner_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.owner_lock.close()
            raise RuntimeError("local_state_in_use") from None
        self.store = Store(self.root / "local.sqlite3")
        self.store.db.execute(
            "CREATE TABLE IF NOT EXISTS workspaces "
            "(id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL)"
        )
        self.store.db.commit()
        self.model, self.fixture = model, fixture
        self.approvals = ApprovalGate(self.store)
        self.grants = {}
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.active = None
        self.broker = (
            None
            if fixture
            else ModelBroker(
                SimpleNamespace(model=model, base_url="https://api.deepseek.com"),
                self.store,
                bind_host="127.0.0.1",
                approval_gate=self.approvals,
            )
        )
        self.store.recover()
        # A restart requires fresh native folder consent, including queued work.
        with self.store.lock:
            queued = self.store.db.execute(
                "SELECT id FROM jobs WHERE state='queued'"
            ).fetchall()
        for row in queued:
            self.store.finish(
                row["id"], "failed", error="workspace_permission_required"
            )
        if self.broker:
            self.broker.start()
        self.thread = threading.Thread(target=self.loop, daemon=True)
        self.thread.start()

    def capabilities(self):
        ready = self.fixture
        if not self.fixture:
            try:
                ready = bool(os.environ.get("DEEPSEEK_API_KEY")) and all(
                    importlib.metadata.version(package) == DSH_VERSION
                    for package in (
                        "deepseek-harness-sdk",
                        "deepseek-harness-runtime-bin",
                    )
                )
            except importlib.metadata.PackageNotFoundError:
                pass
        return {
            "contract": CONTRACT,
            "adapter_version": ADAPTER_VERSION,
            "engine": "fixture" if self.fixture else "dsh",
            "runtime_version": DSH_VERSION,
            "execution": "local",
            "model": self.model,
            "ready": ready,
            "limits": DEFAULT_LIMITS,
            "workspace_is_sandbox": False,
            "features": ["cloud_context", "run_limits", "command_approval"],
        }

    def grant(self, raw):
        directory = Path(raw).resolve(strict=True)
        if (
            not directory.is_dir()
            or directory == directory.anchor
            or directory.parent == directory
        ):
            raise ContractError("invalid_workspace")
        with self.lock, self.store.lock, self.store.db:
            row = self.store.db.execute(
                "SELECT id FROM workspaces WHERE path=?", (str(directory),)
            ).fetchone()
            identifier = row["id"] if row else str(uuid.uuid4())
            if row is None:
                self.store.db.execute(
                    "INSERT INTO workspaces VALUES (?,?)", (identifier, str(directory))
                )
            self.grants[identifier] = directory
        return {"id": identifier, "path": str(directory), "name": directory.name}

    def workspace(self, identifier):
        with self.lock:
            directory = self.grants.get(identifier)
        if not directory or not directory.is_dir() or directory.resolve() != directory:
            raise ContractError("workspace_permission_required")
        return directory

    def submit(self, body):
        if not self.capabilities()["ready"]:
            raise ContractError("local_runtime_unavailable")
        if set(body) - {"files", "limits"} != {"run_id", "workspace_id", "goal"}:
            raise ContractError("invalid_request")
        run_id = str(uuid.UUID(body["run_id"]))
        if (
            run_id != body["run_id"]
            or not isinstance(body["goal"], str)
            or not 1 <= len(body["goal"].strip()) <= 8000
        ):
            raise ContractError("invalid_request")
        workspace = self.workspace(body["workspace_id"])
        output = workspace / "WeMeet成果" / run_id / "output"
        files = body.get("files", [])
        limits = body.get("limits", DEFAULT_LIMITS)
        validate_request(
            {
                "contract": "work-agent/v1",
                "run_id": run_id,
                "goal": body["goal"],
                "files": files,
                "limits": limits,
                "timeout_seconds": 180,
            }
        )
        request = {
            **body,
            "workspace": str(workspace),
            "output": str(output),
            "local_workspace": True,
            "files": files,
            "timeout_seconds": 180,
            "limits": limits,
            "approval_required": True,
        }
        self.store.admit(request, self.capabilities())
        return self.get(run_id)

    def get(self, run_id):
        result = self.store.get(run_id)
        with self.store.lock:
            row = self.store.db.execute(
                "SELECT request FROM jobs WHERE id=?", (run_id,)
            ).fetchone()
        request = json.loads(row["request"])
        return {
            **result,
            "contract": CONTRACT,
            "workspace_id": request.get("workspace_id"),
            "goal": request.get("goal", ""),
            "workspace": request.get("workspace", ""),
            "approvals": self.approvals.pending(run_id),
        }

    def list(self):
        with self.store.lock:
            rows = self.store.db.execute(
                "SELECT id FROM jobs ORDER BY created DESC LIMIT 50"
            ).fetchall()
        # List responses contain no document bodies.
        return [
            {
                key: job[key]
                for key in (
                    "run_id",
                    "state",
                    "goal",
                    "workspace",
                    "workspace_id",
                    "error_code",
                )
            }
            for job in (self.get(row["id"]) for row in rows)
        ]

    def cancel(self, run_id):
        self.store.cancel(str(uuid.UUID(run_id)))
        return self.get(run_id)

    def review_approval(self, params):
        run_id = str(uuid.UUID(params["run_id"]))
        job = self.get(run_id)
        self.workspace(job["workspace_id"])
        self.approvals.decide(run_id, params["id"], params["sha256"], params["allow"])
        return self.get(run_id)

    def artifact_path(self, run_id, name):
        job = self.get(run_id)
        workspace = self.workspace(job["workspace_id"])
        if job["state"] != "succeeded" or not any(
            item["name"] == name for item in job["result"]["artifacts"]
        ):
            raise ContractError("artifact_not_ready")
        output = workspace / "WeMeet成果" / run_id / "output"
        target = output / name
        if (
            target.resolve(strict=True).parent != output
            or not target.is_file()
            or target.is_symlink()
            or target.stat().st_nlink != 1
            or target.stat().st_size > 400_000
        ):
            raise ContractError("artifact_changed")
        # Verify the snapshot before opening a user-editable file through the OS.
        from .contract import digest

        expected = next(
            item["sha256"]
            for item in job["result"]["artifacts"]
            if item["name"] == name
        )
        if digest(target.read_bytes()) != expected:
            raise ContractError("artifact_changed")
        return {"path": str(target)}

    def loop(self):
        while not self.stop.wait(0.1):
            request = self.store.claim()
            if request is None:
                continue
            try:
                self.execute(request)
            except Exception:
                denial = self.store.metering(request["run_id"])["denial_code"]
                self.store.finish(
                    request["run_id"],
                    "failed",
                    error=denial or "local_execution_failed",
                )

    def execute(self, request):
        run_id = request["run_id"]
        workspace = self.workspace(request["workspace_id"])
        if str(workspace) != request["workspace"]:
            raise ContractError("workspace_changed")
        parent = workspace / "WeMeet成果"
        if parent.exists() and (parent.is_symlink() or parent.resolve() != parent):
            raise ContractError("invalid_output_path")
        parent.mkdir(exist_ok=True)
        output = Path(request["output"])
        output.parent.mkdir(exist_ok=False)
        output.mkdir()
        directory = self.root / "jobs" / run_id
        directory.mkdir(parents=True, exist_ok=False)
        (directory / "request.json").write_bytes(canonical(request))
        env = {
            key: os.environ[key]
            for key in (
                "PATH",
                "SYSTEMROOT",
                "WINDIR",
                "TEMP",
                "TMP",
                "USERPROFILE",
                "APPDATA",
                "LOCALAPPDATA",
            )
            if key in os.environ
        }
        env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1])
        env["WORK_AGENT_MODEL"] = self.model
        process = None
        try:
            if self.fixture:
                text = (workspace / "input.txt").read_text("utf-8")
                if request["goal"] == "fixture:slow":
                    deadline = time.monotonic() + 30
                    while time.monotonic() < deadline:
                        if (
                            self.stop.wait(0.1)
                            or self.store.get(run_id)["state"] == "cancelled"
                        ):
                            return
                (output / "report.md").write_text("# Local fixture\n" + text, "utf-8")
                from .runner import collect_artifacts

                result = {
                    "summary": "Offline fixture",
                    "usage": None,
                    "elapsed_ms": 1,
                    "artifacts": collect_artifacts(output.parent),
                }
            else:
                token, _ = self.broker.issue(run_id)
                env["DEEPSEEK_API_KEY"] = token
                env["DEEPSEEK_BASE_URL"] = (
                    f"http://127.0.0.1:{self.broker.server.server_port}/model/{run_id}"
                )
                process = subprocess.Popen(
                    [
                        sys.executable,
                        "-B",
                        "-m",
                        "work_agent.local_runner",
                        str(directory),
                    ],
                    cwd=workspace,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    env=env,
                    **spawn_options(),
                )
                self.active = process
                deadline = time.monotonic() + request["timeout_seconds"]
                while process.poll() is None:
                    if (
                        self.stop.is_set()
                        or self.store.get(run_id)["state"] == "cancelled"
                        or time.monotonic()
                        >= deadline + self.approvals.paused_seconds(run_id)
                    ):
                        kill_tree(process)
                        self.store.finish(run_id, "failed", error="deadline_exceeded")
                        return
                    self.stop.wait(0.1)
                if process.returncode:
                    raise RuntimeError("agent_failed")
                path = directory / "result.json"
                if path.stat().st_size > 2000000:
                    raise RuntimeError("invalid_result")
                result = validate_result(json.loads(path.read_text("utf-8")))
            meter = self.store.metering(run_id)
            secret = os.environ.get("DEEPSEEK_API_KEY", "")
            if secret and secret in json.dumps(result):
                raise RuntimeError("invalid_result")
            result["usage"] = meter["usage"] if meter["complete"] else None
            self.store.finish(run_id, "succeeded", result=result)
        finally:
            if process:
                kill_tree(process)
            self.active = None
            if self.broker:
                self.broker.revoke(run_id)

    def close(self):
        self.stop.set()
        with self.store.lock:
            ids = [
                row["id"]
                for row in self.store.db.execute(
                    "SELECT id FROM jobs WHERE state IN ('queued','running')"
                ).fetchall()
            ]
        for identifier in ids:
            self.store.cancel(identifier)
        if self.active:
            kill_tree(self.active)
        self.thread.join(timeout=20)
        if self.thread.is_alive():
            raise RuntimeError("local_shutdown_incomplete")
        if self.broker:
            self.broker.close()
        self.store.close()
        self.owner_lock.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--model", default="deepseek-flash")
    args = parser.parse_args()
    service = LocalService(args.state_dir, args.model)
    try:
        for line in iter(lambda: sys.stdin.buffer.readline(512001), b""):
            identifier = None
            try:
                if len(line) > 512000 or not line.endswith(b"\n"):
                    break
                command = json.loads(line)
                identifier = command["id"]
                if command.get("contract") != CONTRACT:
                    raise ContractError("contract_mismatch")
                method, params = command["method"], command.get("params", {})
                if method == "capabilities":
                    value = service.capabilities()
                elif method == "grant":
                    value = service.grant(params["path"])
                elif method == "submit":
                    value = service.submit(params)
                elif method == "get":
                    value = service.get(str(uuid.UUID(params["run_id"])))
                elif method == "list":
                    value = service.list()
                elif method == "cancel":
                    value = service.cancel(params["run_id"])
                elif method == "artifact-path":
                    value = service.artifact_path(params["run_id"], params["name"])
                elif method == "review-approval":
                    value = service.review_approval(params)
                else:
                    raise ContractError("invalid_method")
                reply = {"contract": CONTRACT, "id": identifier, "result": value}
            except Exception as exc:
                reply = {
                    "contract": CONTRACT,
                    "id": identifier,
                    "error": exc.code
                    if isinstance(exc, ContractError)
                    else "local_request_failed",
                }
            sys.stdout.buffer.write(canonical(reply) + b"\n")
            sys.stdout.buffer.flush()
    finally:
        service.close()


if __name__ == "__main__":
    main()
