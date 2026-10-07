"""Kubernetes identity, single-claim transport and actual TLS/runner process tests."""

import copy
import importlib.util
import os
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from work_agent.config import Config
from work_agent.contract import ContractError, canonical, digest, validate_request
from work_agent.kubernetes import LEASE, OWNER, KubernetesError, PodExecutor
from work_agent.pod_transport import TaskTransport
from work_agent.server import Gateway
from work_agent.store import Store

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location(
    "delivery_tls_fixture", ROOT / "deploy/aliyun/test_work_agent_delivery.py"
)
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)


def configuration(root):
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    return Config(
        "fixture",
        Path(root).resolve(),
        "offline-kubernetes-gateway-token-123456",
        execution="kubernetes",
        image="fixture.invalid/worker@sha256:" + "a" * 64,
        kubernetes_namespace="fixture-tasks",
        kubernetes_service_account="fixture-task",
        kubernetes_ca_config_map="fixture-ca",
        broker_port=port,
        broker_url=f"https://localhost:{port}",
    )


def task(goal="fixture", timeout=10):
    return validate_request(
        {
            "contract": "work-agent/v1",
            "run_id": str(uuid.uuid4()),
            "goal": goal,
            "files": [
                {"name": "材料.md", "text": "材料", "sha256": digest("材料".encode())}
            ],
            "timeout_seconds": timeout,
        }
    )


class FakePodAPI:
    def __init__(self):
        self.pods = {}
        self.calls = []
        self.lose_ack = False
        self.on_create = None

    def request(self, method, path, body=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        name = path.rsplit("/", 1)[-1]
        if method == "POST":
            pod = copy.deepcopy(body)
            pod["metadata"]["uid"] = str(uuid.uuid4())
            pod["status"] = {"phase": "Pending"}
            self.pods[pod["metadata"]["name"]] = pod
            if self.on_create:
                self.on_create(pod)
            if self.lose_ack:
                raise KubernetesError()
            return copy.deepcopy(pod)
        if method == "GET" and ("?" in path or name == "pods"):
            return {"items": copy.deepcopy(list(self.pods.values()))}
        if name not in self.pods:
            raise KubernetesError(404)
        if method == "GET":
            return copy.deepcopy(self.pods[name])
        if method == "DELETE":
            if body["preconditions"]["uid"] != self.pods[name]["metadata"]["uid"]:
                raise KubernetesError(409)
            del self.pods[name]
            return {"status": "Success"}
        raise AssertionError("unexpected fake API operation")


class KubernetesBoundaryTests(unittest.TestCase):
    def test_immutable_image_https_namespace_and_runtime_pins(self):
        config = configuration(".")
        for change in (
            {"image": "worker:latest"},
            {"broker_url": "http://localhost:8445"},
            {"kubernetes_namespace": "../meet"},
            {"kubernetes_service_account": ""},
            {"kubernetes_ca_config_map": "../private-secret"},
            {"kubernetes_pull_secrets": ("../credential",)},
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                replace(config, **change)
        changed = replace(config, kubernetes_namespace="other-tasks")
        self.assertNotEqual(config.capabilities(), changed.capabilities())
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "Kubernetes tasks require TLS"):
                Gateway(replace(config, root=Path(directory)))

    def test_task_pod_has_no_host_mount_no_service_token_and_no_retry(self):
        config = configuration(".")
        executor = PodExecutor(config, FakePodAPI())
        request = task()
        pod = executor.manifest(request, "short-lived-bootstrap-only")
        spec = pod["spec"]
        self.assertEqual(spec["restartPolicy"], "Never")
        self.assertFalse(spec["automountServiceAccountToken"])
        self.assertNotIn("hostNetwork", spec)
        self.assertEqual(spec["activeDeadlineSeconds"], request["timeout_seconds"] + 5)
        self.assertEqual(spec["securityContext"]["runAsUser"], 10001)
        self.assertTrue(spec["securityContext"]["runAsNonRoot"])
        self.assertFalse(
            any(
                "hostPath" in volume or "secret" in volume for volume in spec["volumes"]
            )
        )
        container = spec["containers"][0]
        self.assertEqual(container["image"], config.image)
        self.assertTrue(container["securityContext"]["readOnlyRootFilesystem"])
        self.assertEqual(container["securityContext"]["capabilities"]["drop"], ["ALL"])
        self.assertEqual(
            {env["name"] for env in container["env"]},
            {
                "WORK_AGENT_TASK_URL",
                "WORK_AGENT_TASK_TOKEN",
                "WORK_AGENT_POD_UID",
            },
        )
        self.assertNotIn("DEEPSEEK_API_KEY", canonical(pod).decode())
        self.assertNotIn("DASHSCOPE_API_KEY", canonical(pod).decode())

    def test_lost_create_ack_is_one_post_and_deletion_uses_uid_precondition(self):
        api = FakePodAPI()
        api.lose_ack = True
        executor = PodExecutor(configuration("."), api)
        request = task()
        uid = executor.create(request, "ephemeral")
        self.assertEqual(sum(call[0] == "POST" for call in api.calls), 1)
        executor.delete(request["run_id"], uid)
        self.assertEqual(api.pods, {})
        deleted = next(call for call in api.calls if call[0] == "DELETE")
        self.assertEqual(deleted[2]["preconditions"], {"uid": uid})

    def test_wrong_owner_and_replaced_uid_are_never_deleted(self):
        api = FakePodAPI()
        executor = PodExecutor(configuration("."), api)
        request = task()
        uid = executor.create(request, "ephemeral")
        pod = api.pods[executor.name(request["run_id"])]
        for mutate in (
            lambda: pod["metadata"]["labels"].update({OWNER: "another-gateway"}),
            lambda: pod["metadata"].update(uid="replacement-uid"),
        ):
            pod["metadata"]["labels"][OWNER] = executor.owner
            pod["metadata"]["uid"] = uid
            mutate()
            with self.assertRaisesRegex(RuntimeError, "cleanup_identity_mismatch"):
                executor.delete(request["run_id"], uid)
        self.assertFalse(any(call[0] == "DELETE" for call in api.calls))

    def test_existing_pod_from_another_lease_is_never_adopted_or_deleted(self):
        api = FakePodAPI()
        executor = PodExecutor(configuration("."), api)
        request = task()
        executor.create(request, "original-lease")
        pod = api.pods[executor.name(request["run_id"])]
        api.request = lambda method, path, body=None: (
            copy.deepcopy(pod)
            if method == "GET"
            else (_ for _ in ()).throw(KubernetesError(409))
        )
        with self.assertRaisesRegex(RuntimeError, "creation_unknown"):
            executor.create(request, "new-lease")
        with self.assertRaisesRegex(RuntimeError, "cleanup_identity_mismatch"):
            executor.delete(request["run_id"], expected_lease=digest(b"new-lease"))
        self.assertEqual(
            pod["metadata"]["annotations"][LEASE], digest(b"original-lease")
        )

    def test_recovery_removes_owned_pods_without_starting_a_second_execution(self):
        api = FakePodAPI()
        executor = PodExecutor(configuration("."), api)
        request = task()
        executor.create(request, "expired")
        api.calls.clear()
        executor.recover()
        self.assertEqual(api.pods, {})
        self.assertFalse(any(call[0] == "POST" for call in api.calls))


class TaskTransportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / "jobs.sqlite3")
        self.request = task()
        self.store.admit(self.request)
        self.store.claim()
        self.transport = TaskTransport(self.store)
        self.token = self.transport.register(
            self.request, {"WORK_AGENT_MODEL_TOKEN": "short-model-token"}
        )
        self.run_id = self.request["run_id"]
        self.uid = str(uuid.uuid4())
        self.transport.assign(self.run_id, self.uid)
        self.authorization = "Bearer " + self.token

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def call(self, action, body):
        return self.transport.exchange(self.run_id, action, self.authorization, body)

    def test_single_claim_is_pod_bound_revocable_and_cannot_replay_model_execution(
        self,
    ):
        with self.assertRaises(ContractError) as error:
            self.call("bootstrap", {"pod_uid": "another-pod"})
        self.assertEqual(error.exception.code, "task_identity_mismatch")
        self.assertEqual(
            self.call("bootstrap", {"pod_uid": self.uid})["request"], self.request
        )
        with self.assertRaises(ContractError) as error:
            self.call("bootstrap", {"pod_uid": self.uid})
        self.assertEqual(error.exception.code, "task_already_claimed")
        self.transport.revoke(self.run_id)
        with self.assertRaises(ContractError) as error:
            self.call("bootstrap", {"pod_uid": self.uid})
        self.assertEqual(error.exception.code, "unauthorized")

    def test_idempotent_result_ack_rejects_conflict_credentials_and_canceled_tasks(
        self,
    ):
        self.call("bootstrap", {"pod_uid": self.uid})
        result = {"summary": "fixture", "usage": None, "artifacts": [], "elapsed_ms": 1}
        body = {"pod_uid": self.uid, "result": result}
        first = self.call("result", body)
        self.assertEqual(first, self.call("result", body))
        for summary, code in (
            ("changed", "task_result_conflict"),
            (self.token, "invalid_result"),
            ("short-model-token", "invalid_result"),
        ):
            with self.subTest(code=code), self.assertRaises(ContractError) as error:
                self.call(
                    "result",
                    {"pod_uid": self.uid, "result": {**result, "summary": summary}},
                )
            self.assertEqual(error.exception.code, code)
        self.store.cancel(self.run_id)
        with self.assertRaises(ContractError) as error:
            self.call("result", body)
        self.assertEqual(error.exception.code, "task_not_running")


class KubernetesTLSRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.ca = delivery.tls_fixture(self.root)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.root / "tls.crt", self.root / "tls.key")
        self.api = FakePodAPI()
        self.config = configuration(self.root / "gateway-state")
        self.gateway = Gateway(
            self.config, tls_context=context, kubernetes_api=self.api
        )
        self.gateway.start()
        self.processes = {}

    def tearDown(self):
        self.gateway.close()
        for process in self.processes.values():
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
        self.temp.cleanup()

    def run_task_process(self, pod):
        metadata = pod["metadata"]
        directory = self.root / ("isolated-" + metadata["uid"])
        directory.mkdir()
        environment = {
            key: os.environ[key]
            for key in ("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP")
            if key in os.environ
        }
        environment["PYTHONPATH"] = str(ROOT / "src/work-agent")
        environment.update(
            {
                env["name"]: env["value"]
                for env in pod["spec"]["containers"][0]["env"]
                if "value" in env
            }
        )
        environment["WORK_AGENT_POD_UID"] = metadata["uid"]
        code = (
            "from pathlib import Path; import sys; "
            "from work_agent.pod_runner import execute; "
            "execute(Path(sys.argv[1]), ca_path=sys.argv[2])"
        )
        self.processes[metadata["name"]] = subprocess.Popen(
            [sys.executable, "-c", code, str(directory), str(self.root / "ca.crt")],
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        pod["status"]["phase"] = "Running"

    def poll(self, run_id):
        for _ in range(160):
            for name, process in self.processes.items():
                if name in self.api.pods and process.poll() is not None:
                    self.api.pods[name]["status"]["phase"] = (
                        "Succeeded" if process.returncode == 0 else "Failed"
                    )
            job = self.gateway.store.get(run_id)
            if (
                job["state"] in {"succeeded", "failed", "cancelled"}
                and not self.api.pods
            ):
                return job
            time.sleep(0.05)
        self.fail("Kubernetes worker did not reach terminal cleanup")

    def test_real_tls_bootstrap_fixture_process_artifact_and_lost_ack(self):
        self.api.on_create = self.run_task_process
        self.api.lose_ack = True
        request = task()
        self.gateway.store.admit(request, self.config.capabilities())
        with patch(
            "work_agent.worker.subprocess.Popen", wraps=subprocess.Popen
        ) as docker_path:
            job = self.poll(request["run_id"])
        self.assertEqual(job["state"], "succeeded")
        self.assertEqual(job["result"]["artifacts"][0]["name"], "report.md")
        self.assertEqual(job["result"]["execution"]["execution"], "kubernetes")
        self.assertIsNone(job["result"]["usage"])
        self.assertEqual(sum(call[0] == "POST" for call in self.api.calls), 1)
        self.assertFalse(
            any(call.args[0][0] == "docker" for call in docker_path.call_args_list)
        )
        self.assertEqual(self.gateway.broker.tokens, {})
        self.assertEqual(self.gateway.worker.tasks.tasks, {})

    def test_cancel_during_create_and_deadline_both_remove_task_pod_and_credentials(
        self,
    ):
        for cancel in (True, False):
            with self.subTest(cancel=cancel):
                request = task(timeout=1)
                self.api.on_create = (
                    (
                        lambda pod, run_id=request["run_id"]: self.gateway.store.cancel(
                            run_id
                        )
                    )
                    if cancel
                    else None
                )
                self.gateway.store.admit(request, self.config.capabilities())
                job = self.poll(request["run_id"])
                self.assertEqual(job["state"], "cancelled" if cancel else "failed")
                if not cancel:
                    self.assertEqual(job["error_code"], "deadline_exceeded")
                self.assertEqual(self.gateway.broker.tokens, {})
                self.assertEqual(self.gateway.worker.tasks.tasks, {})


if __name__ == "__main__":
    unittest.main()
