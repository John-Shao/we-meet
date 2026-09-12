"""Authorized human summary reads and append-only optimistic edits."""

from django.core.exceptions import ValidationError as ModelValidationError
from django.db import IntegrityError
from django.shortcuts import get_object_or_404

from rest_framework import permissions, serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from core.services import meeting_summary_review as service
from core.services.meeting_records import RecordConflict, visible_records


class ReviewSerializer(serializers.Serializer):
    """An explicit human revision; no model request or notification side effects."""

    key = serializers.UUIDField()
    base_summary_id = serializers.UUIDField()
    expected_revision = serializers.IntegerField(min_value=0)
    replace_base = serializers.BooleanField()
    content = serializers.JSONField()

    def validate(self, attrs):
        if set(self.initial_data) - set(self.fields):
            raise serializers.ValidationError("Unsupported human review field.")
        attrs["base_summary_id"] = str(attrs["base_summary_id"])
        return attrs


class SummaryReviewView(APIView):
    """Share-summary permission permits reading but never creating human revisions."""

    permission_classes = [permissions.IsAuthenticated]

    def record(self, request, record_id):
        return get_object_or_404(
            visible_records(request.user, ability="read_summary"), pk=record_id
        )

    def get(self, request, record_id):
        record = self.record(request, record_id)
        return Response(
            {
                "current": service.serialize(record.summary_reviews.first()),
                "can_edit": service.can_edit(record, request.user),
            }
        )

    def post(self, request, record_id):
        record = self.record(request, record_id)
        serializer = ReviewSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        key = data.pop("key")
        try:
            saved, current, replayed = service.save_review(
                record.pk, request.user, key, data
            )
        except PermissionError:
            return Response(status=403)
        except (RecordConflict, IntegrityError, ModelValidationError):
            return Response({"detail": "Human summary revision conflicts."}, status=409)
        except ValueError:
            return Response(
                {"detail": "Invalid summary structure or citations."}, status=400
            )
        return Response(
            {
                "saved": service.serialize(saved),
                "current": service.serialize(current),
                "replayed": replayed,
            }
        )
