"""Human-account-only HTTP control plane; no operating-system input endpoint."""

from django.conf import settings
from django.utils import timezone

from rest_framework import permissions, serializers, throttling
from rest_framework.response import Response
from rest_framework.views import APIView

from core.services import remote_control as service
from core.services import remote_control_crypto as crypto
from core.services.remote_control_livekit import RemoteControlError


class HumanAccount(permissions.BasePermission):
    def has_permission(self, request, view):
        user = request.user
        return bool(
            user
            and user.is_authenticated
            and user.is_active
            and user.sub
            and not user.is_device
        )


class RemoteControlThrottle(throttling.UserRateThrottle):
    scope = "remote-control"
    rate = "180/min"


class StrictSerializer(serializers.Serializer):
    def to_internal_value(self, data):
        if not isinstance(data, dict) or set(data) - set(self.fields):
            raise serializers.ValidationError({"code": "invalid_fields"})
        return super().to_internal_value(data)


class PresenceSerializer(StrictSerializer):
    roomSid = serializers.RegexField(r"^RM_[A-Za-z0-9_-]{1,100}$")
    participantSid = serializers.RegexField(r"^PA_[A-Za-z0-9_-]{1,100}$")
    deviceSessionId = serializers.UUIDField()
    canControl = serializers.BooleanField()
    canBeControlled = serializers.BooleanField()
    protocolVersions = serializers.ListField(
        child=serializers.IntegerField(min_value=1, max_value=1),
        min_length=1,
        max_length=1,
    )
    platform = serializers.ChoiceField(choices=("win32", "pc-web"))
    helperVersion = serializers.RegexField(
        r"^[A-Za-z0-9._-]{0,32}$", allow_blank=True, default=""
    )


class RequestSerializer(StrictSerializer):
    requestId = serializers.UUIDField()
    roomSid = serializers.RegexField(r"^RM_[A-Za-z0-9_-]{1,100}$")
    controllerSid = serializers.RegexField(r"^PA_[A-Za-z0-9_-]{1,100}$")
    targetSid = serializers.RegexField(r"^PA_[A-Za-z0-9_-]{1,100}$")
    targetUserId = serializers.UUIDField()
    controllerPublicKey = serializers.JSONField()


class ChallengeSerializer(StrictSerializer):
    purpose = serializers.ChoiceField(choices=tuple(service.PROOF_STATES))
    stateVersion = serializers.IntegerField(min_value=1, max_value=2**31 - 1)
    binding = serializers.JSONField(required=False)


class ProofSerializer(StrictSerializer):
    challengeId = serializers.UUIDField()
    signature = serializers.RegexField(r"^[A-Za-z0-9_-]{86}$")


class ActionSerializer(StrictSerializer):
    stateVersion = serializers.IntegerField(min_value=1, max_value=2**31 - 1)


class AuditQuerySerializer(StrictSerializer):
    after = serializers.UUIDField(required=False)
    limit = serializers.IntegerField(min_value=1, max_value=200, default=100)


def public_signing_key():
    key = (
        crypto.signing_key(settings.REMOTE_CONTROL_SIGNING_KEY)
        .public_key()
        .public_numbers()
    )
    return {
        "kid": settings.REMOTE_CONTROL_SIGNING_KID,
        "alg": "ES256",
        "kty": "EC",
        "crv": "P-256",
        "x": crypto.encode64(key.x.to_bytes(32, "big")),
        "y": crypto.encode64(key.y.to_bytes(32, "big")),
    }


class RemoteControlView(APIView):
    # Use existing OIDC/session authentication. Do not interpret the desktop's
    # OIDC Bearer as a LiveKit room token, nor grant API rights to anonymous joins.
    permission_classes = [HumanAccount]
    throttle_classes = [RemoteControlThrottle]

    def handle_exception(self, exc):
        if isinstance(exc, RemoteControlError):
            return Response(
                {"code": exc.code},
                status=exc.status,
                headers={"Cache-Control": "no-store"},
            )
        if isinstance(exc, crypto.InvalidProof):
            if str(exc) == "signing_key_unavailable":
                return Response({"code": "signing_unavailable"}, status=503)
            return Response(
                {"code": "invalid_proof"},
                status=400,
                headers={"Cache-Control": "no-store"},
            )
        return super().handle_exception(exc)

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "private, no-store"
        if isinstance(response.data, dict):
            # A replayed receipt contains its original session timestamp. Always
            # supply a fresh, trusted response clock for monotonic lease budgets.
            response.data = {
                **response.data,
                "serverTime": int(timezone.now().timestamp()),
            }
        return response

    def get(self, request, room_id, operation="session", session_id=None):
        if operation == "capabilities":
            data = service.list_presence(room_id, request.user)
            if data["enabled"]:
                data["signingKey"] = public_signing_key()
            return Response(data)
        if operation == "requests":
            return Response({"sessions": service.list_requests(room_id, request.user)})
        if operation == "session":
            return Response(service.get_session(room_id, session_id, request.user))
        if operation == "audit":
            query = AuditQuerySerializer(data=request.query_params)
            query.is_valid(raise_exception=True)
            return Response(
                service.audit_history(
                    room_id, session_id, request.user, **query.validated_data
                )
            )
        return Response(status=405)

    def post(self, request, room_id, operation="session", session_id=None):
        if len(request.body) > 16384:
            raise RemoteControlError("request_too_large", 413)
        serializers_by_operation = {
            "capabilities": PresenceSerializer,
            "requests": RequestSerializer,
            "authorization-challenge": ChallengeSerializer,
            **dict.fromkeys(service.PROOF_STATES, ProofSerializer),
            **dict.fromkeys(("reject", "cancel", "pause", "end"), ActionSerializer),
        }
        serializer_type = serializers_by_operation.get(operation)
        if serializer_type is None:
            return Response(status=405)
        serializer = serializer_type(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        if operation == "capabilities":
            result = service.publish_presence(room_id, request.user, data)
        elif operation == "requests":
            result = service.create_request(room_id, request.user, data)
        elif operation == "authorization-challenge":
            result = service.challenge(room_id, session_id, request.user, data)
        elif operation in service.PROOF_STATES:
            result = service.prove(room_id, session_id, request.user, operation, data)
        else:
            result = service.action(
                room_id, session_id, request.user, operation, data["stateVersion"]
            )
        return Response(result)
