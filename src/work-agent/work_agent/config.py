"""Deployment-owned settings; clients cannot select plugins, paths or credentials."""

import os
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
        if self.execution not in {"docker", "fixture"}:
            raise ValueError("unsupported execution")
        if (self.engine == "fixture") != (self.execution == "fixture"):
            raise ValueError("real engines require per-job Docker isolation")
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
            "image": self.image if self.execution == "docker" else None,
            "execution": self.execution,
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
