"""Bounded diversity and source positioning outside the frozen QA corpus."""

from datetime import timedelta

import pytest

from core import models
from core.services.global_ask import GlobalAskService
from core.services.meeting_search import (
    CONTEXT_CHARS,
    CONTEXT_CITATIONS,
    recall_records,
)
from core.tests.evaluations.meeting_qa import seed_case
from core.tests.services.test_meeting_records import online_note

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.CELERY_ENABLED = False


def record(name, texts, date="2026-09-01", title="Discussion"):
    return {"id": name, "texts": texts, "date": date, "title": title}


def test_one_large_record_cannot_fill_candidate_pool_before_diversity():
    viewer, aliases = seed_case(
        {
            "records": [
                record(
                    "recent",
                    [f"retention discussion section {i}" for i in range(100)],
                    "2026-09-20",
                ),
                record("old", ["retention decision: preserve 7 days"], "2025-02-01"),
            ]
        }
    )
    citations = []
    entries = recall_records(viewer, ["retention"], citations)
    assert {aliases[c["record_id"]] for c in citations} == {"old", "recent"}
    assert sum(aliases[c["record_id"]] == "recent" for c in citations) <= 2
    assert any("preserve 7 days" in e for e in entries)


def test_body_evidence_ranks_before_newer_title_only_match():
    viewer, aliases = seed_case(
        {
            "records": [
                record("title", ["Coffee break arranged"], "2026-09-20", "retention"),
                record("body", ["retention decision: preserve 7 days"], "2025-01-01"),
            ]
        }
    )
    citations = []
    recall_records(viewer, ["retention"], citations)
    assert aliases[citations[0]["record_id"]] == "body"


def test_budget_and_numbering_preserved_with_many_records():
    viewer, _ = seed_case(
        {
            "records": [
                record(
                    str(i),
                    [f"retention {i}-{j} " + "evidence " * 200 for j in range(3)],
                    f"2026-09-{i + 1:02}",
                )
                for i in range(12)
            ]
        }
    )
    citations = [{"n": 1, "kind": "calendar"}]
    entries = recall_records(viewer, ["retention"], citations)
    assert len(entries) == CONTEXT_CITATIONS
    assert len({c["record_id"] for c in citations[1:]}) == CONTEXT_CITATIONS
    assert [c["n"] for c in citations] == list(range(1, CONTEXT_CITATIONS + 2))
    assert all(len(e.split("》", 1)[1]) <= CONTEXT_CHARS for e in entries)


def test_online_window_keeps_segment_clock_not_fabricated_word_offset():
    owner, session, transcript, record_obj = online_note(
        text="Preamble. " * 150 + "retention is 7 days"
    )
    models.Transcript.objects.filter(pk=transcript.pk).update(
        started_at=session.started_at + timedelta(seconds=12)
    )
    citations = []
    entries = recall_records(owner, ["retention"], citations)
    assert len(entries) == 1 and "retention is 7 days" in entries[0]
    assert citations[0]["start_ms"] == 12000
    assert citations[0]["record_id"] == str(record_obj.pk)


def test_duplicate_fragments_are_not_repeated_in_context():
    viewer, _ = seed_case(
        {
            "records": [
                record("a", ["retention first", "retention first", "retention next"])
            ]
        }
    )
    citations = []
    entries = recall_records(viewer, ["retention"], citations)
    bodies = [entry.split("》", 1)[1] for entry in entries]
    assert len(bodies) == len(set(bodies))
    assert len(citations) <= 2


@pytest.mark.parametrize(
    "question,expected",
    [
        ("What is the rollback plan?", ["rollback", "plan"]),
        ('"The" rollback', ["The", "rollback"]),
        ("API api budget", ["API", "budget"]),
        ("IT budget", ["IT", "budget"]),
        ("what is the", []),
    ],
)
def test_english_query_terms_keep_explicit_phrases_and_acronyms(question, expected):
    assert GlobalAskService._keywords(question) == expected


def test_repeated_video_opening_and_question_do_not_hide_later_answer():
    # Derived only from the user's supplied public sample, not private meetings.
    texts = [
        "中国大部分老板都不是资本家思维，而是封建地主奴隶主思维。",
        "资本家思维是你只要给他挣到钱，你怎么都可以，你不来上班也没问题。",
        "对，那么奴隶主思维呢？",
        "他就是看不得你闲，他在全方位监控你。",
        "两者之间最大的区别就是，资本家觉得你是在帮他赚钱，奴隶主觉得你是在挣他的钱。",
    ]
    viewer, _ = seed_case({"records": [record(str(i), texts) for i in range(7)]})
    citations = []
    entries = recall_records(
        viewer,
        GlobalAskService._keywords("两种老板思维中，资本家与奴隶主最大的区别是什么？"),
        citations,
    )
    assert any(texts[-1] in entry for entry in entries)
    assert len(entries) <= CONTEXT_CITATIONS
    assert all(
        sum(c["record_id"] == row["record_id"] for c in citations) <= 2
        for row in citations
    )
