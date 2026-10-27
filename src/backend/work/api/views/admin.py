"""Admin endpoints (D2 Admin, U2 plan B)."""

import hashlib
import re
import secrets

from django.http import HttpResponse

from rest_framework.response import Response

from work.api import content_store
from work.api.base import WorkAPIView, pagination
from work.api.context import fetch_all, fetch_one, require_admin, work_cursor
from work.api.errors import WorkAPIError
from work.api.presenters import as_dict, iso
from work.api.serializers import (
    AuditExportCreateSerializer,
    AuditExportTicketSerializer,
)
from work.content.contracts.content_store import ContentStoreError


class AdminOverviewView(WorkAPIView):
    def get(self, request):
        require_admin(request.work_context)
        context = request.work_context
        with work_cursor(context) as cursor:
            cursor.execute(
                "SELECT work.admin_overview(%s, %s)",
                [context.org_id, context.subject_id],
            )
            payload = as_dict(cursor.fetchone()[0])
        return Response(payload)


class SeatListView(WorkAPIView):
    def get(self, request):
        require_admin(request.work_context)
        offset, limit = pagination(request)
        cursor_value = request.query_params.get("cursor") or None
        if request.query_params.get("cursor") == "":
            raise WorkAPIError("invalid_pagination")
        context = request.work_context
        with work_cursor(context) as cursor:
            cursor.execute(
                "SELECT * FROM work.list_seats(%s, %s, %s, %s)",
                [context.org_id, context.subject_id, cursor_value, limit],
            )
            rows = fetch_all(cursor)
        items = [
            {
                "subject_id": row["subject_id"],
                "role": row["role"],
                "work_seat": bool(row["work_seat"]),
                "status": row["status"],
                "revision": row["revision"],
            }
            for row in rows
        ]
        next_cursor = items[-1]["subject_id"] if len(items) == limit else None
        return Response({"items": items, "next_cursor": next_cursor})


class AuditExportCreateView(WorkAPIView):
    def post(self, request):
        require_admin(request.work_context)
        serializer = AuditExportCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        context = request.work_context
        with work_cursor(context) as cursor:
            cursor.execute(
                "SELECT work.create_audit_export(%s, %s, %s, %s, %s, %s)",
                [
                    context.org_id,
                    context.subject_id,
                    data["client_request_id"],
                    data["range_from"],
                    data["range_to"],
                    data["format"],
                ],
            )
            payload = as_dict(cursor.fetchone()[0])
        response = Response(payload, status=202)
        response["Location"] = f"/work/v1/admin/audit-exports/{payload['id']}"
        return response


class AuditExportDetailView(WorkAPIView):
    def get(self, request, export_id):
        require_admin(request.work_context)
        context = request.work_context
        with work_cursor(context) as cursor:
            cursor.execute(
                "SELECT work.get_audit_export(%s, %s, %s)",
                [context.org_id, context.subject_id, str(export_id)],
            )
            payload = as_dict(cursor.fetchone()[0])
        return Response(payload)


class AuditExportTicketView(WorkAPIView):
    def post(self, request, export_id):
        require_admin(request.work_context)
        serializer = AuditExportTicketSerializer(data=request.data or {})
        serializer.is_valid(raise_exception=True)
        token = secrets.token_hex(32)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        context = request.work_context
        with work_cursor(context) as cursor:
            cursor.execute(
                "SELECT work.issue_audit_export_download(%s, %s, %s, %s, %s)",
                [
                    context.org_id,
                    context.subject_id,
                    str(export_id),
                    token_hash,
                    serializer.validated_data["ttl_seconds"],
                ],
            )
            payload = as_dict(cursor.fetchone()[0])
        return Response(
            {
                "token": token,
                "expires_at": iso(payload["expires_at"]),
                "format": payload["format"],
                "row_count": payload["row_count"],
                "bytes": payload["bytes"],
            }
        )


class AuditExportContentView(WorkAPIView):
    def get(self, request, export_id):
        require_admin(request.work_context)
        token = request.headers.get("X-Download-Token", "")
        if not re.fullmatch(r"[0-9a-f]{16,128}", token):
            raise WorkAPIError("download_token_invalid")
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        context = request.work_context
        with work_cursor(context) as cursor:
            cursor.execute(
                "SELECT work.redeem_audit_export_download(%s, %s, %s)",
                [context.org_id, context.subject_id, token_hash],
            )
            payload = as_dict(cursor.fetchone()[0])
        try:
            body = content_store.get(context.org_id, payload["content_ref"])
        except (OSError, ValueError, ContentStoreError) as error:
            raise WorkAPIError("service_degraded") from error
        content_type = (
            "text/csv; charset=utf-8"
            if payload["format"] == "csv"
            else "application/json; charset=utf-8"
        )
        response = HttpResponse(body, content_type=content_type)
        response["Content-Disposition"] = (
            f'attachment; filename="work-audit-{str(export_id)[:8]}.'
            f'{payload["format"]}"'
        )
        response["Cache-Control"] = "no-store"
        response["X-Content-Type-Options"] = "nosniff"
        return response
