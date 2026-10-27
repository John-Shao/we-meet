"""Model Gateway contract (D4/D-08): per-org provider context and invocation."""

from dataclasses import dataclass
from typing import Literal, Protocol

from work.runtime.contracts.work_adapter import ModelCallRequest, ModelCallResult


@dataclass(frozen=True, slots=True)
class ProviderContext:
    org_id: str
    provider: Literal["aliyun", "volcengine", "deepseek"]
    model: str
    region: str
    endpoint: str
    credential_mode: Literal["sts_role", "managed_key"]
    role_ref: str | None = None
    secret_ciphertext: bytes | None = None
    wrapped_dek: bytes | None = None
    kms_key_ref: str | None = None


class ModelGatewayError(Exception):
    def __init__(self, code: str, *, retryable: bool = False):
        self.code = code
        self.retryable = retryable
        super().__init__(code)


class ModelGateway(Protocol):
    def resolve_provider_context(self, org_id: str) -> ProviderContext: ...

    def invoke(
        self, request: ModelCallRequest, provider: ProviderContext
    ) -> ModelCallResult: ...
