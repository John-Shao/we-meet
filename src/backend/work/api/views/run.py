"""Run, operation and task event endpoints (D2 Runs/Events)."""

import json
import os
import time

from django.http import StreamingHttpResponse

from rest_framework.response import Response

from work.api.base import WorkAPIView, pagination
from work.api.context import fetch_all, fetch_one, work_cursor
from work.api.errors import WorkAPIError
from work.api.presenters import iso, operation_view, run_view
from work.api.queries import run_row
from work.api.serializers import CancelSerializer


class RunDetailView(WorkAPIView):
    def get(self, request, run_id):
        context = request.work_context
        with work_cursor(context) as cursor:
            row = run_row(cursor, context.org_id, str(run_id), context.subject_id)
        if row is None:
            raise WorkAPIError("run_not_found")
        return Response(run_view(row))


class OperationListView(WorkAPIView):
    def get(self, request, run_id):
        offset, limit = pagination(request)
        context = request.work_context
        with work_cursor(context) as cursor:
            if run_row(cursor, context.org_id, str(run_id), context.subject_id) is None:
                raise WorkAPIError("run_not_found")
            cursor.execute(
                "SELECT * FROM work.operation WHERE org_id = %s AND run_id = %s "
                "ORDER BY created_at, id",
                [context.org_id, str(run_id)],
            )
            rows = fetch_all(cursor)
        items = [operation_view(row) for row in rows[offset : offset + limit]]
        next_cursor = str(offset + limit) if offset + limit < len(rows) else None
        return Response({"items": items, "next_cursor": next_cursor})


class CancelRunView(WorkAPIView):
    def post(self, request, run_id):
        serializer = CancelSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        context = request.work_context
        with work_cursor(context) as cursor:
            row = run_row(cursor, context.org_id, str(run_id), context.subject_id)
            if row is None:
                raise WorkAPIError("run_not_found")
            cursor.execute(
                "SELECT work.request_cancel(%s, %s, %s, %s)",
                [
                    context.org_id,
                    str(run_id),
                    context.subject_id,
                    data.get("reason") or "user_requested",
                ],
            )
            cursor.execute(
                "SELECT * FROM work.run WHERE org_id = %s AND id = %s",
                [context.org_id, str(run_id)],
            )
            row = fetch_one(cursor)
        return Response(run_view(row), status=202)


class StreamTaskEventsView(WorkAPIView):
    def get(self, request, task_id):
        context = request.work_context
        last_event_id = request.headers.get("Last-Event-ID")
        with work_cursor(context) as cursor:
            cursor.execute(
                "SELECT t.id FROM work.task t WHERE t.org_id = %s AND t.id = %s "
                "AND t.owner_subject_id = %s AND t.deleted_at IS NULL",
                [context.org_id, str(task_id), context.subject_id],
            )
            if cursor.fetchone() is None:
                raise WorkAPIError("task_not_found")
            after_seq = 0
            if last_event_id:
                cursor.execute(
                    "SELECT seq FROM work.task_event WHERE org_id = %s "
                    "AND task_id = %s AND id = %s",
                    [context.org_id, str(task_id), last_event_id],
                )
                row = cursor.fetchone()
                if row is None:
                    raise WorkAPIError("resync_required")
                after_seq = row[0]
            cursor.execute(
                "SELECT id, seq, type, payload, created_at FROM work.task_event "
                "WHERE org_id = %s AND task_id = %s AND seq > %s ORDER BY seq",
                [context.org_id, str(task_id), after_seq],
            )
            events = fetch_all(cursor)

        idle_seconds = float(os.environ.get("WORK_SSE_IDLE_SECONDS", "30"))

        def framed(event):
            body = {
                "event_id": str(event["id"]),
                "task_id": str(task_id),
                "seq": event["seq"],
                "schema_version": "work-event-v1",
                "occurred_at": iso(event["created_at"]),
                "type": event["type"],
                "payload": event["payload"] or {},
            }
            return (
                f"id: {event['id']}\n"
                f"event: {event['type']}\n"
                f"data: {json.dumps(body, ensure_ascii=False)}\n\n"
            )

        def stream():
            last_seq = after_seq
            for event in events:
                last_seq = event["seq"]
                yield framed(event)
            deadline = time.monotonic() + max(idle_seconds, 0)
            while time.monotonic() < deadline:
                time.sleep(min(1.0, max(deadline - time.monotonic(), 0)))
                with work_cursor(context) as cursor:
                    cursor.execute(
                        "SELECT id, seq, type, payload, created_at "
                        "FROM work.task_event WHERE org_id = %s AND task_id = %s "
                        "AND seq > %s ORDER BY seq",
                        [context.org_id, str(task_id), last_seq],
                    )
                    fresh = fetch_all(cursor)
                for event in fresh:
                    last_seq = event["seq"]
                    yield framed(event)
                yield ": ping\n\n"

        response = StreamingHttpResponse(stream(), content_type="text/event-stream")
        response["Cache-Control"] = "no-store"
        return response
