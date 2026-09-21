"""Offline qwen3-rerank contract; ranking is not an answerability decision."""

import math

MODEL = "qwen3-rerank"
ENDPOINT = "https://dashscope.aliyuncs.com/compatible-api/v1/reranks"
POLICIES = {"rank_all": None, "top1": 1, "top2": 2}


def request_body(item):
    return {
        "model": MODEL,
        "query": item["question"],
        "documents": [c["title"] + "\n" + c["text"] for c in item["candidates"]],
        "top_n": len(item["candidates"]),
    }


def validate_response(data, item):
    if not isinstance(data, dict) or data.get("model") != MODEL:
        raise ValueError("Unexpected model response")
    rows = data.get("results")
    size = len(item["candidates"])
    if not isinstance(rows, list) or len(rows) != size:
        raise ValueError("All candidate ranks must be returned")
    seen, previous = set(), 1.0
    result = []
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Invalid rank object")
        index, score = row.get("index"), row.get("relevance_score")
        if type(index) is not int or not 0 <= index < size or index in seen:
            raise ValueError("Invalid or duplicate document index")
        if (
            type(score) not in (int, float)
            or not math.isfinite(score)
            or not 0 <= score <= previous
        ):
            raise ValueError("Invalid or unordered relevance score")
        seen.add(index)
        previous = score
        result.append({"id": item["candidates"][index]["id"], "score": score})
    usage = data.get("usage")
    if (
        not isinstance(usage, dict)
        or type(usage.get("total_tokens")) is not int
        or usage["total_tokens"] < 0
    ):
        raise ValueError("Missing token usage")
    return result


def select(ranked, policy):
    # Scores are request-relative: do not introduce an uncalibrated global cutoff.
    return ranked[: POLICIES[policy]]
