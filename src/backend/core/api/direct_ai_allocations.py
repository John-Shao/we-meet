"""Owner-only lifecycle for app-declared direct model sessions."""

from rest_framework import permissions, serializers, throttling
from rest_framework.exceptions import NotFound
from rest_framework.response import Response
from rest_framework.views import APIView

from core import models
from core.services import direct_ai_allocations


class OperationSerializer(serializers.Serializer):
    operation = serializers.ChoiceField(choices=("heartbeat", "close"))


class LeaseThrottle(throttling.UserRateThrottle):
    scope = "direct-ai-lease"
    rate = "120/min"


class DirectAIAllocationView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [LeaseThrottle]

    def post(self, request, allocation_id):
        serializer = OperationSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            status = direct_ai_allocations.update(request.user, allocation_id, serializer.validated_data["operation"])
        except models.DirectAIAllocation.DoesNotExist as error:
            raise NotFound from error
        return Response({"status": status}, status=410 if status == "expired" else 200,
                        headers={"Cache-Control": "no-store"})
