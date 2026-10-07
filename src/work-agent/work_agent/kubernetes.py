"""Namespace-scoped, no-retry Kubernetes Pod executor; never uses a Docker socket."""

import ipaddress
import json
import os
import re
import ssl
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPSHandler, ProxyHandler, Request, build_opener

from .contract import canonical, digest
from .model_broker import NoRedirect

OWNER = "work.we-meet.io/owner"
RUN = "work.we-meet.io/run"
LEASE = "work.we-meet.io/lease"
MAX_API_RESPONSE = 2_000_000


class KubernetesError(RuntimeError):
    def __init__(self, status=0):
        super().__init__("kubernetes_api_failed")
        self.status = status


class KubernetesAPI:
    def __init__(self, *, endpoint=None, token_path=None, ca_path=None):
        service = Path("/var/run/secrets/kubernetes.io/serviceaccount")
        if endpoint is None:
            host = str(ipaddress.ip_address(os.environ["KUBERNETES_SERVICE_HOST"]))
            host = f"[{host}]" if ":" in host else host
            port = int(os.environ.get("KUBERNETES_SERVICE_PORT_HTTPS", "443"))
            if not 1 <= port <= 65535:
                raise ValueError("invalid Kubernetes service port")
            endpoint = f"https://{host}:{port}"
        parsed = urlsplit(endpoint)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.path
        ):
            raise ValueError("Kubernetes API requires a bare HTTPS endpoint")
        self.endpoint = endpoint
        self.token_path = Path(token_path or service / "token")
        context = ssl.create_default_context()
        context.load_verify_locations(cafile=str(ca_path or service / "ca.crt"))
        self.opener = build_opener(
            ProxyHandler({}), NoRedirect(), HTTPSHandler(context=context)
        )

    def request(self, method, path, body=None):
        try:
            # Re-read projected tokens so rotation does not require a restart.
            token = self.token_path.read_text("utf-8").strip()
            if not token or "\n" in token or "\r" in token:
                raise KubernetesError()
            request = Request(
                self.endpoint + path,
                method=method,
                data=canonical(body) if body is not None else None,
                headers={
                    "Authorization": "Bearer " + token,
                    "Content-Type": "application/json",
                },
            )
            with self.opener.open(request, timeout=5) as response:
                content = response.read(MAX_API_RESPONSE + 1)
            if len(content) > MAX_API_RESPONSE:
                raise KubernetesError()
            return json.loads(content)
        except HTTPError as error:
            raise KubernetesError(error.code) from None
        except Exception:
            raise KubernetesError() from None


class PodExecutor:
    def __init__(self, config, api=None):
        self.config = config
        self.api = api or KubernetesAPI()
        self.owner = digest(
            (config.kubernetes_namespace + "|" + str(config.root)).encode()
        )[:32]
        self.base = f"/api/v1/namespaces/{config.kubernetes_namespace}/pods"

    @staticmethod
    def name(run_id):
        if not re.fullmatch(r"[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}", run_id):
            raise ValueError("invalid Kubernetes run ID")
        return "wa-" + run_id

    def manifest(self, request, task_token):
        config = self.config
        run_id = request["run_id"]
        return {
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {
                "name": self.name(run_id),
                "namespace": config.kubernetes_namespace,
                "annotations": {LEASE: digest(task_token.encode())},
                "labels": {
                    OWNER: self.owner,
                    RUN: run_id,
                    "app.kubernetes.io/component": "agent-task",
                },
            },
            "spec": {
                "restartPolicy": "Never",
                "automountServiceAccountToken": False,
                "serviceAccountName": config.kubernetes_service_account,
                "imagePullSecrets": [
                    {"name": name} for name in config.kubernetes_pull_secrets
                ],
                "activeDeadlineSeconds": request["timeout_seconds"] + 5,
                "terminationGracePeriodSeconds": 5,
                "securityContext": {
                    "runAsNonRoot": True,
                    "runAsUser": 10001,
                    "runAsGroup": 10001,
                    "fsGroup": 10001,
                    "seccompProfile": {"type": "RuntimeDefault"},
                },
                "containers": [
                    {
                        "name": "agent",
                        "image": config.image,
                        "imagePullPolicy": "IfNotPresent",
                        "command": ["python", "-m", "work_agent.pod_runner", "/job"],
                        "env": [
                            {
                                "name": "WORK_AGENT_TASK_URL",
                                "value": config.broker_url + "/task/" + run_id,
                            },
                            {"name": "WORK_AGENT_TASK_TOKEN", "value": task_token},
                            {
                                "name": "WORK_AGENT_POD_UID",
                                "valueFrom": {
                                    "fieldRef": {"fieldPath": "metadata.uid"}
                                },
                            },
                        ],
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
                            {"name": "job", "mountPath": "/job"},
                            {"name": "tmp", "mountPath": "/tmp"},
                            {"name": "ca", "mountPath": "/trust", "readOnly": True},
                        ],
                    }
                ],
                "volumes": [
                    {"name": "job", "emptyDir": {"sizeLimit": "128Mi"}},
                    {
                        "name": "tmp",
                        "emptyDir": {"medium": "Memory", "sizeLimit": "128Mi"},
                    },
                    {
                        "name": "ca",
                        "configMap": {
                            "name": config.kubernetes_ca_config_map,
                            "items": [{"key": "ca.crt", "path": "ca.crt"}],
                        },
                    },
                ],
            },
        }

    def get(self, run_id):
        try:
            return self.api.request("GET", self.base + "/" + self.name(run_id))
        except KubernetesError as error:
            if error.status == 404:
                return None
            raise

    def owned(self, pod, run_id):
        labels = pod.get("metadata", {}).get("labels", {})
        return (
            labels.get(OWNER) == self.owner
            and labels.get(RUN) == run_id
            and pod.get("metadata", {}).get("name") == self.name(run_id)
        )

    def create(self, request, token):
        run_id = request["run_id"]
        try:
            pod = self.api.request("POST", self.base, self.manifest(request, token))
        except KubernetesError:
            # One POST only. A lost ACK never starts another paid attempt.
            pod = self.get(run_id)
        if (
            not pod
            or not self.owned(pod, run_id)
            or pod.get("metadata", {}).get("annotations", {}).get(LEASE)
            != digest(token.encode())
            or not pod.get("metadata", {}).get("uid")
        ):
            raise RuntimeError("kubernetes_creation_unknown")
        return pod["metadata"]["uid"]

    def delete(self, run_id, expected_uid=None, expected_lease=None):
        pod = self.get(run_id)
        if pod is None:
            return
        uid = pod.get("metadata", {}).get("uid")
        if (
            not self.owned(pod, run_id)
            or not uid
            or (expected_uid and uid != expected_uid)
            or (
                expected_lease
                and pod.get("metadata", {}).get("annotations", {}).get(LEASE)
                != expected_lease
            )
        ):
            raise RuntimeError("kubernetes_cleanup_identity_mismatch")
        try:
            self.api.request(
                "DELETE",
                self.base + "/" + self.name(run_id),
                {
                    "apiVersion": "v1",
                    "kind": "DeleteOptions",
                    "gracePeriodSeconds": 0,
                    "preconditions": {"uid": uid},
                },
            )
        except KubernetesError as error:
            if error.status != 404:
                raise

    def recover(self):
        query = urlencode({"labelSelector": OWNER + "=" + self.owner, "limit": 129})
        result = self.api.request("GET", self.base + "?" + query)
        items = result.get("items", [])
        if len(items) > 128 or result.get("metadata", {}).get("continue"):
            raise RuntimeError("kubernetes_recovery_incomplete")
        for pod in items:
            run_id = pod.get("metadata", {}).get("labels", {}).get(RUN, "")
            if not self.owned(pod, run_id):
                raise RuntimeError("kubernetes_cleanup_identity_mismatch")
            self.delete(run_id, pod["metadata"]["uid"])
