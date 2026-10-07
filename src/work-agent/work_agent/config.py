"""Deployment-owned settings; clients cannot select plugins, paths or credentials."""

import os
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from . import ADAPTER_VERSION, CONTRACT, DSH_VERSION, PI_VERSION
from .contract import DEFAULT_LIMITS, canonical, digest
from .review import response_format

PROVIDERS = {
    "deepseek": ("DEEPSEEK_API_KEY", "https://api.deepseek.com"),
    "qwen": ("DASHSCOPE_API_KEY", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
}


@dataclass(frozen=True)
class Config:
    engine: str
    root: Path
    token: str
    model: str = "deepseek-flash"
    execution: str = "docker"
    image: str = "we-meet-work-agent:dsh-poc"
    base_url: str | None = None
    provider: str = "deepseek"
    kubernetes_namespace: str = ""
    kubernetes_service_account: str = ""
    kubernetes_ca_config_map: str = ""
    broker_url: str = ""
    broker_port: int = 8445
    kubernetes_pull_secrets: tuple = ()

    def __post_init__(self):
        if self.engine not in {"dsh", "pi", "fixture"}:
            raise ValueError("unsupported engine")
        if self.provider not in PROVIDERS:
            raise ValueError("unsupported provider")
        if self.engine == "dsh" and self.provider != "deepseek":
            raise ValueError("dsh requires the DeepSeek provider")
        if self.provider == "qwen" and self.model == "deepseek-flash":
            raise ValueError("Qwen deployment requires an explicit Qwen model")
        object.__setattr__(
            self, "base_url", self.base_url or PROVIDERS[self.provider][1]
        )
        endpoint = urlsplit(self.base_url)
        if (
            endpoint.scheme != "https"
            or not endpoint.hostname
            or endpoint.username is not None
            or endpoint.password is not None
            or endpoint.query
            or endpoint.fragment
        ):
            raise ValueError(
                "provider base URL must be HTTPS without credentials or query"
            )
        if len(self.token) < 24:
            raise ValueError("gateway token must have at least 24 characters")
        if self.execution not in {"docker", "kubernetes", "fixture"}:
            raise ValueError("unsupported execution")
        if self.execution == "fixture" and self.engine != "fixture":
            raise ValueError("real engines require per-job isolation")
        if self.engine == "fixture" and self.execution == "docker":
            raise ValueError(
                "fixture Docker execution requires explicit test configuration"
            )
        if self.execution == "kubernetes":
            if any(
                not re.fullmatch(r"[a-z0-9]([-a-z0-9]*[a-z0-9])?", name)
                or len(name) > 63
                for name in self.kubernetes_pull_secrets
            ):
                raise ValueError("invalid task image pull Secret")
            for name in (
                self.kubernetes_namespace,
                self.kubernetes_service_account,
                self.kubernetes_ca_config_map,
            ):
                if (
                    not re.fullmatch(r"[a-z0-9]([-a-z0-9]*[a-z0-9])?", name)
                    or len(name) > 63
                ):
                    raise ValueError("invalid Kubernetes resource name")
            if not re.fullmatch(r"[^\s@]+@sha256:[a-f0-9]{64}", self.image):
                raise ValueError("Kubernetes workers require an immutable image")
            broker = urlsplit(self.broker_url)
            if (
                broker.scheme != "https"
                or not broker.hostname
                or broker.username
                or broker.password
                or broker.path
                or broker.query
                or broker.fragment
                or broker.port != self.broker_port
                or not 1 <= self.broker_port <= 65535
            ):
                raise ValueError(
                    "Kubernetes workers require a fixed HTTPS broker endpoint"
                )
        if self.engine != "fixture" and not os.environ.get(self.api_key_env):
            raise ValueError("missing " + self.api_key_env)

    @property
    def api_key_env(self):
        return PROVIDERS[self.provider][0]

    def capabilities(self):
        policy = Path(__file__).with_name("dsh-policy.yml").read_bytes()
        review_format = response_format(self.provider, self.model)
        return {
            "contract": CONTRACT,
            "adapter_version": ADAPTER_VERSION,
            "engine": self.engine,
            "runtime_version": {
                "dsh": DSH_VERSION,
                "pi": PI_VERSION,
                "fixture": "offline",
            }[self.engine],
            "model": self.model,
            "provider": self.provider,
            "thinking": "off" if self.provider == "qwen" else "low",
            "review_output_format": review_format["type"],
            "review_schema_sha256": digest(
                canonical(review_format["json_schema"]["schema"])
            )
            if review_format["type"] == "json_schema"
            else None,
            "base_url": self.base_url,
            "image": self.image if self.execution != "fixture" else None,
            "execution": self.execution,
            **(
                {
                    "kubernetes_runtime": {
                        "namespace": self.kubernetes_namespace,
                        "service_account": self.kubernetes_service_account,
                        "ca_config_map": self.kubernetes_ca_config_map,
                        "broker_url": self.broker_url,
                        "image_pull_secrets": list(self.kubernetes_pull_secrets),
                    }
                }
                if self.execution == "kubernetes"
                else {}
            ),
            "policy_sha256": digest(policy),
            "features": (
                ["readonly_review_v1"] if self.engine in {"pi", "fixture"} else []
            )
            + [
                "submit",
                "poll",
                "cancel",
                "idempotency",
                "artifacts",
                "model_broker",
                "cumulative_budget",
                "provider_metering",
            ],
            "limits_ceiling": DEFAULT_LIMITS,
            "limitations": [
                "no_resume",
                "no_business_tools",
                "usage_may_be_unknown",
                "synthetic_materials_only",
            ],
        }


def load_env(path):
    """Small explicit secret file, never shell-evaluated or logged."""
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#"):
            key, value = line.split("=", 1)
            if key not in {"DEEPSEEK_API_KEY", "DASHSCOPE_API_KEY", "WORK_AGENT_TOKEN"}:
                raise ValueError("unsupported env file key")
            os.environ[key] = value
