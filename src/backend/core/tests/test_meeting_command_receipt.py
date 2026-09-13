"""Receipts are additive, source-bound and absent from errors or unkeyed reads."""

import uuid

import pytest
from rest_framework.response import Response
from rest_framework.test import APIRequestFactory
from rest_framework.views import APIView

from core.api.meeting_command_receipt import MeetingCommandReceiptMixin


class FixtureView(MeetingCommandReceiptMixin, APIView):
    authentication_classes = ()
    permission_classes = ()

    def post(self, request, **kwargs):
        """Simulate a validated business handler, not a production endpoint."""
        return Response({"accepted": True}, status=request.data.get("status", 200))

    def get(self, request, **kwargs):
        """Read responses cannot acknowledge commands."""
        return Response({"accepted": True})


@pytest.mark.parametrize("field", ["record_id", "capture_id"])
def test_success_binds_exact_key_and_route_source(field):
    key, source = str(uuid.uuid4()), uuid.uuid4()
    request = APIRequestFactory().post("/fixture/", {"key": key}, format="json")
    response = FixtureView.as_view()(request, **{field: source})
    assert response.data["command_receipt"] == {
        "key": key,
        "scope": {field: str(source)},
    }
    assert response["Cache-Control"] == "private, no-store"


def test_header_key_and_room_occurrence_are_preserved():
    key = str(uuid.uuid4())
    scope = {"room_id": str(uuid.uuid4()), "livekit_room_sid": "RM_exact"}
    request = APIRequestFactory().post(
        "/fixture/", scope, format="json", HTTP_IDEMPOTENCY_KEY=key
    )
    response = FixtureView.as_view()(request)
    assert response.data["command_receipt"] == {"key": key, "scope": scope}


@pytest.mark.parametrize("status", [400, 401, 403, 404, 408, 409, 429, 503])
def test_errors_never_acknowledge_a_command(status):
    request = APIRequestFactory().post(
        "/fixture/", {"key": str(uuid.uuid4()), "status": status}, format="json"
    )
    response = FixtureView.as_view()(request, record_id=uuid.uuid4())
    assert "command_receipt" not in response.data


def test_reads_and_unkeyed_previews_are_unchanged():
    for request in (
        APIRequestFactory().get("/fixture/"),
        APIRequestFactory().post("/fixture/", {}, format="json"),
    ):
        assert FixtureView.as_view()(request, record_id=uuid.uuid4()).data == {
            "accepted": True
        }
