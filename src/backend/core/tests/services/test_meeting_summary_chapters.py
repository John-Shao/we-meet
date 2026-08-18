"""纪要闭环 P0-3 M1:智能章节解析/持久化 + 卡片式 IM 推送正文。"""

# pylint: disable=redefined-outer-name,unused-argument,protected-access

import json
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from unittest import mock

import pytest

from core.factories import MeetingSessionFactory, RoomFactory
from core.models import Summary, SummaryChapter, Transcript
from core.services.meeting_summary import MeetingSummaryService

pytestmark = pytest.mark.django_db


def _room_with_transcripts(n=3, start=None):
    room = RoomFactory()
    session = MeetingSessionFactory(room=room)
    start = start or datetime(2026, 7, 18, 9, 0, tzinfo=dt_timezone.utc)
    transcripts = [
        Transcript.objects.create(
            room=room,
            session=session,
            speaker_identity=f"sub-{i}",
            speaker_name=f"讲者{i}",
            text=f"第 {i} 段发言",
            started_at=start + timedelta(minutes=10 * i),
        )
        for i in range(n)
    ]
    return room, transcripts


# ---- _parse_chapters 防御 ----


def test_parse_chapters_happy_path_with_fences():
    room, transcripts = _room_with_transcripts()
    svc = MeetingSummaryService(llm=mock.Mock())
    raw = "```json\n" + json.dumps(
        {
            "chapters": [
                {"title": "开场", "digest": "寒暄", "start": "09:00:00", "end": "09:10:00"},
                {"title": "方案评审", "digest": "定稿", "start": "09:10:00", "end": "09:20:00"},
            ]
        },
        ensure_ascii=False,
    ) + "\n```"

    chapters = svc._parse_chapters(raw, transcripts)
    assert [c["title"] for c in chapters] == ["开场", "方案评审"]
    # 时间锚定到转写首条的日期(UTC 2026-07-18)。
    assert chapters[0]["started_at"] == datetime(
        2026, 7, 18, 9, 0, tzinfo=dt_timezone.utc
    )
    assert chapters[1]["ended_at"] == datetime(
        2026, 7, 18, 9, 20, tzinfo=dt_timezone.utc
    )


def test_parse_chapters_defensive_bad_shapes():
    room, transcripts = _room_with_transcripts()
    svc = MeetingSummaryService(llm=mock.Mock())
    assert svc._parse_chapters("", transcripts) == []
    assert svc._parse_chapters("not json", transcripts) == []
    assert svc._parse_chapters(json.dumps({"chapters": "nope"}), transcripts) == []
    # 缺标题的行丢弃;非法时间戳置 None 不弃行。
    raw = json.dumps(
        {
            "chapters": [
                {"title": "", "start": "09:00:00", "end": "09:10:00"},
                {"title": "有效", "digest": "", "start": "25:99:00", "end": "bogus"},
            ]
        },
        ensure_ascii=False,
    )
    chapters = svc._parse_chapters(raw, transcripts)
    assert len(chapters) == 1
    assert chapters[0]["title"] == "有效"
    assert chapters[0]["started_at"] is None
    assert chapters[0]["ended_at"] is None


def test_parse_chapters_repairs_missing_opening_quote_and_trailing_commas():
    """Recover the malformed title shape observed from the production LLM."""
    room, transcripts = _room_with_transcripts()
    svc = MeetingSummaryService(llm=mock.Mock())
    raw = """{
        "chapters": [
            {
                "title": "分享数量与生产情况",
                "digest": "提及分享数量和生产情况。",
                "start": "09:00:00",
                "end": "09:10:00"
            },
            {
                "title": 字段与上报结果",
                "digest": "讨论新增字段和多个上报结果，保留 literal,}。",
                "start": "09:10:00",
                "end": "09:20:00",
            },
        ]
    }"""

    chapters = svc._parse_chapters(raw, transcripts)

    assert [chapter["title"] for chapter in chapters] == [
        "分享数量与生产情况",
        "字段与上报结果",
    ]
    assert chapters[1]["digest"] == "讨论新增字段和多个上报结果，保留 literal,}。"
    assert chapters[1]["started_at"] == datetime(
        2026, 7, 18, 9, 10, tzinfo=dt_timezone.utc
    )


def test_parse_chapters_does_not_guess_ambiguous_malformed_json():
    room, transcripts = _room_with_transcripts()
    svc = MeetingSummaryService(llm=mock.Mock())

    assert (
        svc._parse_chapters(
            '{"chapters": [{"title": missing both quotes, "digest": "x"}]}',
            transcripts,
        )
        == []
    )


def test_parse_chapters_midnight_wrap_monotonic():
    """22:50 → 00:10 跨零点:后者顺延一天而非回到当天凌晨。"""
    start = datetime(2026, 7, 18, 22, 30, tzinfo=dt_timezone.utc)
    room, transcripts = _room_with_transcripts(start=start)
    svc = MeetingSummaryService(llm=mock.Mock())
    raw = json.dumps(
        {
            "chapters": [
                {"title": "夜谈", "digest": "", "start": "22:50:00", "end": "23:40:00"},
                {"title": "凌晨收尾", "digest": "", "start": "00:10:00", "end": "00:30:00"},
            ]
        },
        ensure_ascii=False,
    )
    chapters = svc._parse_chapters(raw, transcripts)
    assert chapters[1]["started_at"] == datetime(
        2026, 7, 19, 0, 10, tzinfo=dt_timezone.utc
    )
    assert chapters[1]["ended_at"] == datetime(
        2026, 7, 19, 0, 30, tzinfo=dt_timezone.utc
    )


# ---- _persist 章节全删重建 ----


def test_persist_rebuilds_chapters_idempotently():
    room, transcripts = _room_with_transcripts()
    svc = MeetingSummaryService(llm=mock.Mock())
    chapters = [
        {"title": "A", "digest": "a", "started_at": None, "ended_at": None},
        {"title": "B", "digest": "b", "started_at": None, "ended_at": None},
    ]
    svc._persist(
        session=transcripts[0].session,
        room=room,
        summary_text="## 摘要",
        items=[],
        chapters=chapters,
        transcripts=transcripts,
        model_used="test",
    )
    assert SummaryChapter.objects.filter(room=room).count() == 2

    # regen:换一组章节 → 全删重建,不残留。
    svc._persist(
        session=transcripts[0].session,
        room=room,
        summary_text="## 摘要 v2",
        items=[],
        chapters=[{"title": "C", "digest": "", "started_at": None, "ended_at": None}],
        transcripts=transcripts,
        model_used="test",
    )
    rows = list(SummaryChapter.objects.filter(room=room))
    assert [r.title for r in rows] == ["C"]
    assert rows[0].summary == Summary.objects.get(room=room)


# ---- 卡片式推送正文 ----


def test_summary_card_body_bullets_counts_and_link():
    room, transcripts = _room_with_transcripts()
    room.name = "周例会"
    svc = MeetingSummaryService(llm=mock.Mock())
    summary = Summary.objects.create(
        room=room,
        session=transcripts[0].session,
        status=Summary.Status.SUCCESS,
        content=(
            "## 会议主题\n"
            "- **确定** Q3 目标\n"
            "- 预算上调 10%\n"
            "* 新人入职安排\n"
            "- 第四条不该出现\n"
        ),
    )
    svc._persist(
        session=transcripts[0].session,
        room=room,
        summary_text=summary.content,
        items=[{"content": "写周报", "owner": "张三", "due": ""}],
        chapters=[{"title": "A", "digest": "", "started_at": None, "ended_at": None}],
        transcripts=transcripts,
        model_used="test",
    )
    summary.refresh_from_db()

    body = svc._summary_card_body(room, summary, "https://x/meetings/1")
    lines = body.splitlines()
    assert lines[0] == "📋 「周例会」会议纪要"
    # 前 3 条要点,Markdown 强调符已剥。
    assert lines[1] == "· 确定 Q3 目标"
    assert lines[2] == "· 预算上调 10%"
    assert lines[3] == "· 新人入职安排"
    assert "第四条" not in body
    assert "✅ 行动项 1 条 · 📑 章节 1 个" in body
    assert lines[-1] == "https://x/meetings/1"


def test_summary_card_body_truncates_to_120_chars():
    room, _ = _room_with_transcripts()
    svc = MeetingSummaryService(llm=mock.Mock())
    long = "长" * 200
    summary = Summary.objects.create(
        room=room, status=Summary.Status.SUCCESS, content=f"- {long}"
    )
    body = svc._summary_card_body(room, summary, "L")
    bullet = next(l for l in body.splitlines() if l.startswith("·"))
    assert bullet.endswith("…")
    assert len(bullet) <= 130  # 「· 」+120 字+省略号以内
