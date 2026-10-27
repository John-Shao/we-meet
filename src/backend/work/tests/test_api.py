"""E2 API contract gates for the golden path and permission boundaries."""

import io
import uuid
from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import patch

from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection
from django.urls import resolve
from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core.factories import MembershipFactory, OrganizationFactory, UserFactory
from core.models import Membership, MembershipStatusChoices, OrgRoleChoices

from work.api import content_store
from work.api.errors import WorkAPIError
from work.content.contracts.content_store import ContentStoreError
from work.jobs import directory_sync
from work.jobs.audit_export import run_once as run_export_worker
from work.jobs.expiry_sweep import run_once as run_expiry_sweep
from work.jobs.outbox_relay import run_once as run_relay
from work.orchestration.local_workflow import run_local_workflow
from work.runtime.contracts.work_adapter import UsageReport
from work.runtime.mock.model_gateway import FauxModelGateway
from work.runtime.provider_context import decrypt_secret, resolve_provider_context
from work.security import credential_cipher

pytestmark = pytest.mark.django_db


def seed_projection(org, owner, member):
    org_id = str(org.id)
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO work.org (id, name, status, execution_enabled, home_region, revision) "
            "VALUES (%s, %s, 'active', true, 'cn-north', 1)",
            [org_id, org.name],
        )
        for user, role in ((owner, "owner"), (member, "member")):
            cursor.execute(
                "INSERT INTO work.member "
                "(org_id, subject_id, status, role, work_seat, revision) "
                "VALUES (%s, %s, 'active', %s, true, 1)",
                [org_id, user.sub, role],
            )
        cursor.execute(
            "INSERT INTO work.org_policy "
            "(org_id, revision, force_ask_each, allow_auto_readonly, "
            "allow_plan_approval, run_cap_tokens, policy) "
            "VALUES (%s, 1, false, true, false, 10000, "
            '\'{"schema":"r0a-policy-v1"}\'::jsonb)',
            [org_id],
        )
        cursor.execute(
            "INSERT INTO work.quota_account "
            "(org_id, account_key, period_id, limit_tokens, enforcement) "
            "VALUES (%s, 'default', '2026-10', 100000, 'soft')",
            [org_id],
        )
    return org_id


@pytest.fixture
def work_org():
    org = OrganizationFactory(name="Acme")
    owner = UserFactory(sub="owner-sub")
    member = UserFactory(sub="member-sub")
    MembershipFactory(
        organization=org,
        user=owner,
        org_role=OrgRoleChoices.OWNER,
        status=MembershipStatusChoices.ACTIVE,
    )
    MembershipFactory(
        organization=org,
        user=member,
        org_role=OrgRoleChoices.MEMBER,
        status=MembershipStatusChoices.ACTIVE,
    )
    org_id = seed_projection(org, owner, member)
    return SimpleNamespace(org=org, org_id=org_id, owner=owner, member=member)


@pytest.fixture(autouse=True)
def content_root(tmp_path, monkeypatch):
    monkeypatch.setenv("WORK_CONTENT_ROOT", str(tmp_path / "content"))
    monkeypatch.setenv("WORK_CREDENTIAL_MASTER_KEY", "11" * 32)
    monkeypatch.setenv("WORK_SSE_IDLE_SECONDS", "0")


def client_for(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def make_input(client, goal="季度复盘与下季度计划"):
    response = client.post(
        "/work/v1/inputs",
        {"client_request_id": "input-0001", "goal": goal},
        format="json",
    )
    assert response.status_code == 201, response.content
    return response.json()


def make_preview(client, input_ref, mode="ask_each"):
    return client.post(
        "/work/v1/task-previews",
        {
            "intent": {
                "input_ref": input_ref,
                "target": {"kind": "cloud", "profile": "text-v1"},
                "permission_mode": mode,
                "output": {"format": "markdown"},
                "template": None,
                "connectors": [],
            }
        },
        format="json",
    )


def test_bootstrap_and_templates(work_org):
    client = client_for(work_org.owner)
    response = client.get("/work/v1/bootstrap")
    assert response.status_code == 200, response.content
    body = response.json()
    assert body["org"]["id"] == work_org.org_id
    assert body["org"]["role"] == "owner"
    assert body["org"]["work_seat"] is True
    assert body["allowed_permission_modes"] == ["ask_each", "auto_readonly"]
    assert len(body["csrf_token"]) >= 16
    templates = client.get("/work/v1/templates").json()["items"]
    assert [item["id"] for item in templates] == [
        "tpl-report",
        "tpl-plan",
        "tpl-summary",
    ]


def test_input_preview_submit_and_reads(work_org):
    client = client_for(work_org.owner)
    source = make_input(client)
    preview = make_preview(client, source["input_ref"])
    assert preview.status_code == 200, preview.content
    preview_body = preview.json()
    assert preview_body["effective_permission_mode"] == "ask_each"
    assert preview_body["token_upper_bound"]["amount_tokens"] == 10000

    submitted = client.post(
        "/work/v1/tasks",
        {
            "client_request_id": "task-submit-0001",
            "preview_hash": preview_body["preview_hash"],
            "intent": {
                "input_ref": source["input_ref"],
                "target": {"kind": "cloud", "profile": "text-v1"},
                "permission_mode": "ask_each",
                "output": {"format": "markdown"},
                "template": None,
                "connectors": [],
            },
        },
        format="json",
    )
    assert submitted.status_code == 202, submitted.content
    task = submitted.json()["task"]
    run = submitted.json()["run"]
    assert task["task_id"]
    assert task["display_state"] == "queued"
    assert run["task_id"] == task["task_id"]

    detail = client.get(f"/work/v1/tasks/{task['task_id']}")
    assert detail.status_code == 200, detail.content
    assert detail.json()["goal"] == "季度复盘与下季度计划"

    listed = client.get("/work/v1/tasks")
    assert listed.status_code == 200
    assert listed.json()["items"][0]["task_id"] == task["task_id"]

    run_detail = client.get(f"/work/v1/runs/{run['id']}")
    assert run_detail.status_code == 200
    assert run_detail.json()["state"] == "queued"

    cancelled = client.post(
        f"/work/v1/runs/{run['id']}/cancel",
        {"client_request_id": "cancel-0001", "reason": "test"},
        format="json",
    )
    assert cancelled.status_code == 202, cancelled.content
    assert cancelled.json()["state"] == "cancel_requested"

    title = client.patch(
        f"/work/v1/tasks/{task['task_id']}",
        {
            "client_request_id": "title-0001",
            "expected_revision": task["revision"],
            "title": "新的标题",
        },
        format="json",
    )
    assert title.status_code == 200, title.content
    assert title.json()["title"] == "新的标题"

    usage = client.get("/work/v1/me/usage?from=2026-10-01&to=2026-10-31")
    assert usage.status_code == 200, usage.content
    assert usage.json()["items"] == []


def test_admin_boundary_and_overview(work_org):
    owner = client_for(work_org.owner)
    member = client_for(work_org.member)
    denied = member.get("/work/v1/admin/overview")
    assert denied.status_code == 403
    assert denied.json()["code"] == "admin_access_denied"

    overview = owner.get("/work/v1/admin/overview")
    assert overview.status_code == 200, overview.content
    body = overview.json()
    assert body["org_id"] == work_org.org_id
    assert body["quota"]["enforcement"] == "soft"

    seats = owner.get("/work/v1/admin/seats")
    assert seats.status_code == 200
    assert {row["subject_id"] for row in seats.json()["items"]} == {
        "owner-sub",
        "member-sub",
    }

    missing = owner.get("/work/v1/admin/provider-config")
    assert missing.status_code == 404
    assert missing.json()["code"] == "not_found"


def test_csrf_is_required_for_mutations(work_org):
    client = APIClient(enforce_csrf_checks=True)
    client.force_login(work_org.owner)
    rejected = client.post(
        "/work/v1/inputs",
        {"client_request_id": "csrf-0001", "goal": "测试 CSRF"},
        format="json",
    )
    assert rejected.status_code == 403
    assert rejected.json()["code"] == "csrf_invalid"

    token = client.get("/work/v1/bootstrap").json()["csrf_token"]
    accepted = client.post(
        "/work/v1/inputs",
        {"client_request_id": "csrf-0002", "goal": "测试 CSRF"},
        format="json",
        HTTP_X_CSRFTOKEN=token,
    )
    assert accepted.status_code == 201, accepted.content


def test_malformed_json_and_unsupported_media_type_have_contract_codes(work_org):
    client = APIClient(enforce_csrf_checks=True)
    client.force_login(work_org.owner)
    token = client.get("/work/v1/bootstrap").json()["csrf_token"]
    bad_json = client.post(
        "/work/v1/inputs",
        data=b'{"client_request_id": "\xb1"}',
        content_type="application/json",
        HTTP_X_CSRFTOKEN=token,
    )
    assert bad_json.status_code == 400, bad_json.content
    assert bad_json.json()["code"] == "invalid_json"

    bad_type = client.post(
        "/work/v1/inputs",
        data='{"client_request_id": "input-0001"}',
        content_type="text/plain",
        HTTP_X_CSRFTOKEN=token,
    )
    assert bad_type.status_code == 400, bad_type.content
    assert bad_type.json()["code"] == "invalid_request"


def submit_task(client, source, request_id="task-submit-0001"):
    preview_body = make_preview(client, source["input_ref"]).json()
    intent = {
        "input_ref": source["input_ref"],
        "target": {"kind": "cloud", "profile": "text-v1"},
        "permission_mode": "ask_each",
        "output": {"format": "markdown"},
        "template": None,
        "connectors": [],
    }
    response = client.post(
        "/work/v1/tasks",
        {
            "client_request_id": request_id,
            "preview_hash": preview_body["preview_hash"],
            "intent": intent,
        },
        format="json",
    )
    assert response.status_code == 202, response.content
    return response.json(), intent


def test_directory_sync_projects_org_and_members():
    org = OrganizationFactory(name="投影组织")
    owner = UserFactory(sub="sync-owner")
    member = UserFactory(sub="sync-member")
    MembershipFactory(
        organization=org,
        user=owner,
        org_role=OrgRoleChoices.OWNER,
        status=MembershipStatusChoices.ACTIVE,
    )
    MembershipFactory(
        organization=org,
        user=member,
        org_role=OrgRoleChoices.MEMBER,
        status=MembershipStatusChoices.INVITED,
    )

    result = directory_sync.run_once()
    assert result["orgs"] >= 1
    assert result["members"] >= 2
    with connection.cursor() as cursor:
        cursor.execute("SELECT name FROM work.org WHERE id = %s", [str(org.id)])
        assert cursor.fetchone()[0] == "投影组织"
        cursor.execute(
            "SELECT role, work_seat, status FROM work.member "
            "WHERE org_id = %s AND subject_id = %s",
            [str(org.id), "sync-owner"],
        )
        assert cursor.fetchone() == ("owner", True, "active")
        cursor.execute(
            "SELECT role, work_seat, status FROM work.member "
            "WHERE org_id = %s AND subject_id = %s",
            [str(org.id), "sync-member"],
        )
        assert cursor.fetchone() == ("member", False, "invited")


def test_directory_sync_member_resolves_user_before_role_switch():
    org = OrganizationFactory(name="席位投影组织")
    user = UserFactory(sub="seat-projection-user")
    MembershipFactory(
        organization=org,
        user=user,
        org_role=OrgRoleChoices.ADMIN,
        status=MembershipStatusChoices.ACTIVE,
    )
    directory_sync.sync_org(org)
    membership = Membership.objects.get(organization=org, user=user)
    directory_sync.sync_member(membership)
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT role FROM work.member WHERE org_id = %s AND subject_id = %s",
            [str(org.id), "seat-projection-user"],
        )
        assert cursor.fetchone()[0] == "admin"


def test_provider_credentials_are_encrypted_and_rotated(work_org):
    owner = client_for(work_org.owner)
    created = owner.post(
        "/work/v1/admin/provider-credentials",
        {
            "provider": "aliyun",
            "mode": "managed_key",
            "api_key": "sk-test-value-123456",
        },
        format="json",
    )
    assert created.status_code == 201, created.content
    credential = created.json()
    assert credential["key_version"] == 1
    assert credential["fingerprint"].startswith("fp:")
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT secret_ciphertext, secret_fingerprint "
            "FROM work.provider_credential WHERE id = %s",
            [credential["credential_id"]],
        )
        ciphertext, fingerprint = cursor.fetchone()
    assert b"sk-test-value-123456" not in bytes(ciphertext)
    assert fingerprint == credential["fingerprint"]
    with pytest.raises(WorkAPIError):
        credential_cipher.decrypt("another-org", bytes(ciphertext))

    configured = owner.put(
        "/work/v1/admin/provider-config",
        {
            "provider": "aliyun",
            "model": "qwen3.8-flash",
            "region": "cn-beijing",
            "endpoint": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "credential_mode": "managed_key",
            "credential_id": credential["credential_id"],
            "expected_revision": 0,
        },
        format="json",
    )
    assert configured.status_code == 200, configured.content
    resolved = resolve_provider_context(work_org.org_id)
    assert resolved.provider == "aliyun"
    assert resolved.credential_mode == "managed_key"
    assert decrypt_secret(resolved) == "sk-test-value-123456"
    fetched = owner.get("/work/v1/admin/provider-config")
    assert fetched.status_code == 200
    assert fetched.json()["credential"]["fingerprint"] == credential["fingerprint"]

    rotated = owner.post(
        f"/work/v1/admin/provider-credentials/{credential['credential_id']}/rotate",
        {"api_key": "sk-test-value-654321"},
        format="json",
    )
    assert rotated.status_code == 200, rotated.content
    assert rotated.json()["key_version"] == 2

    revoked = owner.post(
        f"/work/v1/admin/provider-credentials/{credential['credential_id']}/revoke",
        {"reason": "key compromised"},
        format="json",
    )
    assert revoked.status_code == 200
    assert revoked.json()["state"] == "revoked"


def test_audit_export_worker_and_single_use_download(work_org):
    owner = client_for(work_org.owner)
    now = timezone.now()
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO work.audit_event "
            "(org_id, actor_subject_id, action, target_type, target_id, metadata, created_at) "
            "VALUES (%s, %s, 'seed.event', 'task', 'seed', '{}'::jsonb, %s)",
            [work_org.org_id, work_org.owner.sub, now - timedelta(days=2)],
        )
    created = owner.post(
        "/work/v1/admin/audit-exports",
        {
            "client_request_id": "export-0001",
            "range_from": (now - timedelta(days=5)).isoformat(),
            "range_to": (now - timedelta(days=1)).isoformat(),
            "format": "csv",
        },
        format="json",
    )
    assert created.status_code == 202, created.content
    export_id = created.json()["id"]
    assert created.json()["status"] == "queued"

    result = run_export_worker("test-worker")
    assert result["completed"] >= 1

    detail = owner.get(f"/work/v1/admin/audit-exports/{export_id}")
    assert detail.status_code == 200, detail.content
    assert detail.json()["status"] == "ready"
    assert detail.json()["download_available"] is True
    assert detail.json()["row_count"] >= 1

    ticket = owner.post(
        f"/work/v1/admin/audit-exports/{export_id}/download-ticket",
        {},
        format="json",
    )
    assert ticket.status_code == 200, ticket.content
    token = ticket.json()["token"]
    downloaded = owner.get(
        f"/work/v1/admin/audit-exports/{export_id}/content",
        HTTP_X_DOWNLOAD_TOKEN=token,
    )
    assert downloaded.status_code == 200
    assert downloaded["Content-Type"].startswith("text/csv")
    assert b"seed.event" in downloaded.content
    replay = owner.get(
        f"/work/v1/admin/audit-exports/{export_id}/content",
        HTTP_X_DOWNLOAD_TOKEN=token,
    )
    assert replay.status_code == 403
    assert replay.json()["code"] in (
        "download_token_invalid",
        "audit_export_already_downloaded",
    )


def test_ops_cancel_run_requires_ticket_and_is_idempotent(work_org):
    client = client_for(work_org.owner)
    source = make_input(client)
    submitted, _ = submit_task(client, source)
    run_id = submitted["run"]["id"]
    output = io.StringIO()
    call_command(
        "ops_cancel_run",
        org_id=work_org.org_id,
        run_id=run_id,
        ticket="OPS-1024",
        reason="entitlement_revoked",
        stdout=output,
    )
    assert "audit_event=" in output.getvalue()
    with connection.cursor() as cursor:
        cursor.execute("SELECT state FROM work.run WHERE id = %s", [run_id])
        assert cursor.fetchone()[0] == "cancel_requested"

    replay = io.StringIO()
    call_command(
        "ops_cancel_run",
        org_id=work_org.org_id,
        run_id=run_id,
        ticket="OPS-1025",
        reason="entitlement_revoked",
        stdout=replay,
    )
    assert "already terminal" in replay.getvalue()

    with pytest.raises(CommandError):
        call_command(
            "ops_cancel_run",
            org_id=work_org.org_id,
            run_id=run_id,
            ticket="bad",
            reason="entitlement_revoked",
        )


def test_openapi_operations_are_routed():
    uid = "00000000-0000-0000-0000-000000000000"
    paths = [
        "bootstrap",
        "inputs",
        "templates",
        "task-previews",
        "tasks",
        "tasks",
        f"tasks/{uid}",
        f"tasks/{uid}",
        f"tasks/{uid}",
        f"tasks/{uid}/runs",
        f"runs/{uid}",
        f"runs/{uid}/operations",
        f"runs/{uid}/cancel",
        f"tasks/{uid}/events",
        "inbox",
        f"artifacts/{uid}/versions",
        f"artifacts/{uid}/versions/1",
        f"artifacts/{uid}/versions/1/content",
        f"tasks/{uid}/acceptances",
        "me/usage",
        "admin/usage",
        "admin/provider-config",
        "admin/provider-config",
        "admin/provider-config/revoke",
        "admin/provider-credentials",
        f"admin/provider-credentials/{uid}/rotate",
        f"admin/provider-credentials/{uid}/revoke",
        "admin/overview",
        "admin/seats",
        "admin/audit-exports",
        f"admin/audit-exports/{uid}",
        f"admin/audit-exports/{uid}/download-ticket",
        f"admin/audit-exports/{uid}/content",
    ]
    assert len(paths) == 33
    for path in paths:
        assert resolve(f"/work/v1/{path}").func.view_class is not None


def test_api_emits_correlation_and_request_metric(work_org):
    client = client_for(work_org.owner)
    with patch("work.api.middleware.emit") as emit:
        response = client.get("/work/v1/bootstrap")
    assert response.status_code == 200
    assert response["X-Correlation-ID"]
    emit.assert_called_once()
    name, value, labels = emit.call_args.args
    assert name == "work_api_requests_total"
    assert value == 1
    assert labels["status_class"] == "2xx"
    assert labels["method"] == "GET"


def test_unsupported_intent_values_have_contract_error_codes(work_org):
    client = client_for(work_org.owner)
    source = make_input(client)
    bad_target = client.post(
        "/work/v1/task-previews",
        {
            "intent": {
                "input_ref": source["input_ref"],
                "target": {"kind": "device", "profile": "text-v1"},
                "permission_mode": "ask_each",
                "output": {"format": "markdown"},
            }
        },
        format="json",
    )
    assert bad_target.status_code == 422
    assert bad_target.json()["code"] == "execution_target_unavailable"

    bad_mode = make_preview(client, source["input_ref"], "plan_then_run")
    assert bad_mode.status_code == 422
    assert bad_mode.json()["code"] == "permission_mode_unavailable"

    bad_output = client.post(
        "/work/v1/task-previews",
        {
            "intent": {
                "input_ref": source["input_ref"],
                "target": {"kind": "cloud", "profile": "text-v1"},
                "permission_mode": "ask_each",
                "output": {"format": "docx"},
            }
        },
        format="json",
    )
    assert bad_output.status_code == 422
    assert bad_output.json()["code"] == "output_unsupported"

    bad_acceptance = client.post(
        "/work/v1/tasks/00000000-0000-0000-0000-000000000000/acceptances",
        {"client_request_id": "accept-bad-1", "expected_revision": 0},
        format="json",
    )
    assert bad_acceptance.status_code == 422
    assert bad_acceptance.json()["code"] == "acceptance_requires_artifact_or_reason"


def test_input_create_is_idempotent_and_conflicts(work_org):
    client = client_for(work_org.owner)
    payload = {
        "client_request_id": "input-idem-1",
        "goal": "同一份输入",
    }
    first = client.post("/work/v1/inputs", payload, format="json")
    assert first.status_code == 201, first.content
    replay = client.post("/work/v1/inputs", payload, format="json")
    assert replay.status_code == 201
    assert replay.json()["input_ref"] == first.json()["input_ref"]
    conflict = client.post(
        "/work/v1/inputs",
        {"client_request_id": "input-idem-1", "goal": "不同内容"},
        format="json",
    )
    assert conflict.status_code == 409
    assert conflict.json()["code"] == "idempotency_key_conflict"


def test_usage_reads_and_error_codes(work_org):
    owner = client_for(work_org.owner)
    member = client_for(work_org.member)
    with connection.cursor() as cursor:
        cursor.execute(
            "INSERT INTO work.usage_daily "
            "(org_id, subject_id, provider, model, usage_date, input_tokens, "
            "output_tokens, cached_input_tokens, run_count) "
            "VALUES (%s, %s, 'aliyun', 'qwen3.8-flash', %s, 100, 50, 10, 1)",
            [work_org.org_id, work_org.owner.sub, date(2026, 10, 21)],
        )
    user_usage = owner.get("/work/v1/me/usage?from=2026-10-01&to=2026-10-31")
    assert user_usage.status_code == 200, user_usage.content
    assert user_usage.json()["items"][0]["input_tokens"] == 100
    org_usage = owner.get("/work/v1/admin/usage?from=2026-10-01&to=2026-10-31")
    assert org_usage.status_code == 200, org_usage.content
    assert org_usage.json()["items"][0]["run_count"] == 1
    assert (
        member.get("/work/v1/admin/usage?from=2026-10-01&to=2026-10-31").status_code
        == 403
    )

    assert owner.get("/work/v1/tasks?view=nope").json()["code"] == "invalid_view"
    assert owner.get("/work/v1/tasks?limit=0").json()["code"] == "invalid_pagination"
    too_large = owner.post(
        "/work/v1/inputs",
        {"client_request_id": "input-large-1", "goal": "字" * 2001},
        format="json",
    )
    assert too_large.status_code == 422
    assert too_large.json()["code"] == "input_too_large"


def test_task_submit_is_idempotent_and_conflicts_are_contract_shaped(work_org):
    client = client_for(work_org.owner)
    source = make_input(client)
    first, intent = submit_task(client, source, "submit-replay-1")
    preview = make_preview(client, source["input_ref"]).json()
    replay = client.post(
        "/work/v1/tasks",
        {
            "client_request_id": "submit-replay-1",
            "preview_hash": preview["preview_hash"],
            "intent": intent,
        },
        format="json",
    )
    assert replay.status_code == 202
    assert replay.json()["task"]["task_id"] == first["task"]["task_id"]

    conflict_preview = make_preview(client, source["input_ref"], "auto_readonly").json()
    conflict = client.post(
        "/work/v1/tasks",
        {
            "client_request_id": "submit-replay-1",
            "preview_hash": conflict_preview["preview_hash"],
            "intent": {**intent, "permission_mode": "auto_readonly"},
        },
        format="json",
    )
    assert conflict.status_code == 409
    body = conflict.json()
    assert body["code"] == "idempotency_key_conflict"
    assert body["correlation_id"]
    assert body["retryable"] is False

    detail = client.get(f"/work/v1/tasks/{first['task']['task_id']}")
    existing_revision = detail.json()["summary"]["revision"]
    updated = client.patch(
        f"/work/v1/tasks/{first['task']['task_id']}",
        {
            "client_request_id": "title-replay-1",
            "expected_revision": existing_revision,
            "title": "幂等标题",
        },
        format="json",
    )
    assert updated.status_code == 200
    replay_title = client.patch(
        f"/work/v1/tasks/{first['task']['task_id']}",
        {
            "client_request_id": "title-replay-1",
            "expected_revision": existing_revision,
            "title": "幂等标题",
        },
        format="json",
    )
    assert replay_title.status_code == 200


def run_sql(query, params=None, org_id=None):
    with connection.cursor() as cursor:
        cursor.execute("RESET ROLE")
        if org_id:
            cursor.execute("SELECT set_config('app.org_id', %s, true)", [org_id])
        cursor.execute(query, params or [])
        return cursor.fetchone()


def test_artifact_edit_download_and_acceptance(work_org):
    client = client_for(work_org.owner)
    source = make_input(client)
    submitted, _ = submit_task(client, source)
    task_id = submitted["task"]["task_id"]
    run_id = submitted["run"]["id"]
    run_sql(
        "SELECT work.acquire_run(%s, %s)",
        [run_id, work_org.org_id],
        org_id=work_org.org_id,
    )
    ref, content_hash, size = content_store.put(
        work_org.org_id, b"# Draft\n", suffix=".md"
    )
    artifact_id = run_sql(
        "SELECT * FROM work.publish_artifact(%s, %s, %s, 'draft.md', %s, %s, %s, "
        "'text/markdown', '{}'::jsonb)",
        [work_org.org_id, task_id, run_id, ref, content_hash, size],
        org_id=work_org.org_id,
    )[0]
    run_sql(
        "SELECT work.finish_run(%s, %s, 'succeeded', NULL)",
        [run_id, work_org.org_id],
        org_id=work_org.org_id,
    )

    created = client.post(
        f"/work/v1/artifacts/{artifact_id}/versions",
        {
            "client_request_id": "artifact-0001",
            "base_version_no": 1,
            "content": "# Edited\n",
            "media_type": "text/markdown",
        },
        format="json",
    )
    assert created.status_code == 201, created.content
    version = created.json()
    assert version["version_no"] == 2

    inline = client.get(f"/work/v1/artifacts/{artifact_id}/versions/2/content")
    assert inline.status_code == 200
    assert inline.content == b"# Edited\n"
    attachment = client.get(
        f"/work/v1/artifacts/{artifact_id}/versions/2/content?disposition=attachment"
    )
    assert attachment.status_code == 200
    assert "attachment" in attachment["Content-Disposition"]

    detail = client.get(f"/work/v1/tasks/{task_id}")
    revision = detail.json()["summary"]["revision"]
    accepted = client.post(
        f"/work/v1/tasks/{task_id}/acceptances",
        {
            "client_request_id": "accept-0001",
            "expected_revision": revision,
            "artifact_id": str(artifact_id),
            "version_no": 2,
        },
        format="json",
    )
    assert accepted.status_code == 200, accepted.content
    assert accepted.json()["acceptance"]["task_id"] == task_id
    assert accepted.json()["task"]["display_state"] == "completed"


def test_retry_delete_operations_and_events(work_org):
    client = client_for(work_org.owner)
    source = make_input(client)
    submitted, _ = submit_task(client, source)
    task_id = submitted["task"]["task_id"]
    run_id = submitted["run"]["id"]
    run_sql(
        "SELECT work.acquire_run(%s, %s)",
        [run_id, work_org.org_id],
        org_id=work_org.org_id,
    )
    run_sql(
        "SELECT work.finish_run(%s, %s, 'failed', 'runtime_error')",
        [run_id, work_org.org_id],
        org_id=work_org.org_id,
    )

    detail = client.get(f"/work/v1/tasks/{task_id}").json()
    revision = detail["summary"]["revision"]
    retried = client.post(
        f"/work/v1/tasks/{task_id}/runs",
        {
            "client_request_id": "retry-0001",
            "expected_revision": revision,
            "target": {"kind": "cloud", "profile": "text-v1"},
        },
        format="json",
    )
    assert retried.status_code == 202, retried.content
    new_run_id = retried.json()["run"]["id"]
    assert new_run_id != run_id

    operations = client.get(f"/work/v1/runs/{new_run_id}/operations")
    assert operations.status_code == 200
    assert operations.json()["items"] == []

    events = client.get(f"/work/v1/tasks/{task_id}/events")
    assert events.status_code == 200
    assert events["Content-Type"].startswith("text/event-stream")

    run_sql(
        "SELECT work.acquire_run(%s, %s)",
        [new_run_id, work_org.org_id],
        org_id=work_org.org_id,
    )
    run_sql(
        "SELECT work.finish_run(%s, %s, 'succeeded', NULL)",
        [new_run_id, work_org.org_id],
        org_id=work_org.org_id,
    )
    current = client.get(f"/work/v1/tasks/{task_id}").json()["summary"]["revision"]
    deleted = client.delete(f"/work/v1/tasks/{task_id}?expected_revision={current}")
    assert deleted.status_code == 200, deleted.content
    assert deleted.json()["content_purge"] == "scheduled"


def test_sse_resync_and_last_event_id(work_org):
    client = client_for(work_org.owner)
    source = make_input(client)
    submitted, _ = submit_task(client, source)
    task_id = submitted["task"]["task_id"]
    bad = client.get(
        f"/work/v1/tasks/{task_id}/events",
        HTTP_LAST_EVENT_ID="00000000-0000-0000-0000-000000000000",
    )
    assert bad.status_code == 409
    assert bad.json()["code"] == "resync_required"
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT id FROM work.task_event WHERE org_id = %s AND task_id = %s "
            "ORDER BY seq LIMIT 1",
            [work_org.org_id, task_id],
        )
        event_id = cursor.fetchone()[0]
    replay = client.get(
        f"/work/v1/tasks/{task_id}/events",
        HTTP_LAST_EVENT_ID=str(event_id),
    )
    assert replay.status_code == 200
    assert replay["Content-Type"].startswith("text/event-stream")


def test_outbox_relay_delivers_and_dead_letters(work_org):
    client = client_for(work_org.owner)
    source = make_input(client)
    submitted, _ = submit_task(client, source)
    result = run_relay("relay-test", limit=50)
    assert result["delivered"] >= 1
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT count(*) FROM work.outbox WHERE org_id = %s "
            "AND delivered_at IS NOT NULL",
            [work_org.org_id],
        )
        assert cursor.fetchone()[0] >= 1

        aggregate_id = uuid.uuid4()
        cursor.execute(
            "INSERT INTO work.outbox "
            "(org_id, aggregate_type, aggregate_id, event_id, payload, available_at, attempts) "
            "VALUES (%s, 'test', %s, %s, '{\"kind\":\"fail_test\"}'::jsonb, "
            "now() - interval '1 second', 9)",
            [work_org.org_id, aggregate_id, uuid.uuid4()],
        )
        cursor.execute(
            "INSERT INTO work.outbox "
            "(org_id, aggregate_type, aggregate_id, event_id, payload, available_at) "
            "VALUES (%s, 'test', %s, %s, '{\"kind\":\"blocked\"}'::jsonb, "
            "now() - interval '1 second')",
            [work_org.org_id, aggregate_id, uuid.uuid4()],
        )

    def boom(event):
        raise RuntimeError("forced")

    failed = run_relay("relay-fail", deliver_fn=boom, limit=50)
    assert failed["failed"] >= 1
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT dead_lettered_at FROM work.outbox WHERE org_id = %s "
            "AND aggregate_type = 'test' AND payload->>'kind' = 'fail_test'",
            [work_org.org_id],
        )
        assert cursor.fetchone()[0] is not None
    blocked = run_relay("relay-after-dead", limit=50)
    assert blocked["claimed"] == 0


def test_local_orchestration_slice_runs_to_artifact_and_usage(work_org):
    client = client_for(work_org.owner)
    source = make_input(client)
    submitted, _ = submit_task(client, source)
    run_id = submitted["run"]["id"]
    result = run_local_workflow(
        run_id,
        work_org.org_id,
        gateway=FauxModelGateway(
            content="# 结果\n",
            usage=UsageReport(input_tokens=80, output_tokens=20, cached_input_tokens=5),
        ),
    )
    assert result.settled_tokens == 100
    task_id = submitted["task"]["task_id"]
    detail = client.get(f"/work/v1/tasks/{task_id}")
    assert detail.status_code == 200, detail.content
    assert detail.json()["summary"]["display_state"] == "awaiting_acceptance"
    assert detail.json()["summary"]["latest_artifact"]["version_no"] == 1

    run = client.get(f"/work/v1/runs/{run_id}")
    assert run.json()["state"] == "succeeded"

    usage = client.get(
        f"/work/v1/me/usage?from={date.today().isoformat()}"
        f"&to={date.today().isoformat()}"
    )
    assert usage.status_code == 200, usage.content
    assert usage.json()["items"][0]["provider"] == "aliyun"
    assert usage.json()["items"][0]["input_tokens"] == 80

    content = client.get(f"/work/v1/artifacts/{result.artifact_id}/versions/1/content")
    assert content.status_code == 200
    assert content.content == "# 结果\n".encode()


def test_dead_letter_requeue_and_skip_commands(work_org):
    with connection.cursor() as cursor:
        for event_id in (uuid.uuid4(), uuid.uuid4()):
            cursor.execute(
                "INSERT INTO work.outbox "
                "(org_id, aggregate_type, aggregate_id, event_id, payload, "
                "available_at, attempts, dead_lettered_at, last_error_code) "
                "VALUES (%s, 'test', %s, %s, '{\"kind\":\"manual\"}'::jsonb, "
                "now(), 10, now(), 'delivery_failed')",
                [work_org.org_id, uuid.uuid4(), event_id],
            )
        cursor.execute(
            "SELECT event_id FROM work.outbox WHERE org_id = %s "
            "AND aggregate_type = 'test' ORDER BY created_at",
            [work_org.org_id],
        )
        first, second = [row[0] for row in cursor.fetchall()[:2]]

    call_command(
        "work_outbox_dead_letter",
        org_id=work_org.org_id,
        event_id=str(first),
        action="requeue",
        reason="incident reviewed",
    )
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT dead_lettered_at, attempts FROM work.outbox WHERE event_id = %s",
            [first],
        )
        assert cursor.fetchone() == (None, 0)

    call_command(
        "work_outbox_dead_letter",
        org_id=work_org.org_id,
        event_id=str(second),
        action="skip",
        reason="event no longer needed",
    )
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT delivered_at, last_error_code FROM work.outbox WHERE event_id = %s",
            [second],
        )
        delivered_at, error_code = cursor.fetchone()
    assert delivered_at is not None
    assert error_code == "skipped_by_ops"


def test_expiry_sweep_queues_and_shreds_unbound_input(work_org):
    client = client_for(work_org.owner)
    source = make_input(client)
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE work.input_object SET expires_at = now() - interval '1 minute' "
            "WHERE org_id = %s AND id = %s",
            [work_org.org_id, source["input_ref"]],
        )
        cursor.execute(
            "SELECT content_ref FROM work.input_object WHERE org_id = %s AND id = %s",
            [work_org.org_id, source["input_ref"]],
        )
        content_ref = cursor.fetchone()[0]

    result = run_expiry_sweep()
    assert result["inputs"] >= 1
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT status FROM work.input_object WHERE org_id = %s AND id = %s",
            [work_org.org_id, source["input_ref"]],
        )
        assert cursor.fetchone()[0] == "expired"
        cursor.execute(
            "SELECT payload->>'kind' FROM work.outbox WHERE org_id = %s "
            "AND aggregate_type = 'content' ORDER BY created_at DESC LIMIT 1",
            [work_org.org_id],
        )
        assert cursor.fetchone()[0] == "content_shred"

    run_relay("shred-relay", limit=50)
    with pytest.raises(ContentStoreError):
        content_store.get(work_org.org_id, content_ref)
