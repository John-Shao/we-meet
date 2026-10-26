"""Management command wrapper around the organization lifecycle service (P0-4)."""
# pylint: disable=missing-function-docstring,redefined-outer-name

import io
import json

from django.core.management import call_command
from django.core.management.base import CommandError

import pytest

from core import factories, models

pytestmark = pytest.mark.django_db

COMMAND = "organization_lifecycle"


def _call(*args):
    out = io.StringIO()
    call_command(COMMAND, *args, stdout=out)
    return json.loads(out.getvalue())


@pytest.fixture
def org():
    return factories.OrganizationFactory()


@pytest.fixture
def actor():
    return factories.UserFactory()


def test_dry_run_does_not_write(org):
    payload = _call("archive", org.slug, "--dry-run")

    assert payload["dry_run"] is True
    assert payload["state"] == "active"
    assert payload["counts"] == {}
    org.refresh_from_db()
    assert org.archived_at is None


def test_archive_requires_matching_confirmation(org):
    with pytest.raises(CommandError):
        _call("archive", org.slug)
    with pytest.raises(CommandError):
        _call("archive", org.slug, "--confirm", "another-org")
    org.refresh_from_db()
    assert org.archived_at is None


def test_archive_and_restore_through_the_command(org, actor):
    archived = _call(
        "archive",
        str(org.pk),
        "--confirm",
        org.slug,
        "--actor",
        actor.email,
        "--reason",
        "contract ended",
    )
    assert archived["action"] == "archive"
    assert archived["changed"] is True
    org.refresh_from_db()
    assert org.archived_at is not None
    assert org.archive_reason == "contract ended"
    assert (
        models.AuditLog.objects.get(
            action=models.AuditActionChoices.ORGANIZATION_ARCHIVED
        ).actor_id
        == actor.id
    )

    restored = _call("restore", org.slug, "--confirm", org.slug, "--actor", actor.email)
    assert restored["changed"] is True
    org.refresh_from_db()
    assert org.archived_at is None and org.is_active is True


def test_archived_organization_cannot_be_suspended_by_command(org):
    from core.services import organization_lifecycle

    organization_lifecycle.archive(org)
    with pytest.raises(CommandError) as exc:
        _call("suspend", org.slug)
    assert "organization_archived" in str(exc.value)
