"""Compare matching offline QA reports; passing is non-regression, not release approval."""

import argparse
import json
import math
from pathlib import Path


def compare(baseline, candidate):
    for key in ("schema_version", "dataset", "dataset_sha256", "scope", "generation"):
        if baseline.get(key) != candidate.get(key) or key not in baseline:
            raise ValueError(f"incompatible {key}")
    old = {row["id"]: row for row in baseline["cases"]}
    new = {row["id"]: row for row in candidate["cases"]}
    if (
        not old
        or old.keys() != new.keys()
        or len(old) != len(baseline["cases"])
        or len(new) != len(candidate["cases"])
    ):
        raise ValueError("case IDs must be complete and unique")
    failures, improvements = [], []
    for case_id, previous in old.items():
        current = new[case_id]
        if (
            previous["gold_evidence"] != current["gold_evidence"]
            or previous["question"] != current["question"]
        ):
            raise ValueError("questions and gold evidence must not change")
        metrics = current["metrics"]
        if metrics["forbidden_content"] or metrics["empty_expectation_met"] is False:
            failures.append(case_id + ": access/version/empty boundary")
        for key in ("evidence_recall", "record_recall", "evidence_precision"):
            before, after = previous["metrics"][key], metrics[key]
            if before is None and after is None:
                continue
            if (
                before is None
                or after is None
                or not all(
                    isinstance(v, (int, float)) and math.isfinite(v) and 0 <= v <= 1
                    for v in (before, after)
                )
            ):
                raise ValueError("invalid or changed metric denominator")
            if after < before:
                failures.append(case_id + ": " + key)
            elif after > before:
                improvements.append(case_id + ": " + key)
    return {
        "passed": not failures,
        "regressions": failures,
        "improvements": improvements,
        "answer_semantics": "not_evaluated",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidate", type=Path)
    args = parser.parse_args()
    result = compare(
        *(
            json.loads(p.read_text(encoding="utf-8"))
            for p in (args.baseline, args.candidate)
        )
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))  # noqa: T201 -- CLI report
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
