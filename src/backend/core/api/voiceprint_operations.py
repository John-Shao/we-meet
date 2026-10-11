"""Admin-only aggregate operational health, independent of collection switches."""

from django.db import DatabaseError

from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle

from core.api.voiceprint import PrivateVoiceprintView, StrictSerializer
from core.services import voiceprint_operations as service
from core.services.voiceprint_consent import VoiceprintError


class WindowSerializer(StrictSerializer):
    hours = serializers.IntegerField(min_value=1, max_value=168, default=24)


class OperationsThrottle(UserRateThrottle):
    scope = "voiceprint_operations"
    rate = "6/min"


class VoiceprintOperationsView(PrivateVoiceprintView):
    http_method_names = ["get", "options"]
    throttle_classes = [OperationsThrottle]

    def get(self, request, organization_id):
        payload = WindowSerializer(data=request.query_params)
        payload.is_valid(raise_exception=True)
        try:
            result = service.report(
                request.user,
                organization_id=organization_id,
                **payload.validated_data,
            )
        except DatabaseError:
            raise VoiceprintError(
                "voiceprint_operations_unavailable", status=503
            ) from None
        return Response(result)
