"""Synthetic-only meeting QA evaluation helpers, never a production seeder."""

import hashlib
import json
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

from core import models
from core.factories import UserFactory
from core.services import meeting_search
from core.services.global_ask import GlobalAskService
from core.services.meeting_search import citations_visible
from core.tests.services.test_meeting_records import online_note

DATA = json.loads(
    Path(__file__).with_name("meeting_qa_cases.json").read_text(encoding="utf-8")
)
CASES = DATA["cases"]


def seed_case(case):
    """Called only inside pytest-django's rolled-back test database transaction."""
    viewer = UserFactory()
    aliases = {}
    for spec in case["records"]:
        owner = viewer if spec.get("access", "owner") == "owner" else UserFactory()
        at = datetime.fromisoformat(spec["date"]).replace(tzinfo=timezone.utc)
        source = spec.get("source", "upload")
        if source == "meeting":
            _, session, transcript, record = online_note(
                user=owner, text=spec["texts"][0]
            )
            models.MeetingSession.objects.filter(pk=session.pk).update(started_at=at)
            models.Transcript.objects.filter(pk=transcript.pk).update(started_at=at)
            models.MeetingRecord.objects.filter(pk=record.pk).update(
                origin_at=at, title=spec["title"]
            )
            record.refresh_from_db()
        else:
            record = models.MeetingRecord.objects.create(
                owner=owner,
                source_type=source,
                title=spec["title"],
                origin_at=at,
                retention_mode="media",
                deleted_at=at if spec.get("trashed") else None,
            )
            capture = models.CaptureSession.objects.create(
                record=record,
                created_by=owner,
                device_id="eval",
                status="stopped",
                started_at=at,
                ended_at=at,
            )
            speaker = models.MeetingSpeaker.objects.create(
                record=record,
                capture_session=capture,
                source_track_id="eval",
                source_key="speaker",
                label="Speaker",
                identity_type="unknown",
            )
            for index, text in enumerate(spec["texts"]):
                row = models.MeetingOriginalSegment.objects.create(
                    record=record,
                    capture_session=capture,
                    speaker=speaker,
                    ingest_id=uuid4(),
                    source_track_id="eval",
                    source_sequence=index + 1,
                    start_ms=index * 10000,
                    end_ms=(index + 1) * 10000,
                    text=text,
                    payload_hash="a" * 64,
                )
                if str(index) in spec.get("corrections", {}):
                    models.MeetingOriginalRevision.objects.create(
                        record=record,
                        original=row,
                        revision=1,
                        edited_by=owner,
                        text=spec["corrections"][str(index)],
                    )
        if "summary" in spec:
            snapshot = models.MeetingTranscriptVersion.objects.create(
                record=record,
                revision=1,
                fingerprint="b" * 64,
                segments=[{"text": "synthetic"}],
            )
            job = models.MeetingProcessingJob.objects.create(
                record=record,
                kind="summary",
                generation=1,
                input_revision=1,
                status="succeeded",
                input_snapshot=snapshot,
                configuration={"model": "synthetic"},
            )
            summary = models.MeetingSummaryVersion.objects.create(
                record=record,
                job=job,
                input_snapshot=snapshot,
                content={"overview": spec["summary"]},
                model_used="synthetic",
            )
            if "review" in spec:
                models.MeetingSummaryReview.objects.create(
                    record=record,
                    base_summary=summary,
                    author=owner,
                    revision=1,
                    key=uuid4(),
                    request_hash="c" * 64,
                    content={"overview": spec["review"]},
                )
        if spec.get("access") in {"summary", "transcript", "revoked"}:
            grant = models.MeetingRecordAccess.objects.create(
                record=record,
                user=viewer,
                read_summary=True,
                read_transcript=spec["access"] != "summary",
            )
            if spec["access"] == "revoked":
                grant.delete()
        aliases[str(record.pk)] = spec["id"]
    return viewer, aliases


def score(case, retrieved):
    """Gold spans must appear in the actual model context, not merely in a hit record."""
    gold = case["evidence"]
    expected = {e["record"] for e in gold}
    ids = {r["record"] for r in retrieved}
    found = [
        any(r["record"] == e["record"] and e["span"] in r["context"] for r in retrieved)
        for e in gold
    ]
    relevant = sum(
        any(r["record"] == e["record"] and e["span"] in r["context"] for e in gold)
        for r in retrieved
    )
    ranks = [
        i
        for i, r in enumerate(retrieved, 1)
        if any(r["record"] == e["record"] and e["span"] in r["context"] for e in gold)
    ]
    forbidden = any(
        r["record"] in case.get("forbidden_records", [])
        or any(
            s in r["context"] or s in r.get("snippet", "")
            for s in case.get("forbidden_spans", [])
        )
        for r in retrieved
    )
    return {
        "record_recall": len(expected & ids) / len(expected) if expected else None,
        "evidence_recall": sum(found) / len(gold) if gold else None,
        "evidence_precision": relevant / len(retrieved)
        if gold and retrieved
        else (0.0 if gold else None),
        "all_evidence": all(found) if gold else None,
        "reciprocal_rank": 1 / ranks[0] if ranks else (0.0 if gold else None),
        "unique_records": len(ids),
        "citation_count": len(retrieved),
        "largest_record_share": max(
            (sum(r["record"] == rid for r in retrieved) for rid in ids), default=0
        )
        / len(retrieved)
        if retrieved
        else 0,
        "forbidden_content": forbidden,
        "empty_expectation_met": not retrieved if case.get("expect_empty") else None,
        "missing_evidence": [e for e, hit in zip(gold, found, strict=True) if not hit],
    }


def evaluate(case, viewer, aliases, monkeypatch):
    """Exercise real keyword extraction + complete meeting-scope preparation, no generation."""
    entries = []
    original_recall = meeting_search.recall_records

    def capture(*args, **kwargs):
        result = original_recall(*args, **kwargs)
        entries.extend(result)
        return result

    def forbidden_call(*args, **kwargs):
        raise AssertionError("Evaluation must not call a provider or another source")

    # These methods may never be reached, even if future code starts generating here.
    llm = SimpleNamespace(
        model="evaluation-no-generation",
        chat=forbidden_call,
        chat_stream=forbidden_call,
    )
    service = GlobalAskService(
        scope="meetings",
        llm=llm,
        date_from=datetime.fromisoformat(case["date_from"]).date()
        if case.get("date_from")
        else None,
        date_to=datetime.fromisoformat(case["date_to"]).date()
        if case.get("date_to")
        else None,
    )
    monkeypatch.setattr("core.services.global_ask.recall_records", capture)
    monkeypatch.setattr(service, "_recall_im", forbidden_call)
    monkeypatch.setattr(service, "_recall_calendar", forbidden_call)
    monkeypatch.setattr(service, "_embed_client", forbidden_call)
    prep = service._prepare(user=viewer, question=case["question"])
    assert all(state != "skipped" for state in prep["sources"].values()), prep[
        "sources"
    ]
    assert "im" not in prep["sources"] and "calendar" not in prep["sources"]
    assert citations_visible(viewer, prep["citations"])
    assert [c["n"] for c in prep["citations"]] == list(range(1, len(entries) + 1))
    retrieved = []
    for citation, entry in zip(prep["citations"], entries, strict=True):
        assert entry in prep["system"]
        retrieved.append(
            {
                "n": citation["n"],
                "record": aliases[citation["record_id"]],
                "ability": citation["ability"],
                "reviewed": citation["reviewed"],
                "date": citation["date"],
                "start_ms": citation["start_ms"],
                "context": entry.split("》", 1)[1],
                "snippet": citation["snippet"],
            }
        )
    return {
        "id": case["id"],
        "category": case["category"],
        "split": case["split"],
        "question": case["question"],
        "keywords": service._keywords(case["question"]),
        "sources": prep["sources"],
        "canned": prep["canned"],
        "metrics": score(case, retrieved),
        "retrieved": retrieved,
        "gold_evidence": case["evidence"],
        "answer_requirements": case["answer_requirements"],
        "generation_prompt": prep["system"],
        "generated_answer": None,
        "human_review": None,
    }


def aggregate(rows):
    def mean(key):
        values = [r["metrics"][key] for r in rows if r["metrics"][key] is not None]
        return {
            "value": sum(values) / len(values) if values else None,
            "denominator": len(values),
        }

    return {
        "cases": len(rows),
        **{
            key: mean(key)
            for key in (
                "record_recall",
                "evidence_recall",
                "evidence_precision",
                "all_evidence",
                "reciprocal_rank",
                "empty_expectation_met",
            )
        },
        "forbidden_content_cases": sum(r["metrics"]["forbidden_content"] for r in rows),
        "answer_semantics": "not_evaluated",
    }


def report(rows):
    return {
        "schema_version": 1,
        "dataset_sha256": hashlib.sha256(
            Path(__file__).with_name("meeting_qa_cases.json").read_bytes()
        ).hexdigest(),
        "implementation_sha256": {
            name: hashlib.sha256(
                (Path(__file__).parents[2] / "services" / name).read_bytes()
            ).hexdigest()
            for name in (
                "global_ask.py",
                "meeting_search.py",
                "effective_transcripts.py",
            )
        },
        "dependencies": {name: version(name) for name in ("Django", "jieba")},
        "dataset": DATA["dataset"],
        "data_kind": "synthetic",
        "generation": "disabled",
        "scope": "meetings / unified record fixtures",
        "overall": aggregate(rows),
        "by_category": {
            c: aggregate([r for r in rows if r["category"] == c])
            for c in sorted({r["category"] for r in rows})
        },
        "by_split": {
            s: aggregate([r for r in rows if r["split"] == s])
            for s in ("diagnostic", "validation")
        },
        "cases": rows,
    }
