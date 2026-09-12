"""Private idempotent questions; source permissions checked for requests and responses."""

from django.db import IntegrityError
from django.shortcuts import get_object_or_404

from rest_framework import permissions, serializers
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from core import models
from core.services import meeting_record_qa as service
from core.services.meeting_records import RecordConflict, visible_records


class QuestionThrottle(UserRateThrottle):
    """Bound explicit paid intents independently of summary generation."""

    scope = "record_questions"
    rate = "6/min"


class QuestionSerializer(serializers.Serializer):
    """Callers select an immutable source explicitly, not a room's latest contents."""

    key = serializers.UUIDField()
    snapshot_id = serializers.UUIDField()
    question = serializers.CharField(min_length=1, max_length=2000)

    def validate(self, attrs):
        if set(self.initial_data) - set(self.fields):
            raise serializers.ValidationError("Unsupported question field.")
        attrs["snapshot_id"] = str(attrs["snapshot_id"])
        return attrs


class RecordQuestionView(APIView):
    """Each user can only retrieve their own questions under current source access."""

    permission_classes = [permissions.IsAuthenticated]

    def get_throttles(self):
        return [QuestionThrottle()] if self.request.method == "POST" else []

    def record(self, request, record_id):
        return get_object_or_404(
            visible_records(request.user, ability="read_transcript"), pk=record_id
        )

    def get(self, request, record_id, question_id=None):
        self.record(request, record_id)
        if question_id is None:
            recent = models.MeetingRecordQuestion.objects.filter(
                record_id=record_id, requested_by=request.user
            ).order_by("-created_at", "-id")[:10]
            return Response(
                {
                    "available": service.available(),
                    "recent": [
                        service.serialize(service.expire(query)) for query in recent
                    ],
                }
            )
        query = get_object_or_404(
            models.MeetingRecordQuestion,
            pk=question_id,
            record_id=record_id,
            requested_by=request.user,
        )
        return Response(service.serialize(service.expire(query)))

    def post(self, request, record_id, question_id=None):
        if question_id is not None:
            return Response(status=405)
        record = self.record(request, record_id)
        serializer = QuestionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        payload = serializer.validated_data
        key = payload.pop("key")
        try:
            query, created = service.prepare(record.pk, request.user, key, payload)
        except PermissionError:
            return Response(status=403)
        except (RecordConflict, IntegrityError):
            return Response({"detail": "Question request conflicts."}, status=409)
        except ValueError:
            return Response(
                {"detail": "Source exceeds the question input budget."}, status=400
            )
        if created:
            query = service.execute(query.pk)
        # Do not release a previously accepted answer after access was revoked.
        self.record(request, record_id)
        return Response(service.serialize(query))
