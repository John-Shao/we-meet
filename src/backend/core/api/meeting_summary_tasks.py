"""Confirm reviewed actions as tasks under current record and directory permissions."""

from django.db import IntegrityError
from django.shortcuts import get_object_or_404

from rest_framework import permissions, serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from core import models
from core.services import meeting_summary_tasks as service
from core.services.meeting_records import RecordConflict, visible_records
from core.services.tasks import task_organization_for_user


class ConversionSerializer(serializers.Serializer):
    """Explicit assignment and date, never parsed from AI labels."""

    key = serializers.UUIDField()
    review_id = serializers.UUIDField()
    action_index = serializers.IntegerField(min_value=0, max_value=99)
    title = serializers.CharField(max_length=4000)
    assignee_id = serializers.UUIDField()
    due_date = serializers.DateField(allow_null=True)

    def validate(self, attrs):
        if set(self.initial_data) - set(self.fields):
            raise serializers.ValidationError("Unsupported task conversion field.")
        for name in ("review_id", "assignee_id"):
            attrs[name] = str(attrs[name])
        if attrs["due_date"]:
            attrs["due_date"] = attrs["due_date"].isoformat()
        return attrs


class SummaryTaskView(APIView):
    """A separate explicit action; reading or saving a summary never creates tasks."""

    permission_classes = [permissions.IsAuthenticated]

    def record(self, request, record_id):
        return get_object_or_404(
            visible_records(request.user, ability="read_summary"), pk=record_id
        )

    def get(self, request, record_id):
        record = self.record(request, record_id)
        current = record.summary_reviews.first()
        fingerprints = (
            [service.action_hash(point) for point in current.content["action_items"]]
            if current
            else []
        )
        links = {
            link.action_hash: link
            for link in record.summary_task_links.filter(action_hash__in=fingerprints)
        }
        allowed = service.can_convert(record, request.user)
        candidates = []
        if allowed:
            organization = task_organization_for_user(request.user)
            users = models.User.objects.filter(pk=request.user.pk)
            if organization:
                users = (
                    models.User.objects.filter(
                        memberships__organization=organization,
                        memberships__status=models.MembershipStatusChoices.ACTIVE,
                        memberships__is_primary=True,
                        is_active=True,
                        is_device=False,
                    )
                    .exclude(sub__isnull=True)
                    .exclude(sub="")
                )
            search = (request.query_params.get("q") or "").strip()[:100]
            if search:
                users = users.filter(full_name__icontains=search)
            candidates = [
                {
                    "id": str(user.pk),
                    "name": user.full_name or user.short_name or str(user.pk),
                }
                for user in users.order_by("full_name", "pk")[:50]
            ]
        return Response(
            {
                "can_convert": allowed,
                "review_id": str(current.pk) if current else None,
                "assignees": candidates,
                "actions": [
                    service.serialize(links[service.action_hash(point)], request.user)
                    if service.action_hash(point) in links
                    else None
                    for point in current.content["action_items"]
                ]
                if current
                else [],
            }
        )

    def post(self, request, record_id):
        record = self.record(request, record_id)
        serializer = ConversionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        payload = serializer.validated_data
        key = payload.pop("key")
        try:
            link, created = service.convert(record.pk, request.user, key, payload)
        except PermissionError:
            return Response(status=403)
        except (RecordConflict, IntegrityError):
            return Response({"detail": "Task conversion conflicts."}, status=409)
        except ValueError:
            return Response({"detail": "Invalid task or assignment."}, status=400)
        return Response(
            {"link": service.serialize(link, request.user), "created": created}
        )
