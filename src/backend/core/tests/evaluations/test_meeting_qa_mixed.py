"""Mixed legacy/unified retrieval diagnostics; provider vectors are synthetic controls."""

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from core import factories, models
from core.services.global_ask import GlobalAskService
from core.services.meeting_search import citations_visible
from core.tests.evaluations.meeting_qa import report, score, seed_case

CORPUS = Path(__file__).with_name("meeting_qa_mixed_cases.json")
DATA = json.loads(CORPUS.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def results():
    rows = []
    yield rows
    target = os.environ.get("MEETING_QA_MIXED_OUTPUT")
    if target:
        assert len(rows) == len(DATA["cases"]), "Full unsharded corpus required"
        value = report(rows)
        value.update(
            dataset=DATA["dataset"],
            dataset_sha256=hashlib.sha256(CORPUS.read_bytes()).hexdigest(),
            scope="meetings / unified and legacy synthetic fixtures",
            embedding="synthetic deterministic vector control; no provider calls",
            harness_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        )
        Path(target).write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )


@pytest.mark.django_db
@pytest.mark.parametrize("case", DATA["cases"], ids=lambda c: c["id"])
def test_mixed_retrieval(case, settings, monkeypatch, results):
    settings.MEETING_RECORDS_ENABLED = True
    settings.CELERY_ENABLED = False
    viewer, aliases = seed_case(case)
    for spec in case.get("legacy", []):
        owner = (
            viewer
            if spec.get("access", "owner") == "owner"
            else factories.UserFactory()
        )
        room = factories.RoomFactory(name=spec["title"], slug="mixed-" + spec["id"])
        room.users.add(owner)
        summary = models.Summary.objects.create(room=room, content="", status="success")
        at = datetime.fromisoformat(spec["date"]).replace(tzinfo=timezone.utc)
        for index, text in enumerate(spec["texts"]):
            models.TranscriptChunk.objects.create(
                room=room,
                summary=summary,
                chunk_index=index,
                text=text,
                speaker_identity="synthetic",
                started_at=at,
                ended_at=at,
                embedding=[0.5] * 8,
                embedding_model="synthetic-vector" if spec.get("embedded") else "",
            )
        aliases[str(room.pk)] = spec["id"]

    def forbidden(*args, **kwargs):
        raise AssertionError("No real provider or unrelated source allowed")

    service = GlobalAskService(
        scope="meetings",
        llm=SimpleNamespace(
            model="no-generation", chat=forbidden, chat_stream=forbidden
        ),
        embed=SimpleNamespace(model="synthetic-vector", embed=lambda _: [0.5] * 8),
        date_from=datetime.fromisoformat(case["date_from"]).date()
        if case.get("date_from")
        else None,
    )
    monkeypatch.setattr(service, "_recall_im", forbidden)
    monkeypatch.setattr(service, "_recall_calendar", forbidden)
    entries = []

    def capture(method):
        def wrapped(*args, **kwargs):
            found = method(*args, **kwargs)
            entries.extend(found)
            return found

        return wrapped

    for method in ("_recall_transcripts", "_recall_summaries"):
        monkeypatch.setattr(service, method, capture(getattr(service, method)))
    from core.services import global_ask  # noqa: PLC0415 -- wrap live entry point

    monkeypatch.setattr(
        global_ask, "recall_records", capture(global_ask.recall_records)
    )
    prep = service._prepare(user=viewer, question=case["question"])
    assert all(s != "skipped" for s in prep["sources"].values())
    assert citations_visible(viewer, prep["citations"])
    assert [c["n"] for c in prep["citations"]] == list(range(1, len(entries) + 1))
    retrieved = []
    for citation, entry in zip(prep["citations"], entries, strict=True):
        assert entry in prep["system"]
        retrieved.append(
            {
                "record": aliases[citation.get("record_id") or citation["room_id"]],
                "context": entry.split("》", 1)[1],
                "snippet": citation["snippet"],
            }
        )
    row = {
        "id": case["id"],
        "category": case["category"],
        "split": case["split"],
        "question": case["question"],
        "keywords": service._keywords(case["question"]),
        "metrics": score(case, retrieved),
        "retrieved": retrieved,
        "gold_evidence": case["evidence"],
        "generated_answer": None,
        "generation_prompt": prep["system"],
        "human_review": None,
    }
    results.append(row)
    assert not row["metrics"]["forbidden_content"]
