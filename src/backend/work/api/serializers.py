"""Request validation for the frozen R0a contract (D2)."""

from rest_framework import serializers

from work.api.constants import LIMITS
from work.api.errors import WorkAPIError

PROVIDERS = ["aliyun", "volcengine", "deepseek"]
PERMISSION_MODES = ["ask_each", "auto_readonly"]
MEDIA_TYPES = ["text/markdown", "text/plain"]


class TargetSerializer(serializers.Serializer):
    kind = serializers.CharField()
    profile = serializers.CharField()

    def validate(self, attrs):
        if attrs.get("kind") != "cloud" or attrs.get("profile") != "text-v1":
            raise WorkAPIError("execution_target_unavailable")
        return attrs


class TemplateSelectionSerializer(serializers.Serializer):
    id = serializers.CharField(max_length=64)
    version = serializers.IntegerField(min_value=1)


class OutputSpecSerializer(serializers.Serializer):
    format = serializers.CharField()

    def validate_format(self, value):
        if value != "markdown":
            raise WorkAPIError("output_unsupported")
        return value

    audience = serializers.CharField(
        required=False, allow_null=True, allow_blank=True, max_length=200
    )
    length = serializers.ChoiceField(
        choices=["short", "medium", "long"], required=False, allow_null=True
    )
    required_sections = serializers.ListField(
        child=serializers.CharField(max_length=80),
        required=False,
        max_length=10,
    )


class IntentSerializer(serializers.Serializer):
    input_ref = serializers.UUIDField()
    target = TargetSerializer()
    template = TemplateSelectionSerializer(required=False, allow_null=True)
    permission_mode = serializers.CharField()

    def validate_permission_mode(self, value):
        if value not in PERMISSION_MODES:
            raise WorkAPIError("permission_mode_unavailable")
        return value

    output = OutputSpecSerializer()
    suite = serializers.JSONField(required=False, allow_null=True)
    connectors = serializers.ListField(
        child=serializers.JSONField(), required=False, max_length=0
    )

    def validate(self, attrs):
        if attrs.get("suite"):
            raise WorkAPIError("scope_unavailable")
        if attrs.get("connectors"):
            raise WorkAPIError("scope_unavailable")
        return attrs


class InputCreateSerializer(serializers.Serializer):
    client_request_id = serializers.CharField(min_length=8, max_length=128)
    goal = serializers.CharField(allow_blank=False)
    background = serializers.CharField(required=False, allow_blank=True, default="")
    media_type = serializers.ChoiceField(
        choices=["text/markdown"], required=False, default="text/markdown"
    )

    def validate_goal(self, value):
        if len(value) > LIMITS["max_goal_chars"]:
            raise WorkAPIError("input_too_large")
        return value

    def validate_background(self, value):
        if len(value) > LIMITS["max_background_chars"]:
            raise WorkAPIError("input_too_large")
        return value


class TaskPreviewSerializer(serializers.Serializer):
    intent = IntentSerializer()


class TaskSubmitSerializer(serializers.Serializer):
    client_request_id = serializers.CharField(min_length=8, max_length=128)
    preview_hash = serializers.CharField(min_length=8, max_length=512)
    intent = IntentSerializer()


class TaskUpdateSerializer(serializers.Serializer):
    client_request_id = serializers.CharField(min_length=8, max_length=128)
    expected_revision = serializers.IntegerField(min_value=0)
    title = serializers.CharField()

    def validate_title(self, value):
        title = value.strip()
        if not 1 <= len(title) <= 80 or any(ord(char) < 32 for char in title):
            raise WorkAPIError("title_invalid")
        return title


class TaskRunSerializer(serializers.Serializer):
    client_request_id = serializers.CharField(min_length=8, max_length=128)
    expected_revision = serializers.IntegerField(min_value=0)
    target = TargetSerializer()
    reason = serializers.CharField(required=False, allow_blank=True, max_length=500)


class CancelSerializer(serializers.Serializer):
    client_request_id = serializers.CharField(min_length=8, max_length=128)
    reason = serializers.CharField(required=False, allow_blank=True, max_length=500)


class ArtifactVersionCreateSerializer(serializers.Serializer):
    client_request_id = serializers.CharField(min_length=8, max_length=128)
    base_version_no = serializers.IntegerField(min_value=1)
    logical_name = serializers.CharField(
        required=False, allow_blank=True, max_length=200
    )
    media_type = serializers.ChoiceField(
        choices=MEDIA_TYPES, required=False, default="text/markdown"
    )
    content = serializers.CharField(allow_blank=False, trim_whitespace=False)


class AcceptanceSerializer(serializers.Serializer):
    client_request_id = serializers.CharField(min_length=8, max_length=128)
    expected_revision = serializers.IntegerField(min_value=0)
    artifact_id = serializers.UUIDField(required=False)
    version_no = serializers.IntegerField(required=False, min_value=1)
    completion_reason = serializers.CharField(
        required=False, allow_blank=False, max_length=500
    )

    def validate(self, attrs):
        has_version = attrs.get("artifact_id") is not None
        has_reason = bool(attrs.get("completion_reason"))
        if has_version == has_reason:
            raise WorkAPIError("acceptance_requires_artifact_or_reason")
        if has_version and attrs.get("version_no") is None:
            raise WorkAPIError("acceptance_requires_artifact_or_reason")
        return attrs


class ProviderConfigSetSerializer(serializers.Serializer):
    provider = serializers.ChoiceField(choices=PROVIDERS)
    model = serializers.CharField(min_length=1, max_length=120)
    region = serializers.CharField(min_length=1, max_length=64)
    endpoint = serializers.CharField(min_length=9, max_length=500)
    credential_mode = serializers.ChoiceField(choices=["sts_role", "managed_key"])
    credential_id = serializers.UUIDField()
    expected_revision = serializers.IntegerField(min_value=0)

    def validate_endpoint(self, value):
        if not value.startswith("https://"):
            raise WorkAPIError("invalid_request")
        return value


class ProviderCredentialCreateSerializer(serializers.Serializer):
    provider = serializers.ChoiceField(choices=PROVIDERS)
    mode = serializers.ChoiceField(choices=["sts_role", "managed_key"])
    role_ref = serializers.CharField(required=False, allow_blank=True, max_length=255)
    api_key = serializers.CharField(
        required=False, allow_blank=False, min_length=8, max_length=4096
    )

    def validate(self, attrs):
        if attrs["mode"] == "managed_key" and not attrs.get("api_key"):
            raise WorkAPIError("invalid_request")
        if attrs["mode"] == "sts_role" and not attrs.get("role_ref"):
            raise WorkAPIError("invalid_request")
        if attrs.get("api_key") and attrs.get("role_ref"):
            raise WorkAPIError("invalid_request")
        return attrs


class ProviderCredentialRotateSerializer(serializers.Serializer):
    api_key = serializers.CharField(min_length=8, max_length=4096)


class ProviderRevokeSerializer(serializers.Serializer):
    reason = serializers.CharField(min_length=1, max_length=500)


class AuditExportCreateSerializer(serializers.Serializer):
    client_request_id = serializers.CharField(min_length=8, max_length=128)
    range_from = serializers.DateTimeField()
    range_to = serializers.DateTimeField()
    format = serializers.ChoiceField(choices=["csv", "json"])


class AuditExportTicketSerializer(serializers.Serializer):
    ttl_seconds = serializers.IntegerField(
        required=False, min_value=60, max_value=900, default=300
    )
