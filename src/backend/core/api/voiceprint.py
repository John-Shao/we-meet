"""Personal voiceprint controls; no endpoint serializes biometric ciphertext."""

from rest_framework import permissions, serializers
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework.views import APIView

from core import models
from core.services import voiceprint_consent as service


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
