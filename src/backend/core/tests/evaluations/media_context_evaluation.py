"""Offline bounded context expansion; never fetches or grants record access."""

import hashlib
import json

from core.tests.evaluations.media_auto_evaluation import REFERENCES
from core.tests.evaluations.media_intent_review import SOURCE

POLICY = {"neighbors_each_side": 3, "radius_ms": 30000, "max_chars": 800}


def expand(anchor, segments, policy=None):
    """Keep the exact anchor; add whole nearby segments within a fixed budget."""
    policy = POLICY if policy is None else policy
    ordered = sorted(segments, key=lambda s: (s["start_ms"], s["id"]))
    ids = [s["id"] for s in ordered]
    if len(set(ids)) != len(ids) or anchor["source_id"] not in ids:
        raise ValueError("Unknown or duplicate source segment")
    index = ids.index(anchor["source_id"])
    center = ordered[index]
    if not anchor["quote"] or anchor["quote"] not in center["text"]:
        raise ValueError("Anchor must be a verbatim source quote")

    def render(rows):
        return "\n".join(
            f"({s['start_ms']}ms–{s['end_ms']}ms) {s['text']}" for s in rows
        )

    # An oversized anchor is not silently truncated into a different statement.
    selected = [{**center, "text": anchor["quote"]}]
    if len(render(selected)) > policy["max_chars"]:
        raise ValueError("Anchor exceeds context budget")
    if len(render([center])) <= policy["max_chars"]:
        selected = [center]
    for distance in range(1, policy["neighbors_each_side"] + 1):
        for pos in (index - distance, index + distance):
            if not 0 <= pos < len(ordered):
                continue
            neighbor = ordered[pos]
            if abs(neighbor["start_ms"] - center["start_ms"]) > policy["radius_ms"]:
                continue
            proposal = sorted(
                [*selected, neighbor], key=lambda s: (s["start_ms"], s["id"])
            )
            if len(render(proposal)) <= policy["max_chars"]:
                selected = proposal
    return {
        **anchor,
        "anchor_quote": anchor["quote"],
        "quote": render(selected),
        "segments": selected,
    }


def expand_plan(plan, prompt):
    refs = json.loads(REFERENCES.read_text(encoding="utf-8"))
    if refs["source_sha256"] != hashlib.sha256(SOURCE.read_bytes()).hexdigest():
        raise ValueError("Changed media source")
    source = json.loads(SOURCE.read_text(encoding="utf-8"))
    lookup = {}
    for record in source["sources"]:
        for segment in record["segments"]:
            if segment["id"] in lookup:
                raise ValueError("Duplicate segment across records")
            lookup[segment["id"]] = record
    result = []
    for case in plan:
        if len(case["citations"]) > 8:
            raise ValueError("Too many anchors")
        citations = []
        for anchor in case["citations"]:
            record = lookup[anchor["source_id"]]
            citations.append(
                {
                    **expand(anchor, record["segments"]),
                    "record_id": record["record_id"],
                    "title": record["media_name"],
                }
            )
        context = (
            "【会议字幕】\n"
            + "\n\n".join(
                f"[{c['n']}]《{c['title']}》\n{c['quote']}" for c in citations
            )
            + "\n"
        )
        result.append(
            {
                **case,
                "citations": citations,
                "system": prompt.format(context=context) if citations else None,
            }
        )
    return result


def availability(plan):
    """Context presence is not evidence selection or final answer correctness."""
    refs = {
        c["id"]: c for c in json.loads(REFERENCES.read_text(encoding="utf-8"))["cases"]
    }
    rows = []
    for case in plan:
        texts = {}
        for citation in case["citations"]:
            for segment in citation.get(
                "segments", [{"id": citation["source_id"], "text": citation["quote"]}]
            ):
                texts.setdefault(segment["id"], []).append(segment["text"])
        covered = [
            any(
                any(
                    all(term in text for term in terms) for text in texts.get(ident, [])
                )
                for ident, terms in group.items()
            )
            for group in refs[case["id"].split("/")[0]]["fact_groups"]
        ]
        rows.append(
            {
                "id": case["id"],
                "arm": case["arm"],
                "fact_groups_present": covered,
                "all_fact_groups_present": all(covered),
                "context_chars": sum(len(c["quote"]) for c in case["citations"]),
            }
        )
    return rows
