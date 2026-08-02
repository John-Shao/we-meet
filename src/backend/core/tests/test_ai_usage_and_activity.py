"""AI-spend metering and per-user activity counters (P10 M2).

Both are "only recorded, not shown yet" — the dashboard that reads them is M3.
So the tests are about the properties that are expensive to fix later:

- cost is computed at write time and frozen (a rate change must not rewrite
  last month's numbers);
- metering never breaks the feature it measures;
- the activity write path is atomic and rate-limited, and the middleware never
  touches the database.
"""

from datetime import timedelta

import pytest
from django.core.cache import cache
from django.utils import timezone

from core import factories, models
from core.services import activity, ai_usage

pytestmark = pytest.mark.django_db


def _org_member():
    organization = factories.OrganizationFactory()
    user = factories.UserFactory()
    models.Membership.objects.create(
        organization=organization, user=user, is_primary=True
    )
    return organization, user


def _priced_model(code="vendor/m1", inp=3_000_000, out=9_000_000, per_min=0):
    vendor = models.AIVendor.objects.create(code="v1", display_name="V1")
    return models.AIModel.objects.create(
        vendor=vendor,
        capability=models.AIModel.Capability.LLM,
        code=code,
        display_name=code,
        price_input_per_mtok=inp,
        price_output_per_mtok=out,
        price_per_minute=per_min,
    )


class _FakeUsage:
    def __init__(self, prompt, completion):
        self.prompt_tokens = prompt
        self.completion_tokens = completion


class _FakeResponse:
    def __init__(self, usage=None):
        if usage is not None:
            self.usage = usage


# --- cost ------------------------------------------------------------------


def test_cost_is_integer_micro_currency():
    """Float cents drift over a month of summing; these rows are summed by the thousand."""
    _priced_model(inp=3_000_000, out=9_000_000)
    cost = ai_usage.compute_cost_micros(
        "vendor/m1", input_tokens=1_000_000, output_tokens=500_000
    )
    assert cost == 3_000_000 + 4_500_000
    assert isinstance(cost, int)


def test_audio_is_priced_per_minute():
    _priced_model(inp=0, out=0, per_min=6_000)
    assert ai_usage.compute_cost_micros("vendor/m1", audio_seconds=120) == 12_000


def test_unpriced_model_costs_zero_rather_than_failing():
    """An unconfigured model must still be usable — metering is not a gate."""
    assert ai_usage.compute_cost_micros("nobody/knows", input_tokens=1000) == 0


def test_cost_is_frozen_on_the_row_not_recomputed():
    """Renegotiating a rate must not silently rewrite last month's numbers."""
    model = _priced_model(inp=3_000_000, out=0)
    organization, user = _org_member()
    record = ai_usage.record_usage(
        user=user,
        organization=organization,
        kind=models.AIUsageKindChoices.SUMMARY,
        model_code=model.code,
        input_tokens=1_000_000,
    )
    assert record.cost_micros == 3_000_000

    model.price_input_per_mtok = 30_000_000
    model.save()
    record.refresh_from_db()
    assert record.cost_micros == 3_000_000


def test_record_usage_resolves_the_organization_from_the_user():
    organization, user = _org_member()
    record = ai_usage.record_usage(
        user=user, kind=models.AIUsageKindChoices.PERSONAL_AI
    )
    assert record.organization_id == organization.id


def test_record_usage_never_raises():
    """Metering failure must not take down the feature it measures."""
    # A kind that violates the column's choices — the write fails at full_clean.
    # The call must swallow it and hand back None, not propagate.
    assert (
        ai_usage.record_usage(kind="definitely-not-a-valid-kind", input_tokens=1)
        is None
    )
    assert not models.AIUsageRecord.objects.exists()


# --- reading the provider's usage block ------------------------------------


def test_usage_is_read_from_an_openai_style_response():
    parsed = ai_usage.usage_from_response(_FakeResponse(_FakeUsage(120, 40)))
    assert parsed == {"input_tokens": 120, "output_tokens": 40}


def test_missing_usage_block_is_zeros_not_an_error():
    """Several China-region endpoints omit `usage` entirely."""
    assert ai_usage.usage_from_response(_FakeResponse()) == {
        "input_tokens": 0,
        "output_tokens": 0,
    }


def test_make_sink_writes_a_row():
    organization, user = _org_member()
    _priced_model()
    sink = ai_usage.make_sink(
        user=user,
        kind=models.AIUsageKindChoices.GLOBAL_ASK,
        ref_type="question",
        ref_id="abc",
    )
    sink(model_code="vendor/m1", input_tokens=1_000_000, output_tokens=0)

    record = models.AIUsageRecord.objects.get()
    assert record.kind == models.AIUsageKindChoices.GLOBAL_ASK
    assert record.organization_id == organization.id
    assert record.cost_micros == 3_000_000


def test_llm_client_reports_usage_through_the_sink():
    """The gap this closes: llm_client used to discard `usage` entirely."""
    from core.services.llm_client import LLMClient

    seen = {}

    class _FakeCompletions:
        def create(self, **_kwargs):
            class _Message:
                content = "hi"

            class _Choice:
                message = _Message()

            return type(
                "R", (), {"choices": [_Choice()], "usage": _FakeUsage(10, 5)}
            )()

    client = LLMClient(api_key="k", model="vendor/m1")
    client._client = type(  # noqa: SLF001 — swapping the transport for a fake
        "C", (), {"chat": type("X", (), {"completions": _FakeCompletions()})()}
    )()

    client.chat(
        system="s",
        user="u",
        usage_sink=lambda **kwargs: seen.update(kwargs),
    )
    assert seen == {
        "model_code": "vendor/m1",
        "input_tokens": 10,
        "output_tokens": 5,
    }


def test_a_broken_sink_does_not_break_the_completion():
    from core.services.llm_client import LLMClient

    class _FakeCompletions:
        def create(self, **_kwargs):
            class _Message:
                content = "answer"

            class _Choice:
                message = _Message()

            return type("R", (), {"choices": [_Choice()], "usage": None})()

    client = LLMClient(api_key="k", model="m")
    client._client = type(  # noqa: SLF001
        "C", (), {"chat": type("X", (), {"completions": _FakeCompletions()})()}
    )()

    def explode(**_kwargs):
        raise RuntimeError("metering is down")

    assert client.chat(system="s", user="u", usage_sink=explode) == "answer"


# --- activity --------------------------------------------------------------


def test_path_maps_to_a_module():
    assert activity.module_for_path("/api/v1.0/im/conversations/") == "im_count"
    assert activity.module_for_path("/api/v1.0/rooms/abc/") == "meeting_count"
    assert activity.module_for_path("/api/v1.0/calendar/events/") == "calendar_count"
    # Things that are not product usage count as nothing.
    assert activity.module_for_path("/api/v1.0/directory/me/") is None
    assert activity.module_for_path("/static/app.js") is None


def test_dedupe_window_allows_one_write_per_module():
    cache.clear()
    today = timezone.localdate()
    assert activity.should_record("u1", "im_count", today) is True
    assert activity.should_record("u1", "im_count", today) is False
    # A different module in the same window is a separate counter.
    assert activity.should_record("u1", "meeting_count", today) is True


def test_record_activity_creates_then_increments():
    organization, user = _org_member()
    activity.record_activity(user.id, organization.id, "im_count")
    activity.record_activity(user.id, organization.id, "im_count")

    row = models.UserDailyActivity.objects.get(user=user)
    assert row.im_count == 2
    assert row.meeting_count == 0
    assert row.last_seen_at is not None


def test_record_activity_resolves_the_organization_when_omitted():
    """The middleware deliberately does not resolve it — that would be a query."""
    organization, user = _org_member()
    activity.record_activity(user.id, module="im_count")

    assert models.UserDailyActivity.objects.get(user=user).organization_id == (
        organization.id
    )


def test_someone_with_no_membership_is_not_counted():
    user = factories.UserFactory()
    activity.record_activity(user.id, module="im_count")
    assert not models.UserDailyActivity.objects.filter(user=user).exists()


def test_unknown_module_is_ignored():
    organization, user = _org_member()
    activity.record_activity(user.id, organization.id, "not_a_column")
    assert not models.UserDailyActivity.objects.exists()


def test_purge_drops_rows_past_retention():
    organization, user = _org_member()
    old = models.UserDailyActivity.objects.create(
        organization=organization,
        user=user,
        date=timezone.localdate() - timedelta(days=activity.RETENTION_DAYS + 1),
    )
    fresh = models.UserDailyActivity.objects.create(
        organization=organization, user=user, date=timezone.localdate()
    )

    activity.purge_old_activity()

    assert not models.UserDailyActivity.objects.filter(pk=old.pk).exists()
    assert models.UserDailyActivity.objects.filter(pk=fresh.pk).exists()


def test_middleware_hands_the_write_to_the_task_and_does_none_itself(monkeypatch):
    """Every request in the product passes through this — it must stay cache-only.

    Stubbing the task is what makes the claim testable: with the real one, the
    synchronous Celery fallback would write from inside the middleware call and
    the two would be indistinguishable.
    """
    from core.middleware.activity import ActivityMiddleware
    from core.tasks import activity as activity_task

    cache.clear()
    _organization, user = _org_member()
    calls = []
    monkeypatch.setattr(
        activity_task.record_activity, "delay", lambda *a: calls.append(a)
    )

    class _Request:
        path = "/api/v1.0/im/conversations/"

    request = _Request()
    request.user = user
    middleware = ActivityMiddleware(lambda _r: type("R", (), {"status_code": 200})())
    middleware(request)

    assert calls == [(str(user.id), None, "im_count")]
    # Nothing written by the middleware itself.
    assert not models.UserDailyActivity.objects.exists()


def test_middleware_ignores_failed_and_anonymous_requests():
    from django.contrib.auth.models import AnonymousUser

    from core.middleware.activity import ActivityMiddleware

    cache.clear()
    _organization, user = _org_member()

    class _Request:
        path = "/api/v1.0/im/conversations/"

    forbidden = ActivityMiddleware(lambda _r: type("R", (), {"status_code": 403})())
    request = _Request()
    request.user = user
    forbidden(request)
    assert not models.UserDailyActivity.objects.exists()

    anonymous = ActivityMiddleware(lambda _r: type("R", (), {"status_code": 200})())
    anon_request = _Request()
    anon_request.user = AnonymousUser()
    anonymous(anon_request)
    assert not models.UserDailyActivity.objects.exists()


# --- room org scoping ------------------------------------------------------


def test_room_is_stamped_with_the_creators_organization():
    from rest_framework.test import APIClient

    organization, user = _org_member()
    client = APIClient()
    client.force_login(user)

    response = client.post("/api/v1.0/rooms/", {"name": "标准周会"}, format="json")
    assert response.status_code == 201, response.data

    room = models.Room.objects.get(id=response.data["id"])
    assert room.organization_id == organization.id


def test_a_room_from_someone_with_no_membership_is_left_unstamped():
    """Reporting scope, not access control — an unattributable room stays null."""
    from rest_framework.test import APIClient

    user = factories.UserFactory()
    client = APIClient()
    client.force_login(user)

    response = client.post("/api/v1.0/rooms/", {"name": "临时房"}, format="json")
    assert response.status_code == 201, response.data
    assert models.Room.objects.get(id=response.data["id"]).organization_id is None
