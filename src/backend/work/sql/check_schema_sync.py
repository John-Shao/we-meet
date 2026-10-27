#!/usr/bin/env python3
"""Fail when work/sql/r0a_schema.sql drifts from the reviewed design asset.

The migration file is the design draft minus its destructive header: no role or
schema drops, no BEGIN/COMMIT, and a non-destructive CREATE SCHEMA prefix.
Everything after SET ROLE must match byte-for-byte so the 148-assertion smoke
and the nine races keep proving the generated file, not a stale copy.
"""

import difflib
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[3]
DRAFT = (
    REPO_ROOT
    / "docs"
    / "plan"
    / "assets"
    / "work-r0a-design-2026-10-25"
    / "r0a-schema-draft.sql"
)
SCHEMA = HERE / "r0a_schema.sql"

PREFIX = (
    "CREATE SCHEMA IF NOT EXISTS work AUTHORIZATION work_owner;\nSET ROLE work_owner;\n"
)
DRAFT_MARKER = "SET LOCAL ROLE work_owner;\n"
SCHEMA_MARKER = "SET ROLE work_owner;\n"


def body(text: str, marker: str) -> str:
    if marker not in text:
        raise SystemExit(f"missing marker {marker!r}")
    return text.split(marker, 1)[1]


def normalized(value: str) -> str:
    if "COMMIT;" in value:
        value = value.rsplit("COMMIT;", 1)[0]
    return value.rstrip() + "\n"


def main() -> int:
    schema = SCHEMA.read_text(encoding="utf-8")
    if not schema.startswith('-- E1 migration draft: R0a schema (schema "work").'):
        sys.stderr.write("schema header changed; update check_schema_sync.py\n")
        return 1
    if PREFIX not in schema:
        sys.stderr.write(f"schema prefix missing:\n{PREFIX}\n")
        return 1
    for forbidden in ("DROP ROLE", "DROP SCHEMA", "\nBEGIN;"):
        if forbidden in schema:
            sys.stderr.write(f"schema must not contain {forbidden!r}\n")
            return 1

    expected = normalized(body(DRAFT.read_text(encoding="utf-8"), DRAFT_MARKER))
    actual = normalized(body(schema, SCHEMA_MARKER))
    if expected != actual:
        sys.stderr.write("r0a_schema.sql drifted from r0a-schema-draft.sql:\n")
        diff = difflib.unified_diff(
            expected.splitlines(),
            actual.splitlines(),
            fromfile="design asset",
            tofile="work/sql/r0a_schema.sql",
            lineterm="",
        )
        sys.stderr.write("\n".join(diff) + "\n")
        return 1

    sys.stdout.write("ok: r0a_schema.sql matches the design asset body\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
