"""Bounded synthetic metadata capacity probe against the independent TLS authority.

No primary database, voice recordings, vectors or user identities are used.
"""

# Isolated container tmpfs and aggregate-only output are intentional.
# ruff: noqa: PLC0415, S108, T201

import json
import os
import resource
import statistics
import sys
import time
from pathlib import Path
from uuid import uuid4, uuid5


def require(value, code):
    if not value:
        raise RuntimeError("journal_capacity_" + code)


def snapshot(namespace, scopes):
    """One scope: permission, floor, source, three immutable contribution proofs."""
    state = {
        name: []
        for name in (
            "floors",
            "sources",
            "contributions",
            "permissions",
            "organizations",
        )
    }
    for index in range(scopes):
        identifier = lambda kind: str(uuid5(namespace, f"{index}:{kind}"))  # noqa: E731 -- One stable synthetic identity per row across increasing snapshots.
        owner, profile = identifier("owner"), identifier("profile")
        state["floors"].append(
            {
                "owner": owner,
                "organization": None,
                "generation": 2,
                "version": 2,
            }
        )
        state["permissions"].append(
            {
                "owner": owner,
                "organization": None,
                "generation": 2,
                "version": 2,
                "flags": {
                    "allow_enrollment": False,
                    "allow_accumulation": False,
                    "allow_identification": False,
                },
            }
        )
        state["sources"].append(
            {
                "kind": "record",
                "uuid": identifier("record"),
                "session": None,
                "digest": "",
            }
        )
        for slot in range(3):
            state["contributions"].append(
                {
                    "sample_uuid": identifier(f"sample:{slot}"),
                    "profile_uuid": profile,
                    "owner_uuid": owner,
                    "organization_uuid": None,
                    "generation": 1,
                    "templates": {
                        "all": False,
                        "permit_id": identifier(f"permit:{slot}"),
                        "rows": [
                            {
                                "id": identifier("template"),
                                "revision": 1,
                                "digest": "f" * 64,
                                "baseline": True,
                            }
                        ],
                    },
                }
            )
    return state


def milliseconds(operation, repeats):
    values = []
    for _index in range(repeats):
        start = time.perf_counter()
        operation()
        values.append((time.perf_counter() - start) * 1000)
    return {
        "samples": repeats,
        "median_ms": round(statistics.median(values), 2),
        "maximum_ms": round(max(values), 2),
    }


def main():  # noqa: PLR0915 -- Keep the owned fixture, measurements and negative checks together.
    require(sys.platform == "linux" and os.getuid() == 10001, "linux_uid")
    require(os.environ.get("VOICEPRINT_JOURNAL_PROBE") == "1", "opt_in")
    from configurations import importer

    importer.install()
    import django

    django.setup()
    from django.conf import settings
    from django.db import connection

    from core.services import voiceprint_journal as journal
    from core.services import voiceprint_recovery as recovery

    require(
        settings.DATABASES["default"]["NAME"] == "primary_unavailable", "no_primary"
    )

    def primary_denied():
        raise RuntimeError("journal_capacity_primary_touched")

    connection.ensure_connection = primary_denied
    root = Path("/tmp/journal")
    root.mkdir(mode=0o700)
    packed = json.loads(os.environ.pop("VOICEPRINT_JOURNAL_FIXTURE"))
    clients = {}
    for role in ("writer", "reader"):
        path = root / (role + ".json")
        recovery.write_private(path, packed[role])
        clients[role] = journal.Journal(journal.load_configuration(path, role))
    writer, reader = clients["writer"], clients["reader"]
    namespace = uuid4()
    head = {"sequence": 0, "digest": journal.ZERO}
    require(writer.read_head() == head, "operator_zero_head")
    observations = []
    for scopes in (100, 1000, 3000):
        state = snapshot(namespace, scopes)
        head = writer.publish(head, state)
        head, normalized = reader.read_current()
        require(
            normalized == journal.merge(journal.empty(), state), "all_rows_retained"
        )

        def publish():
            nonlocal head
            captured, previous = writer.read_current()
            journal.merge(previous, state)
            head = writer.publish(captured, state)

        def prepared_publish():
            nonlocal head
            _captured, append = writer.prepare_publication()
            head = append(state, force=True)

        observations.append(
            {
                "scopes": scopes,
                "rows": sum(len(rows) for rows in state.values()),
                "clear_metadata_bytes": len(recovery.canonical(state)),
                "stored_envelope_bytes": len(
                    writer.call(
                        "SELECT sequence,previous,digest,envelope FROM voiceprint_journal.read_current(%s)",
                        (writer.configuration["deployment_id"],),
                    )[0][3]
                ),
                "fresh_head": milliseconds(reader.read_head, 5),
                "full_verified_read": milliseconds(reader.read_current, 3),
                # Same double-read/merge pattern as runtime.mutation, excluding
                # the primary transaction, capture queries and lock contention.
                "publication_without_primary": milliseconds(publish, 3),
                "prepared_publication_without_primary": milliseconds(
                    prepared_publish, 3
                ),
            }
        )
    _expected, first = writer.prepare_publication()
    _expected, stale = writer.prepare_publication()
    head = first(journal.empty(), force=True)
    try:
        stale(journal.empty(), force=True)
    except journal.JournalError as error:
        require(str(error) == "voiceprint_journal_conflict", "prepared_conflict_code")
    else:
        raise RuntimeError("journal_capacity_stale_preparation_committed")
    require(reader.read_head() == head, "prepared_conflict_kept_head")
    oversized = snapshot(namespace, 6500)
    oversized_bytes = len(recovery.canonical(oversized))
    require(oversized_bytes > recovery.MAX_CLEAR, "oversized_fixture")
    before = reader.read_head()
    try:
        writer.publish(before, oversized)
    except (journal.JournalError, recovery.RecoveryError) as error:
        require(str(error).endswith("budget_exceeded"), "size_failure_code")
    else:
        raise RuntimeError("journal_capacity_oversized_snapshot_committed")
    require(reader.read_head() == before, "rejected_snapshot_kept_head")
    require(reader.read_current() == (head, normalized), "no_rows_truncated")
    (root / "phase").write_text("published", encoding="utf-8")
    deadline = time.monotonic() + 45
    while not (root / "restarted").exists():
        require(time.monotonic() < deadline, "restart_timeout")
        time.sleep(0.2)
    require(reader.read_current() == (head, normalized), "restart_kept_all_rows")
    request = recovery.request_for(reader.configuration["deployment_id"])
    start = time.perf_counter()
    bundle = writer.export_recovery(request)
    exported_ms = round((time.perf_counter() - start) * 1000, 2)
    captured, exported = journal.verify_export(reader.configuration, request, bundle)
    require(
        captured == head
        and {name: exported[name] for name in journal.TABLES} == normalized,
        "large_recovery_verified",
    )
    return {
        "status": "passed",
        "uid": os.getuid(),
        "verified_tls": True,
        "real_postgresql": True,
        "primary_database_used": False,
        "human_audio_used": False,
        "model_requests": 0,
        "observations": observations,
        "largest_rejected_metadata_bytes": oversized_bytes,
        "oversized_head_unchanged": True,
        "prepared_conflict_preserved_latest_head": True,
        "no_rows_truncated": True,
        "authority_restart_preserved_state": True,
        "large_signed_recovery_verified": True,
        "large_recovery_export_ms": exported_ms,
        "large_recovery_bundle_bytes": len(recovery.canonical(bundle)),
        "maximum_clear_bytes": recovery.MAX_CLEAR,
        "maximum_rows_per_table": recovery.MAX_ROWS,
        "process_peak_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "latest_sequence": head["sequence"],
    }


if __name__ == "__main__":
    try:
        print(json.dumps(main(), sort_keys=True), flush=True)
    except Exception as error:  # noqa: BLE001 -- SQL and private configuration stay out of diagnostics.
        print(
            json.dumps({"status": "failed", "error_type": type(error).__name__}),
            flush=True,
        )
        raise SystemExit(1) from None
