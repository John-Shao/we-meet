"""Task, input and preview endpoints (D2 Tasks/Inputs)."""

import json
import uuid
from datetime import timedelta

from django.middleware.csrf import get_token
from django.utils import timezone

from rest_framework.response import Response

from work.api import content_store, preview
from work.api.base import WorkAPIView, paginated, pagination
from work.api.constants import (
    EXECUTION_TARGETS,
    LIMITS,
    PERMISSIONS,
    PHASES,
    RUNTIME_VERSION,
    TEMPLATES,
)
from work.api.context import fetch_all, fetch_one, work_cursor
from work.api.errors import WorkAPIError
from work.api.presenters import iso, run_view, task_summary
from work.api.queries import (
    input_payload,
    input_row,
    snapshot_manifest,
    summary_for_task,
    task_row,
)
from work.api.serializers import (
    InputCreateSerializer,
    TaskPreviewSerializer,
    TaskRunSerializer,
    TaskSubmitSerializer,
    TaskUpdateSerializer,
)

TOOL_ALLOWLIST = ["model_call", "read_builtin_template", "write_artifact_draft"]
DEFAULT_MODEL_ROUTE = {"provider": "mock", "model": "mock-text-v1"}

VIEW_FILTERS = {
    "pending": ("ts.display_state IN ('failed', 'reconciling', 'run_canceled')",),
    "running": (
        "ts.display_state IN ('queued', 'running', 'canceling', 'quota_exhausted')",
    ),
}


def _policy(cursor, org_id):
    cursor.execute(
        "SELECT force_ask_each, allow_auto_readonly, run_cap_tokens "
        "FROM work.org_policy WHERE org_id = %s",
        [org_id],
    )
    return fetch_one(cursor)


def _allowed_modes(policy):
    return (
        ["ask_each", "auto_readonly"]
        if policy and policy["allow_auto_readonly"]
        else ["ask_each"]
    )


def _template(data):
    selection = data.get("template")
    if not selection:
        return None
    for template in TEMPLATES:
        if (
            template["id"] == selection["id"]
            and template["version"] == selection["version"]
        ):
            return template
    raise WorkAPIError("template_unavailable")


def _normalized_intent(data):
    return {
        "input_ref": str(data["input_ref"]),
        "target": data["target"],
        "template": data.get("template"),
        "permission_mode": data["permission_mode"],
        "output": data.get("output") or {},
        "suite": None,
        "connectors": [],
    }


class BootstrapView(WorkAPIView):
    def get(self, request):
        context = request.work_context
        with work_cursor(context) as cursor:
            policy = _policy(cursor, context.org_id)
        return Response(
            {
                "subject_id": context.subject_id,
                "org": {
                    "id": context.org_id,
                    "name": context.org_name or "",
                    "role": context.role,
                    "work_seat": context.work_seat,
                },
                "permissions": PERMISSIONS,
                "phases": PHASES,
                "execution_targets": EXECUTION_TARGETS,
                "allowed_permission_modes": _allowed_modes(policy),
                "limits": LIMITS,
                "csrf_token": get_token(request),
            }
        )


class TemplateListView(WorkAPIView):
    def get(self, request):
        return Response({"items": TEMPLATES})


class InputCreateView(WorkAPIView):
    def post(self, request):
        serializer = InputCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        context = request.work_context
        payload = {"goal": data["goal"], "background": data.get("background", "")}
        blob = json.dumps(
            payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()
        ref, content_hash, size = content_store.put(
            context.org_id, blob, suffix=".json"
        )
        try:
            with work_cursor(context) as cursor:
                cursor.execute(
                    "SELECT work.create_input_idempotent(%s, %s, %s, %s, %s, %s, %s)",
                    [
                        context.org_id,
                        context.subject_id,
                        data["client_request_id"],
                        ref,
                        content_hash,
                        size,
                        data["media_type"],
                    ],
                )
                input_id = cursor.fetchone()[0]
                cursor.execute(
                    "SELECT * FROM work.input_object WHERE org_id = %s AND id = %s",
                    [context.org_id, input_id],
                )
                row = fetch_one(cursor)
                if row["content_ref"] != ref:
                    content_store.delete(context.org_id, ref)
        except Exception:
            content_store.delete(context.org_id, ref)
            raise
        return Response(
            {
                "input_ref": str(input_id),
                "content_hash": row["content_hash"],
                "bytes": row["bytes"],
                "media_type": row["media_type"],
                "expires_at": iso(row["expires_at"]),
            },
            status=201,
        )


class TaskPreviewView(WorkAPIView):
    def post(self, request):
        serializer = TaskPreviewSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        intent = _normalized_intent(serializer.validated_data["intent"])
        context = request.work_context
        with work_cursor(context) as cursor:
            row = input_row(
                cursor, context.org_id, context.subject_id, intent["input_ref"]
            )
            if row is None:
                raise WorkAPIError("input_not_found")
            policy = _policy(cursor, context.org_id)
        if policy is None:
            raise WorkAPIError("service_degraded")
        template = _template(intent)
        allowed = _allowed_modes(policy)
        mode = intent["permission_mode"]
        if mode not in allowed:
            raise WorkAPIError("permission_mode_unavailable")
        if policy["force_ask_each"]:
            mode = "ask_each"
        cap = int(policy["run_cap_tokens"])
        intent_hash = preview.digest(intent)
        template_hash = template["content_hash"] if template else None
        token = preview.sign(
            context,
            intent_hash=intent_hash,
            input_hash=row["content_hash"],
            template_hash=template_hash,
            mode=mode,
            cap=cap,
        )
        expires_at = timezone.now() + timedelta(seconds=preview.MAX_AGE_SECONDS)
        return Response(
            {
                "preview_hash": token,
                "effective_permission_mode": mode,
                "allowed_permission_modes": allowed,
                "boundary_summary": [
                    "执行位置：云端（cloud/text-v1）",
                    "数据：仅本次输入的文本；不访问本机、连接器或项目",
                    "权限：本次任务内模型生成；无外部写动作",
                    "成果：Markdown，保存到任务，可编辑并采纳",
                    f"token 上限：{cap}（超出即受控失败；费用以云厂商账单为准）",
                ],
                "token_upper_bound": {
                    "amount_tokens": cap,
                    "note": "用量仅供参考，费用以云厂商账单为准",
                },
                "unavailable_reasons": [],
                "expires_at": iso(expires_at),
            }
        )


class TaskSubmitView(WorkAPIView):
    def post(self, request):
        serializer = TaskSubmitSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        intent = _normalized_intent(data["intent"])
        context = request.work_context
        intent_hash = preview.digest(intent)
        preview_payload = preview.verify(context, data["preview_hash"], intent_hash)
        effective_mode = preview_payload["mode"]
        with work_cursor(context) as cursor:
            row = input_row(
                cursor, context.org_id, context.subject_id, intent["input_ref"]
            )
            if row is None:
                raise WorkAPIError("input_not_found")
            payload = input_payload(row)
        template = _template(intent)
        manifest = {
            "input_ref": intent["input_ref"],
            "input_hash": row["content_hash"],
            "target": intent["target"],
            "template": template,
            "permission_mode": effective_mode,
            "output": intent["output"],
        }
        snapshot_hash = preview.digest(manifest)
        title = payload["goal"].strip()[:20] or "未命名任务"
        workflow_id = f"r0a-{uuid.uuid4()}"
        # The worker resolves the org's provider context at dispatch (D-08).
        model_route = DEFAULT_MODEL_ROUTE
        with work_cursor(context) as cursor:
            cursor.execute(
                "SELECT task_id, run_id, revision FROM work.submit_task("
                "%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s::jsonb, %s, %s)",
                [
                    context.org_id,
                    context.subject_id,
                    data["client_request_id"],
                    intent["input_ref"],
                    title,
                    effective_mode,
                    snapshot_hash,
                    json.dumps(manifest, ensure_ascii=False),
                    TOOL_ALLOWLIST,
                    json.dumps(model_route, ensure_ascii=False),
                    workflow_id,
                    RUNTIME_VERSION,
                ],
            )
            task_id, run_id, _ = cursor.fetchone()
            summary_row = summary_for_task(
                cursor, context.org_id, task_id, context.subject_id
            )
            cursor.execute(
                "SELECT * FROM work.run WHERE org_id = %s AND id = %s",
                [context.org_id, run_id],
            )
            run = fetch_one(cursor)
        response = Response(
            {"task": task_summary(summary_row), "run": run_view(run)}, status=202
        )
        response["Location"] = f"/work/v1/tasks/{task_id}"
        return response


class TaskListView(WorkAPIView):
    def get(self, request):
        view = request.query_params.get("view", "all")
        allowed = {"pending", "running", "awaiting_acceptance", "completed", "all"}
        if view not in allowed:
            raise WorkAPIError("invalid_view")
        offset, limit = pagination(request)
        context = request.work_context
        where = ["ts.org_id = %s", "ts.owner_subject_id = %s"]
        params = [context.org_id, context.subject_id]
        if view in VIEW_FILTERS:
            where.extend(VIEW_FILTERS[view])
        elif view != "all":
            where.append("ts.display_state = %s")
            params.append(view)
        sql = (
            "SELECT ts.*, r.attempt_no, r.state AS run_state, r.wait_reason, "
            "r.terminal_reason, r.control_revision, r.runtime_version, "
            "r.created_at AS run_created_at, r.updated_at AS run_updated_at "
            "FROM work.task_summary ts "
            "LEFT JOIN work.run r ON r.id = ts.latest_run_id AND r.org_id = ts.org_id "
            "WHERE "
            + " AND ".join(where)
            + " ORDER BY ts.updated_at DESC, ts.task_id DESC LIMIT %s OFFSET %s"
        )
        with work_cursor(context) as cursor:
            cursor.execute(sql, [*params, limit + 1, offset])
            rows = fetch_all(cursor)
        items = [task_summary(row) for row in rows[:limit]]
        next_cursor = str(offset + limit) if len(rows) > limit else None
        return Response({"items": items, "next_cursor": next_cursor})


class TaskDetailView(WorkAPIView):
    def get(self, request, task_id):
        context = request.work_context
        with work_cursor(context) as cursor:
            task = task_row(cursor, context.org_id, str(task_id), context.subject_id)
            if task is None:
                raise WorkAPIError("task_not_found")
            summary_row = summary_for_task(
                cursor, context.org_id, str(task_id), context.subject_id
            )
            source = (
                input_row(
                    cursor, context.org_id, context.subject_id, str(task["input_id"])
                )
                if task.get("input_id")
                else None
            )
            manifest = snapshot_manifest(
                cursor, context.org_id, task.get("snapshot_id")
            )
        payload = input_payload(source) if source else {"goal": "", "background": ""}
        return Response(
            {
                "summary": task_summary(summary_row),
                "input_ref": str(task["input_id"]),
                "goal": payload.get("goal", ""),
                "background": payload.get("background"),
                "template": manifest.get("template"),
                "snapshot": manifest,
            }
        )


class TaskRetryView(WorkAPIView):
    def post(self, request, task_id):
        serializer = TaskRunSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        context = request.work_context
        with work_cursor(context) as cursor:
            if (
                task_row(cursor, context.org_id, str(task_id), context.subject_id)
                is None
            ):
                raise WorkAPIError("task_not_found")
            cursor.execute(
                "SELECT run_id, revision FROM work.retry_task("
                "%s, %s, %s, %s, %s, %s, %s)",
                [
                    context.org_id,
                    str(task_id),
                    context.subject_id,
                    data["client_request_id"],
                    data["expected_revision"],
                    f"r0a-{uuid.uuid4()}",
                    RUNTIME_VERSION,
                ],
            )
            run_id, _ = cursor.fetchone()
            summary_row = summary_for_task(
                cursor, context.org_id, str(task_id), context.subject_id
            )
            cursor.execute(
                "SELECT * FROM work.run WHERE org_id = %s AND id = %s",
                [context.org_id, run_id],
            )
            run = fetch_one(cursor)
        return Response(
            {"task": task_summary(summary_row), "run": run_view(run)}, status=202
        )


class TaskUpdateView(WorkAPIView):
    def patch(self, request, task_id):
        serializer = TaskUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        context = request.work_context
        with work_cursor(context) as cursor:
            cursor.execute(
                "SELECT work.update_task_title(%s, %s, %s, %s, %s, %s)",
                [
                    context.org_id,
                    str(task_id),
                    context.subject_id,
                    data["client_request_id"],
                    data["expected_revision"],
                    data["title"],
                ],
            )
            summary_row = summary_for_task(
                cursor, context.org_id, str(task_id), context.subject_id
            )
        if summary_row is None:
            raise WorkAPIError("task_not_found")
        return Response(task_summary(summary_row))


class TaskDeleteView(WorkAPIView):
    def delete(self, request, task_id):
        raw_revision = request.query_params.get("expected_revision")
        try:
            expected_revision = int(raw_revision)
        except (TypeError, ValueError) as error:
            raise WorkAPIError("invalid_request") from error
        context = request.work_context
        with work_cursor(context) as cursor:
            cursor.execute(
                "SELECT work.delete_task(%s, %s, %s, %s, %s)",
                [
                    context.org_id,
                    str(task_id),
                    context.subject_id,
                    expected_revision,
                    request.query_params.get("reason"),
                ],
            )
        return Response(
            {
                "task_id": str(task_id),
                "deleted_at": iso(timezone.now()),
                "content_purge": "scheduled",
            }
        )


class TaskCollectionView(TaskListView, TaskSubmitView):
    pass


class TaskItemView(TaskDetailView, TaskUpdateView, TaskDeleteView):
    pass


class InboxView(WorkAPIView):
    def get(self, request):
        offset, limit = pagination(request)
        context = request.work_context
        with work_cursor(context) as cursor:
            cursor.execute(
                "SELECT * FROM work.task_summary WHERE org_id = %s "
                "AND owner_subject_id = %s AND (pending_acceptance OR "
                "display_state IN ('failed', 'reconciling')) "
                "ORDER BY updated_at DESC, task_id DESC",
                [context.org_id, context.subject_id],
            )
            rows = fetch_all(cursor)
        items = []
        for row in rows:
            if row["pending_acceptance"]:
                kind = "acceptance_required"
            elif row["display_state"] == "failed":
                kind = "failed"
            else:
                kind = "reconciling"
            items.append(
                {
                    "task_id": str(row["task_id"]),
                    "type": kind,
                    "title": row["title"],
                    "display_state": row["display_state"],
                    "updated_at": iso(row["updated_at"]),
                }
            )
        return Response(paginated(items, offset, limit))
