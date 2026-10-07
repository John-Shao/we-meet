"""Our wire contract, intentionally independent of upstream SDK objects."""

import hashlib
import json
import re
import uuid

from . import CONTRACT

MAX_REQUEST_BYTES = 512_000
MAX_RESULT_BYTES = 2_000_000
TERMINAL = {"succeeded", "failed", "cancelled"}
DEFAULT_LIMITS = {
    "max_model_calls": 6,
    "max_total_tokens": 80000,
    "max_output_tokens": 4096,
}


class ContractError(Exception):
    def __init__(self, code, status=400):
        super().__init__(code)
        self.code = code
        self.status = status


def digest(value):
    return hashlib.sha256(value).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True).encode("utf-8")


def filename(value):
    # Flat names only: no paths, dotfiles, Windows devices, ADS or plugin folders.
    if not isinstance(value, str) or not re.fullmatch(
        r"[\w\-][\w .\-]{0,99}\.(?:txt|md|csv|json)", value
    ):
        raise ContractError("invalid_filename")
    stem = value.split(".")[0].upper().rstrip(" ")
    if stem in {"CON", "PRN", "AUX", "NUL"} or re.fullmatch(r"(?:COM|LPT)[0-9]", stem):
        raise ContractError("invalid_filename")
    return value


def validate_request(body):
    if not isinstance(body, dict) or set(body) - {"limits"} != {
        "contract",
        "run_id",
        "goal",
        "files",
        "timeout_seconds",
    }:
        raise ContractError("invalid_request")
    if body["contract"] != CONTRACT:
        raise ContractError("unsupported_contract", 409)
    if "limits" in body:
        limits = body["limits"]
        if not isinstance(limits, dict) or set(limits) != set(DEFAULT_LIMITS):
            raise ContractError("invalid_limits")
        if any(
            type(limits[key]) is not int or not 1 <= limits[key] <= ceiling
            for key, ceiling in DEFAULT_LIMITS.items()
        ):
            raise ContractError("invalid_limits")
    try:
        run_id = str(uuid.UUID(body["run_id"]))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ContractError("invalid_run_id") from exc
    if run_id != body["run_id"]:
        raise ContractError("invalid_run_id")
    if not isinstance(body["goal"], str) or not 1 <= len(body["goal"]) <= 8000:
        raise ContractError("invalid_goal")
    if (
        type(body["timeout_seconds"]) is not int
        or not 1 <= body["timeout_seconds"] <= 300
    ):
        raise ContractError("invalid_timeout")
    if not isinstance(body["files"], list) or len(body["files"]) > 20:
        raise ContractError("invalid_files")
    names = set()
    total = 0
    for item in body["files"]:
        if not isinstance(item, dict) or set(item) != {"name", "text", "sha256"}:
            raise ContractError("invalid_file")
        name = filename(item["name"])
        if name.casefold() in names or not isinstance(item["text"], str):
            raise ContractError("invalid_file")
        names.add(name.casefold())
        content = item["text"].encode("utf-8")
        total += len(content)
        if item["sha256"] != digest(content):
            raise ContractError("checksum_mismatch")
    if total > 400_000:
        raise ContractError("materials_too_large", 413)
    return body


def validate_result(result):
    if not isinstance(result, dict) or set(result) != {
        "summary",
        "usage",
        "artifacts",
        "elapsed_ms",
    }:
        raise ContractError("invalid_result")
    if (
        not isinstance(result["summary"], str)
        or not 1 <= len(result["summary"]) <= 100_000
    ):
        raise ContractError("invalid_result")
    if type(result["elapsed_ms"]) is not int or result["elapsed_ms"] < 0:
        raise ContractError("invalid_result")
    if result["usage"] is not None:
        usage = result["usage"]
        if (
            not isinstance(usage, dict)
            or set(usage)
            != {
                "input_tokens",
                "output_tokens",
                "cache_read_tokens",
                "cache_write_tokens",
            }
            or any(type(value) is not int or value < 0 for value in usage.values())
        ):
            raise ContractError("invalid_usage")
    validate_request(
        {
            "contract": CONTRACT,
            "run_id": "00000000-0000-0000-0000-000000000000",
            "goal": "result validation",
            "files": result["artifacts"],
            "timeout_seconds": 1,
        }
    )
    return result
