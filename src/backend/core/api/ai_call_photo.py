"""Ephemeral photo understanding bound to the caller's live Omni allocation."""

import base64
import binascii
import io
from contextlib import suppress

from django.conf import settings
from django.utils import timezone

from PIL import Image, UnidentifiedImageError
from rest_framework import permissions, serializers, throttling
from rest_framework.response import Response
from rest_framework.views import APIView

from core.models import AIUsageKindChoices, DirectAIAllocation
from core.services import ai_usage
from core.services.assistant_prompts import instruction
from core.services.llm_client import LLMClient, LLMUnavailable

MAX_IMAGE_BYTES = 512_000


class PhotoThrottle(throttling.UserRateThrottle):
    scope = "ai_call_photo"
    rate = "6/min"


class PhotoInputSerializer(serializers.Serializer):
    session_id = serializers.UUIDField()
    question = serializers.CharField(max_length=1000)
    image = serializers.CharField(max_length=684_000, trim_whitespace=False)

    def validate_image(self, value):
        """Only inline, bounded JPEGs; no client-selected URL is ever fetched."""
        try:
            raw = base64.b64decode(value, validate=True)
            if not raw or len(raw) > MAX_IMAGE_BYTES:
                raise ValueError
            with Image.open(io.BytesIO(raw)) as image:
                if (
                    image.format != "JPEG"
                    or max(image.size) > 1920
                    or image.width * image.height > 2_100_000
                ):
                    raise ValueError
                image.verify()
        except (
            ValueError,
            binascii.Error,
            UnidentifiedImageError,
            OSError,
            Image.DecompressionBombError,
        ) as error:
            raise serializers.ValidationError(
                "A JPEG photo within the image limit is required."
            ) from error
        return value


def live_session(user, session_id):
    return DirectAIAllocation.objects.filter(
        pk=session_id,
        user=user,
        status__in=("issued", "active"),
        lease_until__gt=timezone.now(),
        model="qwen3.8-omni-flash-realtime",
    ).exists()


class AiCallPhotoView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [PhotoThrottle]

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "no-store"
        return response

    def post(self, request):
        source = PhotoInputSerializer(data=request.data)
        source.is_valid(raise_exception=True)
        data = source.validated_data
        if not live_session(request.user, data["session_id"]):
            return Response(
                {"detail": "An active call is required."},
                status=409,
                headers={"Cache-Control": "no-store"},
            )
        system = instruction("call.photo_qa")
        client = None
        try:
            client = LLMClient.from_settings(
                timeout=25, max_retries=0, model=settings.AI_CALL_PHOTO_MODEL
            )
            answer = client.chat(
                system=system,
                user=[
                    {"type": "text", "text": data["question"]},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{data['image']}"},
                    },
                ],
                temperature=0.2,
                max_tokens=1024,
                require_complete=True,
                usage_sink=ai_usage.make_sink(
                    user=request.user,
                    kind=AIUsageKindChoices.PERSONAL_AI,
                    ref_type="ai_call_photo",
                    ref_id=str(data["session_id"]),
                ),
            )
            if not answer.strip() or len(answer) > 8000:
                raise ValueError("Invalid answer")
        except LLMUnavailable:
            return Response(
                {"detail": "Photo model is unavailable."},
                status=503,
                headers={"Cache-Control": "no-store"},
            )
        except Exception:  # noqa: BLE001 -- Never return provider errors containing images or questions.
            return Response(
                {"detail": "Unable to answer this photo. Please retry."},
                status=502,
                headers={"Cache-Control": "no-store"},
            )
        finally:
            if client is not None:
                with suppress(Exception):
                    client.close()
        if not live_session(request.user, data["session_id"]):
            return Response(
                {"detail": "Call has ended."},
                status=409,
                headers={"Cache-Control": "no-store"},
            )
        return Response({"answer": answer}, headers={"Cache-Control": "no-store"})
