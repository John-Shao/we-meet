"""Strict review wire validation, without an upstream harness dependency."""

import hashlib


def digest(value):
    return hashlib.sha256(value).hexdigest()


def require(condition):
    if not condition:
        raise ValueError("invalid_review_report")


def validate_report(value, files):
    try:
        require(
            isinstance(value, dict)
            and set(value) == {"verdict", "summary", "findings", "missing_information"}
        )
        require(value["verdict"] in {"no_issues", "needs_changes", "inconclusive"})
        require(
            isinstance(value["summary"], str) and 1 <= len(value["summary"]) <= 4000
        )
        require(isinstance(value["findings"], list) and len(value["findings"]) <= 20)
        require(isinstance(value["missing_information"], list))
        require(len(value["missing_information"]) <= 20)
        require(
            all(
                (
                    isinstance(v, str) and 1 <= len(v) <= 1000
                    for v in value["missing_information"]
                )
            )
        )
        if value["verdict"] == "needs_changes":
            require(value["findings"])
        if value["verdict"] == "no_issues":
            require(not value["findings"] and (not value["missing_information"]))
        if value["verdict"] == "inconclusive":
            require(value["missing_information"])
        texts = {item["name"]: item for item in files}
        for finding in value["findings"]:
            require(
                isinstance(finding, dict)
                and set(finding) == {"severity", "message", "evidence"}
            )
            require(finding["severity"] in {"error", "warning"})
            require(
                isinstance(finding["message"], str)
                and 1 <= len(finding["message"]) <= 2000
            )
            require(
                isinstance(finding["evidence"], list)
                and 1 <= len(finding["evidence"]) <= 5
            )
            for ref in finding["evidence"]:
                require(
                    isinstance(ref, dict) and set(ref) == {"file", "sha256", "quote"}
                )
                item = texts[ref["file"]]
                require(ref["sha256"] == digest(item["text"].encode()))
                require(isinstance(ref["quote"], str) and 1 <= len(ref["quote"]) <= 500)
                require(ref["quote"].strip() and ref["quote"] in item["text"])
    except (ValueError, KeyError, TypeError):
        raise ValueError("invalid_review_report") from None
    return value
