"""Deterministic faux model gateway; no network, no provider credential."""

from work.content.mock.local_filesystem import LocalFilesystemContentStore
from work.runtime.contracts.model_gateway import ProviderContext
from work.runtime.contracts.work_adapter import ModelCallResult, UsageReport


class FauxModelGateway:
    def __init__(self, content: str = "# Draft\n", usage: UsageReport | None = None):
        self.content = content
        self.usage = usage or UsageReport(
            input_tokens=5, output_tokens=7, cached_input_tokens=0
        )

    def resolve_provider_context(self, org_id: str) -> ProviderContext:
        return ProviderContext(
            org_id=org_id,
            provider="aliyun",
            model="qwen3.8-flash",
            region="cn-beijing",
            endpoint="https://dashscope.aliyuncs.com/compatible-mode/v1",
            credential_mode="managed_key",
        )

    def invoke(self, request, provider: ProviderContext) -> ModelCallResult:
        stored = LocalFilesystemContentStore().put(
            provider.org_id, self.content.encode("utf-8"), suffix=".md"
        )
        return ModelCallResult(
            content_ref=stored.ref,
            content_hash=stored.content_hash,
            bytes=stored.bytes,
            media_type="text/markdown",
            provider_request_id=f"faux-{request.operation_id}",
            usage=self.usage,
        )
