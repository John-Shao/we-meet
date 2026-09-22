"""Independent collaboration endpoints for records and minutes."""

from django.conf import settings
from django.http import Http404
from django.shortcuts import get_object_or_404

from rest_framework import permissions, serializers
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response
from rest_framework.views import APIView

from core import models, utils
from core.services import meeting_collaboration as service
from core.services.meeting_records import RecordConflict, visible_records
from core.services.meeting_summary_sharing import eligible_users

# One page of candidates == one page of the shared picker.
CANDIDATES_PAGE = 50


class Member(serializers.Serializer):
    id = serializers.RegexField(
        r"^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:dept|group):[0-9a-f]{32})$"
    )
    role = serializers.ChoiceField(choices=sorted(service.ROLES), default="reader")


class Change(serializers.Serializer):
    operation = serializers.ChoiceField(
        choices=["invite", "role", "remove", "transfer", "link"]
    )
    expected_revision = serializers.IntegerField(min_value=0)
    members = Member(many=True, required=False)
    link_scope = serializers.ChoiceField(
        choices=["private", "organization"], required=False
    )
    notify = serializers.BooleanField(required=False)
    note = serializers.CharField(max_length=1000, allow_blank=True, required=False)

    def validate(self, attrs):
        if set(self.initial_data) - set(self.fields):
            raise serializers.ValidationError("Unsupported fields.")
        members = attrs.get("members", [])
        if attrs["operation"] != "invite" and (
            attrs.get("notify") or attrs.get("note")
        ):
            raise serializers.ValidationError("Notifications belong to invitations.")
        if attrs["operation"] == "link":
            if members or "link_scope" not in attrs:
                raise serializers.ValidationError("Select the link access scope.")
        elif (
            "link_scope" in attrs
            or not 1 <= len(members) <= 50
            or len({row["id"] for row in members}) != len(members)
        ):
            raise serializers.ValidationError(
                "Select distinct collaborators, up to 50."
            )
        elif attrs["operation"] != "invite" and len(members) != 1:
            raise serializers.ValidationError("Select one collaborator.")
        for row in members:
            row["id"] = str(row["id"])
        return attrs


class CollaborationView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def record(self, request, record_id, scope):
        if not settings.MEETING_RECORDS_ENABLED or scope not in service.SCOPES:
            raise Http404
        return get_object_or_404(
            visible_records(request.user, ability=service.SCOPES[scope]), pk=record_id
        )

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "private, no-store"
        return response

    def get(self, request, record_id, scope):
        record = self.record(request, record_id, scope)
        try:
            return Response(service.state(record, request.user, scope))
        except PermissionError as exc:
            raise PermissionDenied from exc

    def post(self, request, record_id, scope):
        self.record(request, record_id, scope)
        if not settings.MEETING_SUMMARY_SHARING_ENABLED:
            raise PermissionDenied
        payload = Change(data=request.data)
        payload.is_valid(raise_exception=True)
        key = serializers.UUIDField().run_validation(
            request.headers.get("Idempotency-Key")
        )
        try:
            return Response(
                service.change(
                    record_id, request.user, scope, key, payload.validated_data
                )
            )
        except PermissionError as exc:
            raise PermissionDenied from exc
        except RecordConflict:
            return Response({"code": "collaboration_changed"}, status=409)


class CollaborationCandidatesView(CollaborationView):
    """Invite candidates for one object, as pages the shared picker can consume.

    Keyed by cursor rather than offset because the picker's contract is "load
    more" (`next_cursor`), and the candidate set is filtered by who may be
    granted this object at all — it is not the organization directory. `kind`
    switches between people and the two team targets that `Change` accepts
    (`dept:` / `group:` keys), so callers never translate directory ids into
    ACL keys themselves.
    """

    def get(self, request, record_id, scope):
        record = self.record(request, record_id, scope)
        if not service.can_manage(record, request.user, scope):
            raise PermissionDenied
        query = serializers.CharField(max_length=80, allow_blank=True).run_validation(
            request.query_params.get("q", "")
        )
        cursor = serializers.IntegerField(
            min_value=0, max_value=1000000
        ).run_validation(request.query_params.get("cursor") or 0)
        kind = serializers.ChoiceField(
            choices=["users", "departments", "groups"]
        ).run_validation(request.query_params.get("kind", "users"))
        # Mirrors the write path: no organization, or groups on a record, means
        # nothing can be granted by team.
        team_kind = kind != "users"
        if team_kind and (
            not record.organization_id or (kind == "groups" and scope != "minutes")
        ):
            return Response({"results": [], "next_cursor": None})

        def people(row):
            return {
                "id": str(row.pk),
                "name": row.full_name or "",
                # Same presigned-URL pattern as every other directory surface:
                # the buckets are private, so the client cannot build this.
                "avatar_url": utils.generate_profile_image_get_url(
                    "avatar", row.avatar_key
                ),
            }

        def team(row):
            return {
                "id": row.team_key if kind == "departments" else row.group_key,
                "name": row.name,
                "avatar_url": "",
            }

        if not team_kind:
            rows = (
                eligible_users(record, request.user)
                .filter(full_name__icontains=query)
                .order_by("full_name", "id")
            )
            target = people
        else:
            model = models.Department if kind == "departments" else models.UserGroup
            rows = model.objects.filter(
                organization_id=record.organization_id,
                is_active=True,
                deleted_at__isnull=True,
                name__icontains=query,
            ).order_by("name", "id")
            target = team
        # Slice before evaluating: a page costs one query, and the extra row is
        # only there to answer "is there more" without a second COUNT.
        page = list(rows[cursor : cursor + CANDIDATES_PAGE + 1])
        return Response(
            {
                "results": [target(row) for row in page[:CANDIDATES_PAGE]],
                "next_cursor": (
                    str(cursor + CANDIDATES_PAGE)
                    if len(page) > CANDIDATES_PAGE
                    else None
                ),
            }
        )

    def post(self, request, record_id, scope):
        raise Http404


class MaterialPreviewView(CollaborationView):
    """Fetch private card content and the viewer's live role; never trust card snapshots."""

    def get(self, request, record_id, scope):
        record = self.record(request, record_id, scope)
        editable = getattr(record, f"collaboration_{scope}_edit")
        role = (
            "manager"
            if getattr(record, f"collaboration_{scope}_manage")
            else "editor"
            if editable
            else "reader"
        )
        result = {
            "scope": scope,
            "record_id": str(record.pk),
            "title": record.title,
            "role": role,
            "excerpt": "",
            "media_type": "audio",
            "media_url": None,
        }
        if scope == "minutes":
            review = record.summary_reviews.first()
            version = record.summary_versions.first()
            content = review.content if review else version.content if version else {}
            result["excerpt"] = str(content.get("overview", ""))[:800]
        else:
            from core.services.record_media_timing import media_timing  # noqa: PLC0415
            from core.services.uploaded_recordings import (  # noqa: PLC0415
                media_available,
                media_read_url,
            )

            result["duration_ms"] = media_timing(record)["duration_ms"]
            job = getattr(record, "uploaded_recording", None)
            if job and record.collaboration_media and media_available(job):
                media = media_read_url(job)
                result.update(media_type=media["media_type"], media_url=media["url"])
        self.record(request, record_id, scope)
        return Response(result)

    def post(self, request, record_id, scope):
        raise Http404


class CollaborationNotificationRetryView(CollaborationView):
    def get(self, request, record_id, scope):
        raise Http404

    def post(self, request, record_id, scope):
        from core.services.collaboration_notifications import dispatch  # noqa: PLC0415

        record = self.record(request, record_id, scope)
        if not service.can_manage(record, request.user, scope):
            raise PermissionDenied
        for pk in models.MeetingCollaborationNotice.objects.filter(
            receipt__policy__record=record,
            receipt__policy__scope=scope,
            receipt__actor=request.user,
            status="pending",
        ).values_list("pk", flat=True)[:100]:
            dispatch(pk)
        return Response({"accepted": True})
