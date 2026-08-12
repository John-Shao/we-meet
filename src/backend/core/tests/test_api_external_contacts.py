"""API tests for mutual external contacts."""

from datetime import timedelta

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core import factories, models

pytestmark = pytest.mark.django_db


def _membership(org, user):
    return models.Membership.objects.create(
        organization=org, user=user, is_primary=True
    )


def _people():
    org = factories.OrganizationFactory(name="Acme")
    other_org = factories.OrganizationFactory(name="Partner")
    me = factories.UserFactory(email="me@acme.test", phone="13800000001")
    colleague = factories.UserFactory(email="peer@acme.test", phone="13800000002")
    partner = factories.UserFactory(
        full_name="Partner Person",
        email="friend@partner.test",
        phone="13900000001",
    )
    _membership(org, me)
    _membership(org, colleague)
    _membership(other_org, partner)
    return me, colleague, partner


def _times():
    start = timezone.now() + timedelta(days=1)
    return start, start + timedelta(hours=1)


def test_external_contact_search_is_exact_and_excludes_internal_members():
    me, colleague, partner = _people()
    client = APIClient()
    client.force_login(me)

    assert (
        client.get("/api/v1.0/directory/external-contacts/search/?q=friend").json()
        == []
    )
    assert (
        client.get(
            f"/api/v1.0/directory/external-contacts/search/?q={colleague.email}"
        ).json()
        == []
    )
    response = client.get(
        f"/api/v1.0/directory/external-contacts/search/?q={partner.email.upper()}"
    )

    assert response.status_code == 200
    assert response.json()[0]["id"] == str(partner.id)
    assert response.json()[0]["organization"]["name"] == "Partner"
    assert response.json()[0]["status"] == "none"


def test_external_contact_request_accept_list_and_delete():
    me, _, partner = _people()
    mine = APIClient()
    mine.force_login(me)
    sent = mine.post(
        "/api/v1.0/directory/external-contacts/requests/",
        {"target_user_id": str(partner.id)},
        format="json",
    )
    assert sent.status_code == 201, sent.content
    relationship_id = sent.json()["relationship_id"]
    assert sent.json()["direction"] == "outgoing"

    theirs = APIClient()
    theirs.force_login(partner)
    incoming = theirs.get("/api/v1.0/directory/external-contacts/requests/").json()
    assert incoming[0]["id"] == str(me.id)
    assert incoming[0]["direction"] == "incoming"

    accepted = theirs.post(
        f"/api/v1.0/directory/external-contacts/{relationship_id}/accept/"
    )
    assert accepted.status_code == 200, accepted.content
    assert accepted.json()["status"] == "accepted"
    assert mine.get("/api/v1.0/directory/external-contacts/").json()[0]["id"] == str(
        partner.id
    )

    deleted = mine.delete(f"/api/v1.0/directory/external-contacts/{relationship_id}/")
    assert deleted.status_code == 204
    assert theirs.get("/api/v1.0/directory/external-contacts/").json() == []


def test_calendar_accepts_only_an_accepted_external_contact_account():
    me, _, partner = _people()
    client = APIClient()
    client.force_login(me)
    start, end = _times()
    payload = {
        "title": "Partner review",
        "start_at": start.isoformat(),
        "end_at": end.isoformat(),
        "attendee_entries": [{"user_id": str(partner.id)}],
    }

    before = client.post("/api/v1.0/calendar-events/", payload, format="json")
    assert before.status_code == 201, before.content
    first = models.CalendarEvent.objects.get(id=before.json()["id"])
    assert not first.attendees.filter(user=partner).exists()

    user_a, user_b = models.ExternalContact.canonical_pair(me, partner)
    models.ExternalContact.objects.create(
        user_a=user_a,
        user_b=user_b,
        requested_by=me,
        status=models.ExternalContactStatusChoices.ACCEPTED,
    )
    after = client.post("/api/v1.0/calendar-events/", payload, format="json")
    assert after.status_code == 201, after.content
    event = models.CalendarEvent.objects.get(id=after.json()["id"])
    assert event.attendees.filter(user=partner).exists()

    partner_client = APIClient()
    partner_client.force_login(partner)
    visible_ids = {
        item["id"]
        for item in partner_client.get("/api/v1.0/calendar-events/").json()["results"]
    }
    assert str(event.id) in visible_ids


def test_calendar_rejects_email_only_attendee_input():
    me, _, partner = _people()
    client = APIClient()
    client.force_login(me)
    start, end = _times()
    response = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "No orphan guests",
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "attendee_entries": [{"email": partner.email}],
        },
        format="json",
    )
    assert response.status_code == 400
