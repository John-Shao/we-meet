"""Artifact versions, controlled content download and acceptance (D2)."""

import hashlib
import re
from urllib.parse import quote

from django.http import HttpResponse

from rest_framework.response import Response

from work.api import content_store
from work.api.base import WorkAPIView
from work.api.context import fetch_one, work_cursor
from work.api.errors import WorkAPIError
from work.api.presenters import artifact_version_view, iso, task_summary
from work.api.queries import summary_for_task
from work.api.serializers import (
    AcceptanceSerializer,
    ArtifactVersionCreateSerializer,
)
from work.content.contracts.content_store import ContentStoreError

SUFFIX = {"text/markdown": ".md", "text/plain": ".txt"}


def _artifact_version(cursor, org_id, artifact_id, version_no, owner):
    cursor.execute(
        "SELECT av.*, a.logical_name, t.owner_subject_id "
        "FROM work.artifact_version av "
        "JOIN work.artifact a ON a.id = av.artifact_id AND a.org_id = av.org_id "
        "JOIN work.task t ON t.id = a.task_id AND t.org_id = a.org_id "
        "WHERE av.org_id = %s AND av.artifact_id = %s AND av.version_no = %s "
        "AND t.owner_subject_id = %s",
        [org_id, str(artifact_id), version_no, owner],
    )
    return fetch_one(cursor)


def _content_url(request, artifact_id, version_no):
    return request.build_absolute_uri(
        f"/work/v1/artifacts/{artifact_id}/versions/{version_no}/content"
    )


class ArtifactVersionCreateView(WorkAPIView):
    def post(self, request, artifact_id):
        serializer = ArtifactVersionCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        context = request.work_context
        blob = data["content"].encode("utf-8")
        if len(blob) > 262144:
            raise WorkAPIError("artifact_too_large")
        suffix = SUFFIX[data["media_type"]]
        ref, content_hash, size = content_store.put(context.org_id, blob, suffix=suffix)
        try:
            with work_cursor(context) as cursor:
                cursor.execute(
                    "SELECT version_no, task_revision FROM "
                    "work.create_user_artifact_version("
                    "%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    [
                        context.org_id,
                        str(artifact_id),
                        context.subject_id,
                        data["client_request_id"],
                        data["base_version_no"],
                        ref,
                        content_hash,
                        size,
                        data["media_type"],
                    ],
                )
                version_no, _ = cursor.fetchone()
                row = _artifact_version(
                    cursor,
                    context.org_id,
                    artifact_id,
                    version_no,
                    context.subject_id,
                )
                if row["content_ref"] != ref:
                    content_store.delete(context.org_id, ref)
        except Exception:
            content_store.delete(context.org_id, ref)
            raise
        return Response(
            artifact_version_view(row, _content_url(request, artifact_id, version_no)),
            status=201,
        )


class ArtifactVersionDetailView(WorkAPIView):
    def get(self, request, artifact_id, version_no):
        context = request.work_context
        with work_cursor(context) as cursor:
            row = _artifact_version(
                cursor,
                context.org_id,
                artifact_id,
                version_no,
                context.subject_id,
            )
        if row is None:
            raise WorkAPIError("version_not_found")
        return Response(
            artifact_version_view(row, _content_url(request, artifact_id, version_no))
        )


class ArtifactContentView(WorkAPIView):
    def get(self, request, artifact_id, version_no):
        disposition = request.query_params.get("disposition", "inline")
        if disposition not in ("inline", "attachment"):
            raise WorkAPIError("invalid_request")
        context = request.work_context
        with work_cursor(context) as cursor:
            row = _artifact_version(
                cursor,
                context.org_id,
                artifact_id,
                version_no,
                context.subject_id,
            )
            if row is None:
                raise WorkAPIError("version_not_found")
            if disposition == "attachment":
                cursor.execute(
                    "SELECT work.record_artifact_export(%s, %s, %s, %s)",
                    [
                        context.org_id,
                        str(artifact_id),
                        version_no,
                        context.subject_id,
                    ],
                )
            cursor.execute(
                "SELECT t.title FROM work.task t JOIN work.artifact a "
                "ON a.task_id = t.id AND a.org_id = t.org_id "
                "WHERE a.org_id = %s AND a.id = %s",
                [context.org_id, str(artifact_id)],
            )
            title_row = fetch_one(cursor)
        try:
            body = content_store.get(context.org_id, row["content_ref"])
        except (OSError, ValueError, ContentStoreError) as error:
            raise WorkAPIError("artifact_not_found") from error
        response = HttpResponse(
            body,
            content_type=f"{row['media_type']}; charset=utf-8",
        )
        response["Cache-Control"] = "no-store"
        response["X-Content-Type-Options"] = "nosniff"
        if disposition == "attachment":
            title = (title_row or {}).get("title") or "work"
            safe = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "", title)[:60] or "work"
            suffix = SUFFIX.get(row["media_type"], ".txt")
            ascii_name = f"work-{str(artifact_id)[:8]}-v{version_no}{suffix}"
            response["Content-Disposition"] = (
                f'attachment; filename="{ascii_name}"; '
                f"filename*=UTF-8''{quote(safe + f'-v{version_no}{suffix}')}"
            )
        return response


class AcceptanceView(WorkAPIView):
    def post(self, request, task_id):
        serializer = AcceptanceSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        context = request.work_context
        with work_cursor(context) as cursor:
            cursor.execute(
                "SELECT * FROM work.accept_task(%s, %s, %s, %s, %s, %s, %s, %s)",
                [
                    context.org_id,
                    str(task_id),
                    context.subject_id,
                    data["client_request_id"],
                    data["expected_revision"],
                    str(data.get("artifact_id")) if data.get("artifact_id") else None,
                    data.get("version_no"),
                    data.get("completion_reason"),
                ],
            )
            acceptance_id, _ = cursor.fetchone()
            cursor.execute(
                "SELECT * FROM work.acceptance WHERE org_id = %s AND id = %s",
                [context.org_id, acceptance_id],
            )
            acceptance = fetch_one(cursor)
            summary_row = summary_for_task(
                cursor, context.org_id, str(task_id), context.subject_id
            )
        return Response(
            {
                "acceptance": {
                    "id": str(acceptance["id"]),
                    "task_id": str(acceptance["task_id"]),
                    "artifact_id": (
                        str(acceptance["artifact_id"])
                        if acceptance["artifact_id"]
                        else None
                    ),
                    "version_no": acceptance["version_no"],
                    "completion_reason": acceptance["completion_reason"],
                    "actor_subject_id": acceptance["actor_subject_id"],
                    "task_revision": acceptance["task_revision"],
                    "created_at": iso(acceptance["created_at"]),
                },
                "task": task_summary(summary_row),
            }
        )
