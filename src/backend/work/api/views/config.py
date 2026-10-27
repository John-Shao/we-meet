"""Provider access configuration and managed credentials (D-08/D-03 B)."""

from rest_framework.response import Response

from work.api.base import WorkAPIView
from work.api.context import fetch_one, require_owner, work_cursor
from work.api.errors import WorkAPIError
from work.api.presenters import credential_view
from work.api.serializers import (
    ProviderConfigSetSerializer,
    ProviderCredentialCreateSerializer,
    ProviderCredentialRotateSerializer,
    ProviderRevokeSerializer,
)
from work.security import credential_cipher


def _credential(cursor, org_id, subject_id, credential_id):
    cursor.execute(
        "SELECT * FROM work.get_provider_credential_view(%s, %s, %s)",
        [org_id, subject_id, str(credential_id)],
    )
    return fetch_one(cursor)


def _config_view(cursor, org_id, subject_id):
    cursor.execute(
        "SELECT * FROM work.get_provider_config(%s, %s)",
        [org_id, subject_id],
    )
    config = fetch_one(cursor)
    if config is None:
        raise WorkAPIError("not_found")
    credential = _credential(cursor, org_id, subject_id, config["credential_id"])
    if credential is None:
        raise WorkAPIError("not_found")
    return {
        "config_id": str(config["config_id"]),
        "revision": config["revision"],
        "provider": config["provider"],
        "model": config["model"],
        "region": config["region"],
        "endpoint": config["endpoint"],
        "credential_mode": config["credential_mode"],
        "credential": credential_view(credential),
        "state": config["state"],
        "created_at": config["created_at"].isoformat(),
    }


class ProviderConfigGetView(WorkAPIView):
    def get(self, request):
        require_owner(request.work_context)
        context = request.work_context
        with work_cursor(context) as cursor:
            payload = _config_view(cursor, context.org_id, context.subject_id)
        return Response(payload)


class ProviderConfigSetView(WorkAPIView):
    def put(self, request):
        require_owner(request.work_context)
        serializer = ProviderConfigSetSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        context = request.work_context
        with work_cursor(context) as cursor:
            cursor.execute(
                "SELECT config_id, revision FROM work.set_provider_config("
                "%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                [
                    context.org_id,
                    context.subject_id,
                    data["provider"],
                    data["model"],
                    data["region"],
                    data["endpoint"],
                    data["credential_mode"],
                    str(data["credential_id"]),
                    data["expected_revision"],
                ],
            )
            payload = _config_view(cursor, context.org_id, context.subject_id)
        return Response(payload)


class ProviderConfigView(ProviderConfigGetView, ProviderConfigSetView):
    pass


class ProviderConfigRevokeView(WorkAPIView):
    def post(self, request):
        require_owner(request.work_context)
        serializer = ProviderRevokeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        context = request.work_context
        with work_cursor(context) as cursor:
            cursor.execute(
                "SELECT work.revoke_provider_config(%s, %s, %s)",
                [
                    context.org_id,
                    context.subject_id,
                    serializer.validated_data["reason"],
                ],
            )
        return Response({"org_id": context.org_id, "state": "revoked"})


class ProviderCredentialCreateView(WorkAPIView):
    def post(self, request):
        require_owner(request.work_context)
        serializer = ProviderCredentialCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        context = request.work_context
        if data["mode"] == "managed_key":
            secret = data["api_key"]
            ciphertext = credential_cipher.encrypt(
                context.org_id, secret.encode("utf-8")
            )
            role_ref = None
            fp = credential_cipher.fingerprint(secret)
        else:
            ciphertext = None
            role_ref = data["role_ref"]
            fp = credential_cipher.fingerprint(role_ref)
        with work_cursor(context) as cursor:
            cursor.execute(
                "SELECT credential_id, key_version FROM "
                "work.create_provider_credential("
                "%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                [
                    context.org_id,
                    context.subject_id,
                    data["provider"],
                    data["mode"],
                    role_ref,
                    ciphertext,
                    None,
                    None,
                    fp,
                ],
            )
            credential_id, _ = cursor.fetchone()
            credential = _credential(
                cursor, context.org_id, context.subject_id, credential_id
            )
        return Response(credential_view(credential), status=201)


class ProviderCredentialRotateView(WorkAPIView):
    def post(self, request, credential_id):
        require_owner(request.work_context)
        serializer = ProviderCredentialRotateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        secret = serializer.validated_data["api_key"]
        context = request.work_context
        with work_cursor(context) as cursor:
            cursor.execute(
                "SELECT work.rotate_provider_credential(%s, %s, %s, %s, %s, %s, %s)",
                [
                    context.org_id,
                    context.subject_id,
                    str(credential_id),
                    credential_cipher.encrypt(context.org_id, secret.encode("utf-8")),
                    None,
                    None,
                    credential_cipher.fingerprint(secret),
                ],
            )
            credential = _credential(
                cursor, context.org_id, context.subject_id, credential_id
            )
        if credential is None:
            raise WorkAPIError("not_found")
        return Response(credential_view(credential))


class ProviderCredentialRevokeView(WorkAPIView):
    def post(self, request, credential_id):
        require_owner(request.work_context)
        serializer = ProviderRevokeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        context = request.work_context
        with work_cursor(context) as cursor:
            cursor.execute(
                "SELECT work.revoke_provider_credential(%s, %s, %s, %s)",
                [
                    context.org_id,
                    context.subject_id,
                    str(credential_id),
                    serializer.validated_data["reason"],
                ],
            )
        return Response({"credential_id": str(credential_id), "state": "revoked"})
