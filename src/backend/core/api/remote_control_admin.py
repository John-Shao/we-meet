"""Owner/administrator remote-control policy endpoints."""

from rest_framework import serializers
from rest_framework.response import Response

from core.api.remote_control import RemoteControlView, StrictSerializer
from core.services import remote_control_admin as service
from core.services.remote_control_livekit import RemoteControlError


class PolicyWriteSerializer(StrictSerializer):
    version = serializers.RegexField(r"^[0-9a-f]{64}$")
    policy = serializers.JSONField()


class CandidateQuerySerializer(StrictSerializer):
    q = serializers.CharField(max_length=100, required=False, allow_blank=True)
    after = serializers.UUIDField(required=False)


class RemoteControlAdminView(RemoteControlView):
    def get(self, request, operation="policy"):
        if operation == "policy":
            return Response(service.read_policy(request.user))
        if operation == "members":
            query = CandidateQuerySerializer(data=request.query_params)
            query.is_valid(raise_exception=True)
            return Response(
                service.candidates(
                    request.user,
                    query=query.validated_data.get("q", ""),
                    after=query.validated_data.get("after"),
                )
            )
        return Response(status=405)

    def put(self, request, operation="policy"):
        if operation != "policy":
            return Response(status=405)
        if len(request.body) > 16384:
            raise RemoteControlError("request_too_large", 413)
        data = PolicyWriteSerializer(data=request.data)
        data.is_valid(raise_exception=True)
        return Response(
            service.update_policy(
                request.user,
                value=data.validated_data["policy"],
                version=data.validated_data["version"],
            )
        )

    def post(self, request, operation="policy"):
        if operation != "emergency-close":
            return Response(status=405)
        if len(request.body) > 1024:
            raise RemoteControlError("request_too_large", 413)
        body = StrictSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        return Response(service.update_policy(request.user, emergency=True))
