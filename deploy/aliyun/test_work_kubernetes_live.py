"""Opt-in, offline K3s acceptance in a labelled disposable local fixture only.

WORK_K3S_FIXTURE_STATE points at the private fixture's public state.json.
Never uses kubeconfig, the current kubectl context, production or provider keys.
"""

import base64
import importlib.util
import json
import os
import secrets
import subprocess
import tempfile
import time
import unittest
import uuid
from pathlib import Path

from test_work_kubernetes_delivery import check, fixture_values

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "delivery_fixture", Path(__file__).with_name("test_work_agent_delivery.py")
)
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)


@unittest.skipUnless(
    os.environ.get("WORK_K3S_FIXTURE_STATE"), "explicit isolated K3s fixture required"
)
class LiveKubernetesTests(unittest.TestCase):
    def docker(self, *args, data=None, timeout=30):
        result = subprocess.run(
            ["docker", "--context=desktop-linux", *args],
            input=data,
            capture_output=True,
            timeout=timeout,
        )
        if result.returncode:
            self.fail(
                "isolated K3s command failed: "
                + result.stderr.decode(errors="replace")[:1500]
            )
        return result.stdout

    def kubectl(self, *args, data=None, timeout=30):
        return self.docker(
            "exec",
            "-i",
            self.state["server"],
            "kubectl",
            *args,
            data=data,
            timeout=timeout,
        )

    def apply(self, *resources):
        self.kubectl(
            "apply",
            "-f",
            "-",
            data=json.dumps(
                {"apiVersion": "v1", "kind": "List", "items": list(resources)}
            ).encode(),
        )

    def setUp(self):
        self.state_path = Path(os.environ["WORK_K3S_FIXTURE_STATE"])
        self.state = json.loads(self.state_path.read_text())
        daemon = json.loads(self.docker("info", "--format", "{{json .}}"))
        self.assertEqual(daemon["Name"], "docker-desktop")
        self.assertEqual(daemon["OperatingSystem"], "Docker Desktop")
        server = json.loads(self.docker("inspect", self.state["server"]))[0]
        self.assertEqual(
            server["Config"]["Labels"]["we-meet.k3s-fixture"], self.state["marker"]
        )
        self.assertEqual(
            server["Image"], self.state["containers"][self.state["server"]]
        )
        self.assertEqual(server["HostConfig"]["NetworkMode"], self.state["network"])
        self.assertFalse(server["HostConfig"]["PortBindings"])
        self.assertFalse(
            any(
                mount["Destination"].endswith("docker.sock")
                for mount in server["Mounts"]
            )
        )
        registry_name = self.state["gateway_repository"].split(":")[0]
        registry = json.loads(self.docker("inspect", registry_name))[0]
        self.assertEqual(
            registry["Config"]["Labels"]["we-meet.k3s-fixture"], self.state["marker"]
        )
        self.registry_ip = registry["NetworkSettings"]["Networks"][
            self.state["network"]
        ]["IPAddress"]
        self.image = (
            self.state["gateway_repository"] + "@" + self.state["gateway_digest"]
        )
        self.token = secrets.token_urlsafe(32)
        self.temp = tempfile.TemporaryDirectory()
        directory = Path(self.temp.name)
        self.hostname = "fixture-review.fixture-agent.svc.cluster.local"
        ca = delivery.tls_fixture(directory, (self.hostname,))
        self.addCleanup(self.temp.cleanup)
        existing = json.loads(self.kubectl("get", "namespaces", "-o", "json"))
        self.assertFalse(
            {"fixture-agent", "fixture-business", "fixture-tasks"}
            & {row["metadata"]["name"] for row in existing["items"]}
        )
        self.apply(
            *[
                {
                    "apiVersion": "v1",
                    "kind": "Namespace",
                    "metadata": {
                        "name": name,
                        "labels": {"pod-security.kubernetes.io/enforce": "restricted"},
                    },
                }
                for name in ("fixture-agent", "fixture-business")
            ]
        )
        self.addCleanup(
            self.kubectl,
            "delete",
            "namespace",
            "fixture-agent",
            "fixture-business",
            "fixture-tasks",
            "--ignore-not-found",
            "--wait=true",
            "--timeout=60s",
            timeout=70,
        )
        self.apply(
            {
                "apiVersion": "v1",
                "kind": "Secret",
                "type": "kubernetes.io/tls",
                "metadata": {"name": "fixture-tls", "namespace": "fixture-agent"},
                "data": {
                    name: base64.b64encode((directory / name).read_bytes()).decode()
                    for name in ("tls.crt", "tls.key", "ca.crt")
                },
            },
            {
                "apiVersion": "v1",
                "kind": "Secret",
                "metadata": {"name": "fixture-token", "namespace": "fixture-agent"},
                "data": {
                    "WORK_AGENT_TOKEN": base64.b64encode(self.token.encode()).decode()
                },
            },
            {
                "apiVersion": "v1",
                "kind": "ConfigMap",
                "metadata": {"name": "fixture-ca", "namespace": "fixture-business"},
                "data": {"ca.crt": ca},
            },
        )
        values = fixture_values()
        agent = values["workAgent"]
        agent.update(fullname="fixture-review", businessNamespace="fixture-business")
        agent["image"] = {
            "repository": self.state["gateway_repository"],
            "digest": self.state["gateway_digest"],
        }
        agent["runtime"]["workerImage"] = self.image
        agent["tasks"].update(
            publicCA=ca, apiServerCIDR=self.state["server_ip"] + "/32"
        )
        self.apply(*check.render_agent(values, "fixture-agent"))
        self.kubectl(
            "rollout",
            "status",
            "deployment/fixture-review",
            "-n",
            "fixture-agent",
            "--timeout=120s",
            timeout=130,
        )
        self.apply(self.probe("client", "fixture-business", "fixture-ca"))
        self.kubectl(
            "wait",
            "pod/client",
            "-n",
            "fixture-business",
            "--for=condition=Ready",
            "--timeout=90s",
            timeout=100,
        )

    def probe(self, name, namespace, ca_name):
        return {
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {
                "name": name,
                "namespace": namespace,
                "labels": {"app.kubernetes.io/component": "agent-task"},
            },
            "spec": {
                "automountServiceAccountToken": False,
                "restartPolicy": "Never",
                "securityContext": {
                    "runAsNonRoot": True,
                    "runAsUser": 10001,
                    "runAsGroup": 10001,
                    "fsGroup": 10001,
                    "seccompProfile": {"type": "RuntimeDefault"},
                },
                "containers": [
                    {
                        "name": "probe",
                        "image": self.image,
                        "imagePullPolicy": "IfNotPresent",
                        "command": ["python", "-m", "http.server", "8080"],
                        "securityContext": {
                            "allowPrivilegeEscalation": False,
                            "readOnlyRootFilesystem": True,
                            "capabilities": {"drop": ["ALL"]},
                        },
                        "resources": {
                            "requests": {
                                "cpu": "100m",
                                "memory": "128Mi",
                                "ephemeral-storage": "64Mi",
                            },
                            "limits": {
                                "cpu": "1",
                                "memory": "1Gi",
                                "ephemeral-storage": "256Mi",
                            },
                        },
                        "volumeMounts": [
                            {"name": "ca", "mountPath": "/trust", "readOnly": True}
                        ],
                    }
                ],
                "volumes": [{"name": "ca", "configMap": {"name": ca_name}}],
            },
        }

    def python(self, code, *, pod="client", namespace="fixture-business"):
        return self.kubectl(
            "exec", "-i", pod, "-n", namespace, "--", "python", "-", data=code.encode()
        )

    def call(self, method, path, body=None):
        code = f"""import json,ssl,urllib.request
opener=urllib.request.build_opener(urllib.request.ProxyHandler({{}}),urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile='/trust/ca.crt')))
request=urllib.request.Request({("https://" + self.hostname + ":8444" + path)!r},method={method!r},data={json.dumps(body).encode() if body is not None else None!r},headers={{'Authorization':{"Bearer " + self.token!r},'Content-Type':'application/json'}})
with opener.open(request,timeout=5) as response: print(response.read().decode())
"""
        return json.loads(self.python(code))

    def submit(self, goal, timeout=30, operation=None):
        run_id = str(uuid.uuid4())
        request = {
            "contract": "work-agent/v1",
            "run_id": run_id,
            "goal": goal,
            "files": [],
            "timeout_seconds": timeout,
        }
        if operation:
            request["operation"] = operation
        self.call(
            "POST",
            "/v1/jobs",
            request,
        )
        return run_id

    def poll(self, run_id, desired):
        for _ in range(100):
            job = self.call("GET", "/v1/jobs/" + run_id)
            if job["state"] in desired:
                return job
            time.sleep(0.2)
        self.fail("isolated K3s job did not reach requested state")

    def test_actual_pod_delivery_cancel_deadline_recovery_rbac_and_network_policy(self):
        receipts = []
        run_id = self.submit("fixture")
        job = self.poll(run_id, {"succeeded", "failed"})
        self.assertEqual(job["state"], "succeeded")
        self.assertEqual(job["result"]["execution"]["execution"], "kubernetes")
        self.assertEqual(job["result"]["artifacts"][0]["name"], "report.md")
        self.assertIsNone(job["result"]["usage"])
        receipts.append({"case": "delivery", "run_id": run_id, "state": job["state"]})
        for goal, action, expected in (
            ("fixture:slow", "cancel", "cancelled"),
            ("fixture:slow", "deadline", "failed"),
            ("fixture:slow", "restart", "failed"),
        ):
            run_id = self.submit(goal, timeout=3 if action == "deadline" else 30)
            self.poll(run_id, {"running"})
            if action == "cancel":
                self.call("POST", "/v1/jobs/" + run_id + "/cancel", {})
            if action == "restart":
                self.kubectl(
                    "delete",
                    "pod",
                    "-n",
                    "fixture-agent",
                    "-l",
                    "app.kubernetes.io/name=fixture-review",
                    "--grace-period=0",
                    "--force",
                )
                self.kubectl(
                    "rollout",
                    "status",
                    "deployment/fixture-review",
                    "-n",
                    "fixture-agent",
                    "--timeout=90s",
                    timeout=100,
                )
            job = self.poll(run_id, {"succeeded", "failed", "cancelled"})
            self.assertEqual(job["state"], expected)
            if action == "deadline":
                self.assertEqual(job["error_code"], "deadline_exceeded")
            if action == "restart":
                self.assertEqual(job["error_code"], "execution_unknown")
            receipts.append(
                {
                    "case": action,
                    "run_id": run_id,
                    "state": job["state"],
                    "error_code": job.get("error_code"),
                }
            )
        for _ in range(50):
            pods = json.loads(
                self.kubectl("get", "pods", "-n", "fixture-tasks", "-o", "json")
            )["items"]
            if not pods:
                break
            time.sleep(0.2)
        self.assertEqual(pods, [])
        for verb, resource, namespace, sa, expected in (
            (
                "create",
                "pods",
                "fixture-tasks",
                "system:serviceaccount:fixture-agent:fixture-review",
                "yes",
            ),
            (
                "create",
                "pods",
                "fixture-business",
                "system:serviceaccount:fixture-agent:fixture-review",
                "no",
            ),
            (
                "get",
                "secrets",
                "fixture-agent",
                "system:serviceaccount:fixture-agent:fixture-review",
                "no",
            ),
            (
                "get",
                "secrets",
                "fixture-tasks",
                "system:serviceaccount:fixture-tasks:work-agent-task",
                "no",
            ),
        ):
            # kubectl returns 1 for the expected RBAC denial.
            result = subprocess.run(
                [
                    "docker",
                    "--context=desktop-linux",
                    "exec",
                    self.state["server"],
                    "kubectl",
                    "auth",
                    "can-i",
                    verb,
                    resource,
                    "-n",
                    namespace,
                    "--as=" + sa,
                ],
                capture_output=True,
                timeout=10,
            )
            self.assertEqual(result.stdout.decode().strip(), expected)
        self.apply(self.probe("network-probe", "fixture-tasks", "work-agent-ca"))
        self.kubectl(
            "wait",
            "pod/network-probe",
            "-n",
            "fixture-tasks",
            "--for=condition=Ready",
            "--timeout=60s",
            timeout=70,
        )
        client_ip = json.loads(
            self.kubectl("get", "pod/client", "-n", "fixture-business", "-o", "json")
        )["status"]["podIP"]
        self.python(
            "import socket; socket.create_connection(('127.0.0.1',8080),timeout=2).close()"
        )
        self.python(
            f"import socket; socket.create_connection(({self.registry_ip!r},5000),timeout=2).close()"
        )
        network = json.loads(
            self.python(
                f"""import json,socket,ssl,urllib.request,urllib.error
assert not __import__('pathlib').Path('/var/run/secrets/kubernetes.io/serviceaccount/token').exists()
opener=urllib.request.build_opener(urllib.request.ProxyHandler({{}}),urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile='/trust/ca.crt')))
try: opener.open(urllib.request.Request({"https://" + self.hostname + ":8445/task/unknown/bootstrap"!r},method='POST',data=b'{{}}'),timeout=3)
except urllib.error.HTTPError as error: assert error.code==401
else: raise AssertionError('unauthenticated broker accepted')
denied=[]
for host,port in [({self.hostname!r},8444),({client_ip!r},8080),({self.state["gateway_repository"].split(":")[0]!r},5000)]:
    try: connection=socket.create_connection((host,port),timeout=2)
    except (TimeoutError,OSError): denied.append(port)
    else: connection.close();raise AssertionError('forbidden connection allowed')
print(json.dumps({{'broker_tls':True,'broker_unauthorized':401,'blocked_ports':denied,'service_account_token':False}}))
""",
                pod="network-probe",
                namespace="fixture-tasks",
            )
        )
        self.assertEqual(network["blocked_ports"], [8444, 8080, 5000])
        sdk_receipts = []
        for engine, worker in self.state.get("worker_images", {}).items():
            provider_name = "qwen" if engine == "pi" else "deepseek"
            model = "qwen3.8-flash" if engine == "pi" else "deepseek-flash"
            code = f"""import io,json,os,signal,ssl,threading
from pathlib import Path
from work_agent.config import Config
from work_agent.server import Gateway
os.environ["DASHSCOPE_API_KEY" if {engine!r}=="pi" else "DEEPSEEK_API_KEY"]="offline-key-not-a-provider-credential"
def provider(encoded,timeout):
    body=json.loads(encoded)
    assert body["model"]=={model!r}
    report={{"verdict":"no_issues","summary":"Offline SDK TLS proof.","findings":[],"missing_information":[]}}
    text=json.dumps(report) if {engine!r}=="pi" else "Offline SDK TLS proof."
    base={{"id":"chat-offline","object":"chat.completion.chunk","created":1,"model":{model!r}}}
    chunks=[{{**base,"choices":[{{"index":0,"delta":{{"role":"assistant","content":text}},"finish_reason":None}}]}},{{**base,"choices":[{{"index":0,"delta":{{}},"finish_reason":"stop"}}],"usage":{{"prompt_tokens":100,"completion_tokens":30,"total_tokens":130}}}}]
    return io.BytesIO(b"".join(b"data: "+json.dumps(chunk).encode()+b"\\n\\n" for chunk in chunks)+b"data: [DONE]\\n\\n")
context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain('/etc/work-agent/tls/tls.crt','/etc/work-agent/tls/tls.key')
config=Config({engine!r},Path('/var/lib/we-meet-work-review'),os.environ['WORK_AGENT_TOKEN'],provider={provider_name!r},model={model!r},execution='kubernetes',image={worker["image"]!r},kubernetes_namespace='fixture-tasks',kubernetes_service_account='work-agent-task',kubernetes_ca_config_map='work-agent-ca',broker_url={"https://" + self.hostname + ":8445"!r},broker_port=8445)
gateway=Gateway(config,host='0.0.0.0',port=8444,tls_context=context,broker_provider=provider)
stop=threading.Event()
signal.signal(signal.SIGTERM,lambda *_:stop.set())
gateway.start()
stop.wait()
gateway.close()
"""
            deployment = json.loads(
                self.kubectl(
                    "get",
                    "deployment/fixture-review",
                    "-n",
                    "fixture-agent",
                    "-o",
                    "json",
                )
            )
            container = deployment["spec"]["template"]["spec"]["containers"][0]
            container["command"] = ["python", "-c", code]
            container["args"] = []
            self.apply(deployment)
            self.kubectl(
                "rollout",
                "status",
                "deployment/fixture-review",
                "-n",
                "fixture-agent",
                "--timeout=100s",
                timeout=110,
            )
            run_id = self.submit(
                "Offline SDK TLS acceptance",
                timeout=45,
                operation="review" if engine == "pi" else None,
            )
            job = self.poll(run_id, {"succeeded", "failed"})
            self.assertEqual(job["state"], "succeeded", job.get("error_code"))
            self.assertEqual(job["result"]["usage"]["output_tokens"], 30)
            self.assertTrue(job["metering"]["complete"])
            self.assertEqual(job["metering"]["calls"], 1)
            sdk_receipts.append(
                {
                    "engine": engine,
                    "runtime_version": job["result"]["execution"]["runtime_version"],
                    "image": worker["image"],
                    "run_id": run_id,
                    "state": job["state"],
                    "usage": job["result"]["usage"],
                    "supplier_calls": 0,
                }
            )
        receipt = {
            "environment": "disposable local K3s",
            "model_calls": 0,
            "worker_image": self.image,
            "cases": receipts,
            "network": network,
            "rbac": "namespace scoped",
            "task_pods_after_jobs": 0,
            "sdk": sdk_receipts,
        }
        self.state_path.with_name("acceptance.json").write_text(
            json.dumps(receipt, indent=2) + "\n", encoding="utf8", newline="\n"
        )


if __name__ == "__main__":
    unittest.main()
