"""Scan committed Work logs for content fields or credential material."""

import re
import sys
from pathlib import Path

FORBIDDEN_FIELD = re.compile(
    r'"(?:goal|background|content|title|prompt|completion|api_key|secret|secret_ciphertext)"\s*:'
)
SECRET_PATTERNS = (
    re.compile(r"\bsk-[A-Za-z0-9]{8,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"-----BEGIN (?:RSA |EC )?PRIVATE KEY-----"),
)


def scan_text(text: str) -> list[str]:
    findings = []
    for number, line in enumerate(text.splitlines(), 1):
        if FORBIDDEN_FIELD.search(line):
            findings.append(f"line {number}: forbidden content field")
        if any(pattern.search(line) for pattern in SECRET_PATTERNS):
            findings.append(f"line {number}: credential material")
    return findings


def scan_paths(paths) -> list[str]:
    findings = []
    for path in paths:
        file = Path(path)
        if file.is_dir():
            files = sorted(file.rglob("*"))
        else:
            files = [file]
        for item in files:
            if not item.is_file():
                continue
            try:
                text = item.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            findings.extend(f"{item}: {line}" for line in scan_text(text))
    return findings


def main(argv=None) -> int:
    paths = (argv if argv is not None else sys.argv[1:]) or [
        "docs/plan/assets/work-r0a-hardening-2026-10-25/provider-smoke.log",
        "docs/plan/assets/work-r0a-hardening-2026-10-25/sandbox-smoke.log",
    ]
    findings = scan_paths(paths)
    if findings:
        for finding in findings:
            sys.stderr.write(finding + "\n")
        return 1
    sys.stdout.write(f"log scan ok: {len(paths)} path(s)\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
