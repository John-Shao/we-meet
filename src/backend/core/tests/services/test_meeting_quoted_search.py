"""Quoted meeting intent must survive tokenisation and dense retrieval."""

from types import SimpleNamespace

import pytest

from core.services.global_ask import GlobalAskService
from core.tests.evaluations.meeting_qa import seed_case
from core.tests.test_api_search_ask import _room_with_chunk

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.CELERY_ENABLED = False


def prepare(viewer, question):
    service = GlobalAskService(
        scope="meetings",
        embed=SimpleNamespace(model="emb-test", embed=lambda _: [0.5] * 8),
        llm=SimpleNamespace(model="no-generation"),
    )
    return service._prepare(user=viewer, question=question)


def seed(text, *, title="Discussion", access="owner", summary=None):
    spec = {
        "id": "record",
        "title": title,
        "date": "2026-09-01",
        "texts": [text],
        "access": access,
    }
    if summary:
        spec["summary"] = summary
    return seed_case({"records": [spec]})[0]


def test_quoted_phrase_rejects_token_overlap_and_dense_only_legacy():
    viewer = seed("两者之间最大的区别就是：旧版7天，新版30天。")
    _room_with_chunk(viewer, text="两个方案的区别是什么？", name="Noise")
    result = prepare(viewer, "“两者之间最大的区别”是什么？")
    assert len(result["citations"]) == 1
    assert result["citations"][0].get("record_id")


def test_quoted_phrase_does_not_fall_back_to_its_individual_words():
    viewer = seed("The alpha team manages rollout separately.")
    _room_with_chunk(viewer, text="Alpha is not the beta team.")
    result = prepare(viewer, 'Explain "alpha beta"')
    assert result["canned"] and not result["citations"]


def test_quoted_phrase_remains_case_insensitive_and_covers_summary():
    viewer = seed("unrelated", summary="ALPHA BETA release approved.")
    assert (
        prepare(viewer, 'Explain "alpha beta"')["citations"][0]["ability"]
        == "read_summary"
    )


def test_quoted_title_keeps_record_searchable():
    viewer = seed("Release approved for Friday.", title="Alpha Beta")
    assert prepare(viewer, 'Summarize "alpha beta"')["citations"]


def test_private_exact_match_remains_invisible():
    viewer = seed("alpha beta release approved", access="private")
    assert prepare(viewer, 'Explain "alpha beta"')["canned"]


def test_multiple_phrases_allow_each_independent_side():
    viewer, _ = seed_case(
        {
            "records": [
                {
                    "id": "a",
                    "title": "Old",
                    "date": "2026-09-01",
                    "texts": ["alpha beta was 7"],
                },
                {
                    "id": "b",
                    "title": "New",
                    "date": "2026-09-02",
                    "texts": ["gamma delta is 30"],
                },
            ]
        }
    )
    assert (
        len(prepare(viewer, 'Compare "alpha beta" and "gamma delta"')["citations"]) == 2
    )


@pytest.mark.parametrize("question", ["What's changed and isn't approved?", "don't retry"])
def test_contractions_do_not_create_a_phrase_constraint(question):
    assert GlobalAskService._quoted_keywords(question) == []
