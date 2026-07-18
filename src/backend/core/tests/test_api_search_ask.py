"""P1-4 M1 全局搜索 AI 问答:多源权限边界 / 罐头 / 熔断降级 / 引用提取 / 端点 gate。"""

# pylint: disable=redefined-outer-name,unused-argument,protected-access

from datetime import datetime, timedelta, timezone as dt_timezone
from unittest import mock
from zoneinfo import ZoneInfo

import pytest
from django.core.cache import cache
from rest_framework.test import APIClient

from core import factories, models
from core.services import global_ask as ga
from core.services.global_ask import GlobalAskService

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _clear_cache():
    cache.clear()
    yield
    cache.clear()


def _fake_llm(answer="答案[1]。", model="ep-test"):
    llm = mock.Mock()
    llm.model = model
    llm.chat.return_value = answer
    llm.chat_stream.return_value = iter([answer])
    return llm


def _fake_embed(dim=8):
    client = mock.Mock()
    client.model = "emb-test"
    client.embed.return_value = [0.5] * dim
    return client


def _room_with_chunk(user, *, text="Q3 预算已确认上调", name="预算评审会"):
    room = factories.RoomFactory(name=name)
    room.users.add(user)
    summary = models.Summary.objects.create(
        room=room, content="x", status=models.Summary.Status.SUCCESS
    )
    models.TranscriptChunk.objects.create(
        room=room,
        summary=summary,
        chunk_index=0,
        speaker_identity="sub-1",
        speaker_name="张三",
        text=text,
        started_at=datetime(2026, 7, 10, 2, 0, tzinfo=dt_timezone.utc),
        ended_at=datetime(2026, 7, 10, 2, 5, tzinfo=dt_timezone.utc),
        embedding=[0.5] * 8,
        embedding_model="emb-test",
    )
    return room, summary


# ---- 权限边界(每源一条跨用户负例,最高危面) ----


def test_transcripts_not_visible_across_users():
    owner, outsider = factories.UserFactory(), factories.UserFactory()
    _room_with_chunk(owner)

    svc = GlobalAskService(embed=_fake_embed(), llm=_fake_llm())
    result = svc.ask(user=outsider, question="预算确认了吗")
    assert result["citations"] == []
    assert result["answer"] == ga._EMPTY_ANSWER
    # 全空不调 LLM(成本闸)。
    svc._llm.chat.assert_not_called()


def test_calendar_not_visible_across_users_or_orgs():
    org = factories.OrganizationFactory()
    me, stranger = factories.UserFactory(), factories.UserFactory()
    models.Membership.objects.create(organization=org, user=me, is_primary=True)
    models.Membership.objects.create(
        organization=org, user=stranger, is_primary=True
    )
    event = models.CalendarEvent.objects.create(
        organization=org,
        organizer=me,
        title="预算评审日程",
        start_at=datetime.now(dt_timezone.utc) + timedelta(days=3),
        end_at=datetime.now(dt_timezone.utc) + timedelta(days=3, hours=1),
        timezone=ZoneInfo("Asia/Shanghai"),
    )
    models.EventAttendee.objects.create(event=event, user=me)

    svc = GlobalAskService(embed=_fake_embed(), llm=_fake_llm())
    citations: list = []
    # stranger 同组织但非 organizer/attendee → 不可见。
    assert svc._recall_calendar(stranger, ["预算"], citations) == []
    assert citations == []
    # 本人可见。
    entries = svc._recall_calendar(me, ["预算"], citations)
    assert len(entries) == 1
    assert citations[0]["kind"] == "calendar"


def test_summaries_room_member_boundary():
    owner, outsider = factories.UserFactory(), factories.UserFactory()
    room, summary = _room_with_chunk(owner)
    summary.content = "决议:预算上调 10%"
    summary.save(update_fields=["content"])

    svc = GlobalAskService(embed=_fake_embed(), llm=_fake_llm())
    citations: list = []
    assert svc._recall_summaries(outsider, ["预算"], citations) == []
    entries = svc._recall_summaries(owner, ["预算"], citations)
    assert len(entries) == 1
    assert citations[0]["kind"] == "meeting"


def test_summary_edited_predicate_not_hitting_superseded_original():
    """已编辑纪要:命中编辑稿;被取代的 AI 原文不再作为命中依据。"""
    user = factories.UserFactory()
    room, summary = _room_with_chunk(user)
    summary.content = "原文提到 神秘代号"
    summary.edited_content = "编辑稿只谈预算"
    summary.save(update_fields=["content", "edited_content"])

    svc = GlobalAskService(embed=_fake_embed(), llm=_fake_llm())
    citations: list = []
    # 关键词只在被取代的原文里 → 不命中。
    assert svc._recall_summaries(user, ["神秘代号"], citations) == []
    # 关键词在编辑稿里 → 命中,且节选来自编辑稿。
    entries = svc._recall_summaries(user, ["预算"], citations)
    assert len(entries) == 1
    assert "编辑稿" in entries[0]


def test_calendar_series_deduped_to_nearest():
    org = factories.OrganizationFactory()
    me = factories.UserFactory()
    models.Membership.objects.create(organization=org, user=me, is_primary=True)
    now = datetime.now(dt_timezone.utc)
    parent = models.CalendarEvent.objects.create(
        organization=org,
        organizer=me,
        title="周会",
        start_at=now + timedelta(days=1),
        end_at=now + timedelta(days=1, hours=1),
        timezone=ZoneInfo("Asia/Shanghai"),
        recurrence="FREQ=WEEKLY",
    )
    for offset in (8, 15, 22):
        models.CalendarEvent.objects.create(
            organization=org,
            organizer=me,
            title="周会",
            start_at=now + timedelta(days=offset),
            end_at=now + timedelta(days=offset, hours=1),
            timezone=ZoneInfo("Asia/Shanghai"),
            recurrence_parent=parent,
        )

    svc = GlobalAskService(embed=_fake_embed(), llm=_fake_llm())
    citations: list = []
    entries = svc._recall_calendar(me, ["周会"], citations)
    # 同一系列 4 行只留距今最近的一场,不占满 cap。
    assert len(entries) == 1


# ---- 罐头 / 引用 / 降级 ----


def test_happy_path_citations_and_used_extraction():
    user = factories.UserFactory()
    _room_with_chunk(user)
    llm = _fake_llm(answer="预算已确认[1],无效标注[9]忽略。")
    svc = GlobalAskService(embed=_fake_embed(), llm=llm)

    result = svc.ask(user=user, question="预算确认了吗")
    assert result["degraded"] is False
    assert [c["n"] for c in result["citations"]] == list(
        range(1, len(result["citations"]) + 1)
    )
    assert result["citations_used"] == [1]  # [9] 超界被滤
    assert result["sources"]["transcripts"] == "ok"
    assert result["sources"]["im"] == "skipped"  # M2 才上


def test_llm_failure_degrades_with_citations_intact():
    user = factories.UserFactory()
    _room_with_chunk(user)
    llm = _fake_llm()
    llm.chat.side_effect = RuntimeError("429 quota exceeded")
    svc = GlobalAskService(embed=_fake_embed(), llm=llm)

    result = svc.ask(user=user, question="预算确认了吗")
    assert result["degraded"] is True
    assert result["answer"] == ""
    assert len(result["citations"]) >= 1  # 检索结果模式:引用完整可点


def test_circuit_breaker_skips_llm_after_three_failures():
    user = factories.UserFactory()
    _room_with_chunk(user)
    llm = _fake_llm()
    llm.chat.side_effect = RuntimeError("boom")
    svc = GlobalAskService(embed=_fake_embed(), llm=llm)

    for _ in range(3):
        assert svc.ask(user=user, question="预算")["degraded"] is True
    assert llm.chat.call_count == 3

    # 第 4 次:熔断窗内 + 半开探测已被首个失败序列消耗?——探测键只在
    # 熔断后首次调用时设置;此处先清探测键模拟「窗内后续请求」。
    cache.delete(ga._PROBE_KEY)
    cache.set(ga._PROBE_KEY, 1, timeout=60)  # 探测名额已被占用
    result = svc.ask(user=user, question="预算")
    assert result["degraded"] is True
    assert llm.chat.call_count == 3  # 未再打 LLM


def test_stream_contract_meta_delta_done():
    user = factories.UserFactory()
    _room_with_chunk(user)
    llm = _fake_llm()
    llm.chat_stream.return_value = iter(["预算已", "确认[1]"])
    svc = GlobalAskService(embed=_fake_embed(), llm=llm)

    events = list(svc.ask_stream(user=user, question="预算确认了吗"))
    assert events[0]["type"] == "meta"
    assert events[0]["citations"]
    assert [e["type"] for e in events[1:-1]] == ["delta", "delta"]
    assert events[-1] == {
        "type": "done",
        "citations_used": [1],
        "degraded": False,
    }


# ---- 端点 gate ----


def test_endpoint_requires_auth_and_flag():
    client = APIClient()
    resp = client.post("/api/v1.0/search/ask/", {"question": "hi"}, format="json")
    assert resp.status_code == 401

    user = factories.UserFactory()
    client.force_login(user)
    with mock.patch.object(
        GlobalAskService,
        "ask",
        return_value={
            "answer": "ok",
            "citations": [],
            "citations_used": [],
            "sources": {},
            "model_used": "ep",
            "degraded": False,
        },
    ):
        resp = client.post(
            "/api/v1.0/search/ask/", {"question": "hi"}, format="json"
        )
    assert resp.status_code == 200

    resp = client.post("/api/v1.0/search/ask/", {"question": ""}, format="json")
    assert resp.status_code == 400


def test_endpoint_404_when_flag_off(settings):
    settings.GLOBAL_SEARCH_AI_ENABLED = False
    user = factories.UserFactory()
    client = APIClient()
    client.force_login(user)
    resp = client.post(
        "/api/v1.0/search/ask/", {"question": "hi"}, format="json"
    )
    assert resp.status_code == 404


def test_keywords_extraction_shapes():
    kws = GlobalAskService._keywords('查一下"季度预算"和 OKR2026 的进展')
    assert "季度预算" in kws  # 引号短语优先
    assert "OKR2026" in kws  # 英数 token 保留
    assert len(kws) <= 3
