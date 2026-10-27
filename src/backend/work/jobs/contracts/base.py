"""Background-job contract shared by the six non-Run jobs (D3 §11)."""

from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class JobContract:
    name: str
    data_layer: tuple[str, ...]
    owner_epic: str
    trigger: str
    lease_seconds: int
    stop_behavior: str
    resume_behavior: str
    idempotency_key: str
    output: tuple[str, ...] = field(default_factory=tuple)
