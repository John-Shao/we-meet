"""Resumable chunked uploads: open, sign parts, resume, complete, abort.

Separate from `DirectUploadBase` on purpose, and for a measured reason: that
class carries `UploadThrottle` at 6 requests per minute per user. A 6 GiB import
at 64 MiB per part is ~96 parts, so signing one part per request could not
finish inside that budget even though the bytes themselves never touch us. The
endpoints here get their own scope and a batch signing call, so a large import
costs a handful of requests rather than one per part.
"""

from django.http import Http404

from rest_framework import permissions, serializers
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from core.services import recording_upload_sessions as sessions
from core.services import uploaded_recordings as service
from core.services.meeting_records import RecordConflict
from core.services.uploaded_recordings import parse_hotwords


class MultipartThrottle(UserRateThrottle):
    """Own budget: a 6 GiB import is ~96 parts, batched into few requests.

    30/min leaves room for a batch of part requests, a resume poll, and a retry,
    without letting one account churn storage on a loop.
    """

    scope = "recording_multipart_upload"
    rate = "30/min"


class MultipartReadThrottle(UserRateThrottle):
    """Resuming polls; must not eat the write budget."""

    scope = "recording_multipart_read"
    rate = "60/min"


class BeginSerializer(serializers.Serializer):
    """Declare exactly what is about to be uploaded, before any byte moves."""

    key = serializers.UUIDField()
    name = serializers.CharField(max_length=255)
    size = serializers.IntegerField(min_value=1)
    content_type = serializers.CharField(max_length=128)
    context = serializers.CharField(max_length=400, allow_blank=True, default="")
    hotwords = serializers.CharField(max_length=4000, allow_blank=True, default="")
    diarization = serializers.BooleanField(default=False)

    def validate_hotwords(self, value):
        try:
            return parse_hotwords(value)
        except ValueError as error:
            raise serializers.ValidationError(str(error)) from error

    def validate(self, attrs):
        if set(self.initial_data) - set(self.fields):
            raise serializers.ValidationError("Unsupported upload field.")
        return attrs


class SignSerializer(serializers.Serializer):
    """Which parts to sign. Bounded so one call cannot enumerate forever."""

    parts = serializers.ListField(
        child=serializers.IntegerField(min_value=1, max_value=sessions.MAX_PARTS),
        min_length=1,
        max_length=sessions.MAX_PARTS_PER_SIGNING,
    )

    def validate_parts(self, value):
        if len(set(value)) != len(value):
            raise serializers.ValidationError("Ask for each part once.")
        return value


class PartSerializer(serializers.Serializer):
    part_number = serializers.IntegerField(min_value=1)
    etag = serializers.CharField(max_length=128)


class CompleteSerializer(serializers.Serializer):
    """The ETags the client saw. The set is still cross-checked against storage."""

    parts = PartSerializer(many=True, allow_empty=True)


class MultipartBase(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [MultipartThrottle]

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "private, no-store"
        return response

    def handle_errors(self, action):
        try:
            return action()
        except PermissionError:
            return Response({"code": "direct_upload_unavailable"}, status=503)
        except RecordConflict:
            return Response({"code": "transcription_conflict"}, status=409)
        except LookupError:
            raise Http404 from None
        except ValueError as error:
            return Response({"code": str(error) or "invalid_upload"}, status=400)


class MultipartBeginView(MultipartBase):
    """Open an upload, or hand back the plan for one already open."""

    def post(self, request):
        payload = BeginSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = dict(payload.validated_data)
        options = {
            "context": data.pop("context"),
            "hotwords": data.pop("hotwords"),
            "diarization": data.pop("diarization"),
        }

        def action():
            result = sessions.begin(request.user, **data, options=options)
            session, uploaded = result
            # A resumed or replayed `begin` may hand back a finished job, which
            # has no session to describe.
            if hasattr(session, "storage_name") and hasattr(session, "part_size"):
                return Response(sessions.serialize_session(session, uploaded))
            return Response({"job": service.serialize(session)}, status=202)

        return self.handle_errors(action)


class MultipartPartsView(MultipartBase):
    """Sign a batch of part PUTs.

    The PUTs themselves go straight to storage, so they never reach this app and
    never consume this budget.
    """

    def post(self, request, session_id):
        payload = SignSerializer(data=request.data)
        payload.is_valid(raise_exception=True)

        def action():
            session, signed = sessions.sign_parts(
                request.user, session_id, payload.validated_data["parts"]
            )
            uploaded = sessions._parts_for(session)  # noqa: SLF001
            return Response(
                {
                    **sessions.serialize_session(session, uploaded),
                    "parts": signed,
                }
            )

        return self.handle_errors(action)


class MultipartSessionView(MultipartBase):
    """What storage already holds, so a client can skip finished parts."""

    def get_throttles(self):
        return [
            MultipartReadThrottle()
            if self.request.method == "GET"
            else MultipartThrottle()
        ]

    def get(self, request, session_id):
        def action():
            session, uploaded = sessions.resume(request.user, session_id)
            return Response(sessions.serialize_session(session, uploaded))

        return self.handle_errors(action)

    def post(self, request, session_id):
        """Complete the upload and adopt the object."""
        payload = CompleteSerializer(data=request.data)
        payload.is_valid(raise_exception=True)

        def action():
            job = sessions.complete(
                request.user, session_id, payload.validated_data["parts"]
            )
            return Response(service.serialize(job), status=202)

        return self.handle_errors(action)

    def delete(self, request, session_id):
        """Abort. Not merely tidiness: storage bills incomplete parts."""

        def action():
            sessions.abort(request.user, session_id)
            return Response(status=204)

        return self.handle_errors(action)
