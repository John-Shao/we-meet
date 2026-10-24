"""Work access-audit list and CSV export (P1-A, acceptance §3.5)."""

import csv
import io
import json
from unittest.mock import patch

from django.test import override_settings

import pytest
from rest_framework.test import APIClient

from core import factories
from core import models as core_models

from work.api_admin import AUDIT_COLUMNS, _csv_cell
from work.models import WorkAccessAudit

pytestmark = pytest.mark.django_db

AUDIT = "/api/v1.0/work/admin/access-audit/"
EXPORT = "/api/v1.0/work/admin/access-audit/export/"


def _world():
    organization = factories.OrganizationFactory()
    owner = factories.UserFactory(full_name="Owner", short_name="Owner")
    core_models.Membership.objects.create(
        organization=organization,
        user=owner,
        org_role=core_models.OrgRoleChoices.OWNER,
        is_primary=True,
    )
    return organization, owner


def _client(user):
    client = APIClient()
    client.force_login(user)
    return client


def _row(  # noqa: PLR0913 - mirrors the fields each test varies
    organization,
    *,
    actor=None,
    action="grant_updated",
    before=None,
    after=None,
    target_id="target-1",
    request_id="req-1",
):
    return WorkAccessAudit.objects.create(
        organization=organization,
        actor=actor,
        action=action,
        target_type="grant",
        target_id=target_id,
        request_id=request_id,
        before=before or {},
        after=after or {},
    )


def _csv_rows(response):
    body = b"".join(response.streaming_content).decode("utf-8")
    assert body.startswith("\ufeff")
    return body, list(csv.reader(io.StringIO(body.lstrip("\ufeff"))))


def test_list_returns_the_documented_columns_for_the_callers_organization():
    organization, owner = _world()
    actor = factories.UserFactory(full_name="Alice", short_name="A")
    _row(
        organization,
        actor=actor,
        before={"enabled": True},
        after={"enabled": False},
    )
    _row(factories.OrganizationFactory(), target_id="other-org")

    response = _client(owner).get(AUDIT)

    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 1
    row = body["results"][0]
    assert set(row) == {
        "created_at",
        "action",
        "actor_label",
        "target_type",
        "target_id",
        "request_id",
        "changed",
    }
    assert row["actor_label"] == "Alice"
    assert row["changed"] == {"enabled": {"before": True, "after": False}}


def test_list_requires_org_audit_read():
    organization = _world()[0]
    member = factories.UserFactory()
    core_models.Membership.objects.create(
        organization=organization, user=member, is_primary=True
    )

    response = _client(member).get(AUDIT)

    assert response.status_code == 403
    assert response.json() == {
        "code": "missing_permission",
        "meta": {"permission": "org.audit.read"},
    }


def test_actor_label_never_falls_back_to_email():
    organization, owner = _world()
    actor = factories.UserFactory(full_name="", short_name="", email="leak@example.com")
    _row(organization, actor=actor)

    response = _client(owner).get(AUDIT)

    assert response.json()["results"][0]["actor_label"] == str(actor.id)
    assert "leak@example.com" not in response.content.decode()


def test_changed_is_whitelisted_and_drops_payload_keys():
    organization, owner = _world()
    _row(
        organization,
        before={
            "enabled": True,
            "features": {"a": 1, "b": 2},
            "storage_key": "s3://secret-bucket/key",
            "phone": "+8613800001111",
        },
        after={
            "enabled": False,
            "features": {"a": 1},
            "storage_key": "s3://secret-bucket/other",
            "phone": "+8613800002222",
        },
    )

    response = _client(owner).get(AUDIT)

    changed = response.json()["results"][0]["changed"]
    assert changed == {
        "enabled": {"before": True, "after": False},
        "features_count": {"before": 2, "after": 1},
    }
    body = response.content.decode()
    assert "secret-bucket" not in body
    assert "13800001111" not in body


def test_export_is_a_bom_prefixed_csv_of_the_same_columns():
    organization, owner = _world()
    _row(organization, target_id="row-1")

    response = _client(owner).get(EXPORT)

    assert response.status_code == 200
    assert response["Content-Type"].startswith("text/csv")
    disposition = response["Content-Disposition"]
    assert disposition.startswith("attachment; filename=")
    assert str(organization.id)[:8] in disposition
    _body, rows = _csv_rows(response)
    assert rows[0] == list(AUDIT_COLUMNS)
    assert rows[1][AUDIT_COLUMNS.index("target_id")] == "row-1"


@pytest.mark.parametrize("prefix", ["=", "+", "-", "@"])
def test_dangerous_cells_get_a_quote_prefix(prefix):
    assert _csv_cell(f"{prefix}cmd|calc") == f"'{prefix}cmd|calc"


def test_export_prefixes_user_controlled_cells():
    organization, owner = _world()
    actor = factories.UserFactory(full_name='=HYPERLINK("http://evil")', short_name="")
    _row(organization, actor=actor, request_id="=cmd|calc")

    _body, rows = _csv_rows(_client(owner).get(EXPORT))

    data = rows[1]
    assert data[AUDIT_COLUMNS.index("actor_label")].startswith("'=")
    assert data[AUDIT_COLUMNS.index("request_id")].startswith("'=")


def test_export_never_contains_emails_phones_or_storage_keys():
    organization, owner = _world()
    actor = factories.UserFactory(email="leak@example.com")
    _row(
        organization,
        actor=actor,
        before={
            "enabled": True,
            "phone": "+8613800001111",
            "storage_key": "s3://secret-bucket/key",
            "secret_token": "sk-live-123456",
        },
        after={"enabled": False},
    )

    body, _rows = _csv_rows(_client(owner).get(EXPORT))

    assert "leak@example.com" not in body
    assert "13800001111" not in body
    assert "secret-bucket" not in body
    assert "sk-live-123456" not in body


def test_export_records_its_own_row_without_content():
    organization, owner = _world()
    _row(
        organization,
        action="grant_updated",
        before={"enabled": True},
        after={"enabled": False, "revoked_reason": "SECRET-MARKER"},
    )

    response = _client(owner).get(EXPORT, {"action": "grant_updated"})

    assert response.status_code == 200
    exported = WorkAccessAudit.objects.get(action="access_audit_exported")
    assert exported.organization_id == organization.id
    assert exported.actor_id == owner.id
    assert exported.target_type == "export"
    assert exported.after["rows"] == 1
    assert exported.after["action"] == "grant_updated"
    assert "SECRET-MARKER" not in json.dumps(exported.after)


def test_the_export_row_appears_in_the_next_export():
    """The first file must not list itself; the second one must — that is the
    only proof the export itself left a trail."""
    organization, owner = _world()
    _row(organization, action="grant_updated")
    client = _client(owner)

    first_body, _first_rows = _csv_rows(client.get(EXPORT))
    _body, rows = _csv_rows(client.get(EXPORT))

    assert "access_audit_exported" not in first_body
    actions = [row[AUDIT_COLUMNS.index("action")] for row in rows[1:]]
    assert actions == ["access_audit_exported", "grant_updated"]


@override_settings(WORK_ACCESS_AUDIT_EXPORT_MAX_ROWS=2)
def test_export_above_the_limit_is_refused_before_streaming():
    organization, owner = _world()
    for index in range(3):
        _row(organization, target_id=f"row-{index}")

    response = _client(owner).get(EXPORT)

    assert response.status_code == 409
    assert response.json() == {
        "code": "export_too_large",
        "meta": {"limit": 2},
    }
    assert not WorkAccessAudit.objects.filter(action="access_audit_exported").exists()


def test_export_audit_failure_does_not_break_the_stream():
    organization, owner = _world()
    _row(organization, target_id="still-here")

    with patch.object(
        WorkAccessAudit.objects, "create", side_effect=RuntimeError("audit down")
    ):
        response = _client(owner).get(EXPORT)

    assert response.status_code == 200
    _body, rows = _csv_rows(response)
    assert rows[1][AUDIT_COLUMNS.index("target_id")] == "still-here"


def test_export_is_scoped_to_the_callers_organization():
    organization, owner = _world()
    _row(organization, target_id="mine")
    _row(factories.OrganizationFactory(), target_id="theirs")

    body, _rows = _csv_rows(_client(owner).get(EXPORT))

    assert "mine" in body
    assert "theirs" not in body


def test_invalid_filters_are_rejected():
    organization, owner = _world()
    client = _client(owner)

    assert client.get(AUDIT, {"action": "nope"}).status_code == 400
    assert client.get(AUDIT, {"from": "not-a-date"}).status_code == 400
