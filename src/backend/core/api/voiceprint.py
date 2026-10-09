"""Personal voiceprint controls; no endpoint serializes biometric ciphertext."""

from django.db.models import BooleanField, Case, F, Value, When
from django.http import HttpResponse

from rest_framework import permissions, serializers
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from core import models
from core.services import voiceprint_consent as service
from core.services import voiceprint_enrollment as enrollment_service
from core.services.voiceprint_crypto import VoiceprintCryptoError
from core.services.voiceprint_encoder import MAX_AUDIO_BYTES


class StrictBoolean(serializers.BooleanField):
    def to_internal_value(self, data):
        if type(data) is not bool:
            self.fail("invalid")
        return data


class StrictVersion(serializers.IntegerField):
    def to_internal_value(self, data):
        if type(data) is not int:
            self.fail("invalid")
        return super().to_internal_value(data)


class StrictSerializer(serializers.Serializer):
    def validate(self, attrs):
        if set(self.initial_data) - set(self.fields):
            raise serializers.ValidationError("Unexpected fields.")
        return attrs


class ScopeSerializer(StrictSerializer):
    organization_id = serializers.UUIDField(
        required=False, allow_null=True, default=None
    )


class SettingsSerializer(StrictSerializer):
    organization_id = serializers.UUIDField(allow_null=True)
    expected_version = StrictVersion(min_value=0)
    allow_enrollment = StrictBoolean(required=False)
    allow_accumulation = StrictBoolean(required=False)
    allow_identification = StrictBoolean(required=False)

    def validate(self, attrs):
        attrs = super().validate(attrs)
        if not any(name in attrs for name in service.PERMISSIONS):
            raise serializers.ValidationError("Select at least one permission.")
        return attrs


class DeleteSerializer(StrictSerializer):
    expected_version = StrictVersion(min_value=1)
    request_key = serializers.UUIDField()


class OrganizationPolicySerializer(StrictSerializer):
    expected_version = StrictVersion(min_value=0)
    enabled = StrictBoolean()


class SettingsThrottle(UserRateThrottle):
    scope = "voiceprint_settings"
    rate = "60/min"


class PrivateVoiceprintView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        service.owner(request.user)

    def handle_exception(self, exc):
        if isinstance(exc, VoiceprintCryptoError):
            return Response({"code": "voiceprint_key_unavailable"}, status=503)
        if isinstance(exc, service.VoiceprintError):
            return Response({"code": str(exc)}, status=exc.status)
        return super().handle_exception(exc)

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "private, no-store"
        return response


class VoiceprintSettingsView(PrivateVoiceprintView):
    throttle_classes = [SettingsThrottle]
    http_method_names = ["get", "patch", "options"]

    def get(self, request):
        payload = ScopeSerializer(data=request.query_params)
        payload.is_valid(raise_exception=True)
        return Response(service.read_settings(request.user, **payload.validated_data))

    def patch(self, request):
        payload = SettingsSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = payload.validated_data
        return Response(
            service.update_settings(
                request.user,
                organization_id=data["organization_id"],
                expected_version=data["expected_version"],
                changes={
                    name: data[name] for name in service.PERMISSIONS if name in data
                },
            )
        )


class VoiceprintProfileView(PrivateVoiceprintView):
    http_method_names = ["delete", "options"]

    def delete(self, request, profile_id):
        payload = DeleteSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        job = service.delete_profile(
            request.user, profile_id=profile_id, **payload.validated_data
        )
        return Response(service.deletion_snapshot(job), status=202)


class VoiceprintDeletionView(PrivateVoiceprintView):
    http_method_names = ["get", "options"]

    def get(self, request, job_id):
        job = models.VoiceprintDeletionJob.objects.filter(
            pk=job_id, owner_id=request.user.pk
        ).first()
        if job is None:
            raise service.VoiceprintError("voiceprint_deletion_unavailable", status=404)
        return Response(service.deletion_snapshot(job))


class VoiceprintOrganizationPolicyView(PrivateVoiceprintView):
    http_method_names = ["get", "patch", "options"]

    def get(self, request, organization_id):
        organization = models.Organization.objects.filter(
            pk=organization_id, is_active=True
        ).first()
        if (
            organization is None
            or not models.Membership.objects.filter(
                user=request.user,
                organization=organization,
                status=models.MembershipStatusChoices.ACTIVE,
                org_role__in=[models.OrgRoleChoices.ADMIN, models.OrgRoleChoices.OWNER],
            ).exists()
        ):
            raise service.VoiceprintError("voiceprint_organization_admin_required")
        return Response(service.organization_policy(organization))

    def patch(self, request, organization_id):
        payload = OrganizationPolicySerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        return Response(
            service.update_organization_policy(
                request.user,
                organization_id,
                **payload.validated_data,
            )
        )


class EnrollmentSerializer(StrictSerializer):
    organization_id = serializers.UUIDField(allow_null=True)
    expected_version = StrictVersion(min_value=1)
    request_key = serializers.UUIDField()
    locale = serializers.ChoiceField(
        choices=list(enrollment_service.PROMPTS), default="en"
    )


class SampleListSerializer(ScopeSerializer):
    offset = serializers.IntegerField(min_value=0, max_value=10000, default=0)


class SampleDecisionSerializer(StrictSerializer):
    expected_version = StrictVersion(min_value=1)
    accepted = StrictBoolean()


class EnrollmentThrottle(UserRateThrottle):
    scope = "voiceprint_enrollment"
    rate = "30/min"


class VoiceprintEnrollmentsView(PrivateVoiceprintView):
    throttle_classes = [EnrollmentThrottle]
    http_method_names = ["post", "options"]

    def post(self, request):
        payload = EnrollmentSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        row = enrollment_service.begin(request.user, **payload.validated_data)
        return Response(enrollment_service.enrollment_snapshot(row), status=201)


class VoiceprintEnrollmentView(PrivateVoiceprintView):
    http_method_names = ["get", "options"]

    def get(self, request, enrollment_id):
        row = models.VoiceprintEnrollment.objects.filter(
            pk=enrollment_id, owner_id=request.user.pk
        ).first()
        if row is None:
            raise service.VoiceprintError(
                "voiceprint_enrollment_unavailable", status=404
            )
        return Response(enrollment_service.enrollment_snapshot(row))


class VoiceprintEnrollmentClipView(PrivateVoiceprintView):
    throttle_classes = [EnrollmentThrottle]
    http_method_names = ["put", "options"]
    parser_classes = []

    def put(self, request, enrollment_id, slot):
        if request.content_type != "audio/wav":
            raise service.VoiceprintError("voiceprint_content_type_invalid", status=415)
        raw_length = request.headers.get("Content-Length")
        if raw_length is None:
            raise service.VoiceprintError("voiceprint_length_required", status=411)
        try:
            if (
                not raw_length.isascii()
                or not raw_length.isdecimal()
                or len(raw_length) > 6
            ):
                raise ValueError
            length = int(raw_length)
        except ValueError:
            raise service.VoiceprintError(
                "voiceprint_audio_size_invalid", status=413
            ) from None
        if not 1 <= length <= MAX_AUDIO_BYTES:
            raise service.VoiceprintError("voiceprint_audio_size_invalid", status=413)
        # Do not invoke DRF multipart/JSON parsers or accept an audio URL. The
        # ingress host must also enforce upload timeouts and body limits.
        body = request.stream.read(length + 1)
        if len(body) != length:
            raise service.VoiceprintError("voiceprint_audio_size_invalid", status=413)
        row = enrollment_service.upload(
            request.user,
            enrollment_id=enrollment_id,
            slot=slot,
            token=request.headers.get("X-Voiceprint-Upload-Token", ""),
            wav=body,
        )
        return Response(enrollment_service.sample_snapshot(row), status=202)


class VoiceprintSamplesView(PrivateVoiceprintView):
    http_method_names = ["get", "options"]

    def get(self, request):
        payload = SampleListSerializer(data=request.query_params)
        payload.is_valid(raise_exception=True)
        data = payload.validated_data
        organization = service.scope(
            service.owner(request.user), data["organization_id"]
        )
        rows = (
            models.VoiceprintSample.objects.filter(
                profile__consent__user=request.user,
                profile__consent__organization=organization,
                generation=F("profile__consent__generation"),
                profile__generation=F("generation"),
            )
            .exclude(profile__status="deleted")
            .select_related("enrollment")
            .annotate(
                audio_present=Case(
                    When(encrypted_audio=b"", then=Value(False)),
                    default=Value(True),
                    output_field=BooleanField(),
                ),
                embedding_present=Case(
                    When(encrypted_embedding=b"", then=Value(False)),
                    default=Value(True),
                    output_field=BooleanField(),
                ),
            )
            .defer("encrypted_audio", "encrypted_embedding")
            .order_by("-created_at", "id")
        )
        offset = data["offset"]
        page = list(rows[offset : offset + 26])
        return Response(
            {
                "results": [
                    enrollment_service.sample_snapshot(row) for row in page[:25]
                ],
                "next_offset": offset + 25
                if len(page) > 25 and offset + 25 <= 10000
                else None,
            }
        )


class VoiceprintSampleAudioView(PrivateVoiceprintView):
    throttle_classes = [EnrollmentThrottle]
    http_method_names = ["get", "options"]

    def get(self, request, sample_id):
        audio = enrollment_service.sample_audio(request.user, sample_id)
        response = HttpResponse(audio, content_type="audio/wav")
        response["Content-Disposition"] = 'inline; filename="voice-sample.wav"'
        response["X-Content-Type-Options"] = "nosniff"
        return response


class VoiceprintSampleDecisionView(PrivateVoiceprintView):
    throttle_classes = [EnrollmentThrottle]
    http_method_names = ["post", "options"]

    def post(self, request, sample_id):
        payload = SampleDecisionSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        row = enrollment_service.decide(
            request.user, sample_id, **payload.validated_data
        )
        return Response(enrollment_service.sample_snapshot(row))
