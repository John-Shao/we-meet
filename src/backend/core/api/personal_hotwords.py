"""Account-private vocabulary, explicitly copied by the client into an upload."""

from django.conf import settings
from django.db import transaction
from django.http import Http404
from django.shortcuts import get_object_or_404

from rest_framework import permissions, serializers
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from core import models
from core.services.hotwords import parse_hotwords


class VocabularySerializer(serializers.Serializer):
    """A blank vocabulary clears the library, not any existing upload hints."""

    text = serializers.CharField(
        max_length=4000, allow_blank=True, trim_whitespace=False
    )
    expected_revision = serializers.IntegerField(min_value=0)

    def validate(self, attrs):
        if set(self.initial_data) != {"text", "expected_revision"}:
            raise serializers.ValidationError("Unexpected fields.")
        return attrs

    def validate_text(self, value):
        try:
            return parse_hotwords(value)
        except ValueError as error:
            raise serializers.ValidationError(str(error)) from error


class VocabularyThrottle(UserRateThrottle):
    scope = "personal_hotwords"
    rate = "30/min"


class PersonalHotwordsView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [VocabularyThrottle]
    http_method_names = ["get", "put", "options"]

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        if not settings.MEETING_RECORDS_ENABLED:
            raise Http404
        get_object_or_404(models.User, pk=request.user.pk, is_active=True)

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "private, no-store"
        return response

    @staticmethod
    def serialize(row):
        return {
            "words": row.words if row else [],
            "revision": row.revision if row else 0,
        }

    def get(self, request):
        # Reads never create a profile, and no URL or body can select another owner.
        return Response(
            self.serialize(
                models.PersonalHotwords.objects.filter(user=request.user).first()
            )
        )

    @transaction.atomic
    def put(self, request):
        payload = VocabularySerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        owner = get_object_or_404(
            models.User.objects.select_for_update(), pk=request.user.pk, is_active=True
        )
        row = models.PersonalHotwords.objects.filter(user=owner).first()
        revision = row.revision if row else 0
        words = payload.validated_data["text"]
        expected = payload.validated_data["expected_revision"]
        # One-step replay permits a lost response without overriding a subsequent edit.
        if expected != revision:
            if row and expected + 1 == revision and words == row.words:
                return Response(self.serialize(row))
            return Response({"code": "hotwords_changed"}, status=409)
        if row is None and not words:
            return Response(self.serialize(None))
        if row is None:
            row = models.PersonalHotwords.objects.create(user=owner, words=words)
        elif words != row.words:
            row.words = words
            row.revision += 1
            row.save(update_fields=["words", "revision", "updated_at"])
        return Response(self.serialize(row))
