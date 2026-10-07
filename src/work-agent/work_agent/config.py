"""Deployment-owned settings; clients cannot select plugins, paths or credentials."""

import os
from dataclasses import dataclass
from pathlib import Path

from . import ADAPTER_VERSION, CONTRACT, DSH_VERSION, PI_VERSION
from .contract import DEFAULT_LIMITS, digest


@dataclass(frozen=True)
class Config:
    engine: str
    root: Path
    token: str
    model: str = "deepseek-flash"
    execution: str = "docker"
    image: str = "we-meet-work-agent:dsh-poc"
    base_url: str = "https://api.deepseek.com"

    def __post_init__(self):
        if self.engine not in {"dsh", "pi", "fixture"}:
            raise ValueError("unsupported engine")
        if len(self.token) < 24:
            raise ValueError("gateway token must have at least 24 characters")
        if self.execution not in {"docker", "fixture"}:
            raise ValueError("unsupported execution")
        if (self.engine == "fixture") != (self.execution == "fixture"):
            raise ValueError("real engines require per-job Docker isolation")
        if self.engine != "fixture" and not os.environ.get("DEEPSEEK_API_KEY"):
            raise ValueError("missing DEEPSEEK_API_KEY")

    def capabilities(self):
        policy = Path(__file__).with_name("dsh-policy.yml").read_bytes()
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
            "base_url": self.base_url,
            "image": self.image if self.execution == "docker" else None,
            "execution": self.execution,
            "policy_sha256": digest(policy),
            "features": [
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
            if key not in {"DEEPSEEK_API_KEY", "WORK_AGENT_TOKEN"}:
                raise ValueError("unsupported env file key")
            os.environ[key] = value
