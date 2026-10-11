"""Opt-in real TLS/CAS/role fixture; no primary database exists here."""

# The container owns its private tmpfs and emits only aggregate diagnostics.
# ruff: noqa: PLC0415, S108, T201

import copy
import hashlib
import io
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from uuid import uuid4


def require(value, code):
    if not value:
        raise RuntimeError("journal_fixture_" + code)


def main():  # noqa: PLR0915 -- One isolated fixture validates permissions, concurrency and outage export.
    require(sys.platform == "linux" and os.getuid() == 10001, "nonroot_linux")
    require(os.environ.get("VOICEPRINT_JOURNAL_PROBE") == "1", "opt_in")
    from configurations import importer

    importer.install()
    import django

    django.setup()
    from django.conf import settings
    from django.core.management import call_command
    from django.db import connection

    from core.services import voiceprint_journal as journal
    from core.services import voiceprint_recovery as recovery

    require(
        settings.DATABASES["default"]["NAME"] == "primary_unavailable",
        "no_primary_database",
    )
    root = Path("/tmp/journal")
    root.mkdir(mode=0o700)
    packed = json.loads(os.environ.pop("VOICEPRINT_JOURNAL_FIXTURE"))
    writer_path, reader_path = root / "writer.json", root / "reader.json"
    recovery.write_private(writer_path, packed["writer"])
    recovery.write_private(reader_path, packed["reader"])
    writer_config = journal.load_configuration(writer_path, "writer")
    reader_config = journal.load_configuration(reader_path, "reader")
    writer, reader = journal.Journal(writer_config), journal.Journal(reader_config)
    initial = {"sequence": 0, "digest": journal.ZERO}
    require(writer.read_head() == initial, "initialized_operator_head")
    baseline = journal.empty()
    owner = str(uuid4())
    baseline["permissions"] = [
        {
            "owner": owner,
            "organization": None,
            "generation": 1,
            "version": 1,
            "flags": {
                "allow_enrollment": True,
                "allow_accumulation": False,
                "allow_identification": True,
            },
        }
    ]
    committed = writer.publish(initial, baseline)
    require(committed["sequence"] == 1, "initial_snapshot")
    require(reader.read_current() == (committed, baseline), "reader_current")
    barrier = Barrier(2)

    class Competitive(journal.Journal):
        def call(self, statement, parameters):
            if "append_record" in statement:
                barrier.wait(timeout=10)
            return super().call(statement, parameters)

    def compete(index):
        delta = journal.empty()
        delta["floors"] = [
            {
                "owner": str(uuid4()),
                "organization": None,
                "generation": 2,
                "version": index + 1,
            }
        ]
        try:
            return "committed", Competitive(writer_config).publish(committed, delta)
        except journal.JournalError as error:
            require(str(error) == "voiceprint_journal_conflict", "conflict_code")
            return "conflict", None

    with ThreadPoolExecutor(max_workers=2) as executor:
        result = list(executor.map(compete, (0, 1)))
    require(
        sorted(row[0] for row in result) == ["committed", "conflict"],
        "single_cas_winner",
    )
    current, state = reader.read_current()
    require(current["sequence"] == 2 and len(state["floors"]) == 1, "concurrent_state")
    denied = 0
    fake_blob = b"not a signed snapshot" * 12
    fake_digest = hashlib.sha256(fake_blob).hexdigest()
    cases = (
        (
            reader,
            "SELECT * FROM voiceprint_journal.append_record(%s,%s,%s,%s,%s)",
            (
                reader_config["deployment_id"],
                2,
                current["digest"],
                fake_blob,
                fake_digest,
            ),
        ),
        (writer, "SELECT count(*) FROM voiceprint_journal.entries", ()),
        (reader, "SELECT count(*) FROM voiceprint_journal.heads", ()),
        (
            writer,
            "UPDATE voiceprint_journal.heads SET sequence=sequence+1 RETURNING sequence",
            (),
        ),
        (writer, "DELETE FROM voiceprint_journal.entries RETURNING sequence", ()),
        (
            writer,
            "INSERT INTO voiceprint_journal.heads(deployment) VALUES (%s) RETURNING sequence",
            (str(uuid4()),),
        ),
    )
    for instance, statement, parameters in cases:
        try:
            instance.call(statement, parameters)
        except journal.JournalError as error:
            require(str(error) == "voiceprint_journal_unavailable", "role_denied_code")
            denied += 1
        else:
            raise RuntimeError("journal_fixture_role_bypass")
    # Even direct writer SQL with nullable preconditions must not bypass CAS.
    try:
        writer.call(
            "SELECT * FROM voiceprint_journal.append_record(%s,%s::bigint,%s::text,%s,%s)",
            (writer_config["deployment_id"], None, None, fake_blob, fake_digest),
        )
    except journal.JournalError as error:
        require(
            str(error) == "voiceprint_journal_conflict", "null_precondition_rejected"
        )
    else:
        raise RuntimeError("journal_fixture_null_bypass")
    require(reader.read_head() == current, "denials_kept_head")
    try:
        writer.publish(committed, journal.empty())
    except journal.JournalError as error:
        require(str(error) == "voiceprint_journal_conflict", "stale_source_rejected")
    else:
        raise RuntimeError("journal_fixture_stale_overwrite")
    wrong_host = copy.deepcopy(reader_config)
    wrong_host["database"]["host"] = "wrong-authority"
    try:
        journal.Journal(wrong_host).read_head()
    except journal.JournalError as error:
        require(str(error) == "voiceprint_journal_unavailable", "tls_hostname_rejected")
    else:
        raise RuntimeError("journal_fixture_tls_downgrade")
    require(reader.read_head() == current, "tls_kept_head")
    (root / "phase").write_text("published", encoding="utf-8")
    deadline = time.monotonic() + 45
    while not (root / "restarted").exists():
        if time.monotonic() >= deadline:
            raise RuntimeError("journal_fixture_restart_timeout")
        time.sleep(0.2)
    require(reader.read_current() == (current, state), "persistent_state_after_restart")
    request = recovery.request_for(reader_config["deployment_id"])
    request_path, output_path = root / "request.json", root / "export.json"
    recovery.write_private(request_path, request)

    # This is not just a query counter: any connection to the absent primary fails.
    def primary_denied():
        raise RuntimeError("journal_fixture_primary_touched")

    connection.ensure_connection = primary_denied
    output = io.StringIO()
    call_command(
        "export_voiceprint_journal_recovery",
        config=str(writer_path),
        request=str(request_path),
        output=str(output_path),
        stdout=output,
    )
    require(
        json.loads(output.getvalue())
        == {
            "status": "exported",
            "encrypted": True,
            "signed": True,
            "authority_bound": True,
        },
        "aggregate_output",
    )
    exported = recovery.read_private(output_path)
    captured, value = journal.verify_export(reader_config, request, exported)
    require(captured == current, "export_latest_head")
    require(
        {name: value[name] for name in journal.TABLES} == state, "export_current_state"
    )
    require("signing_key" not in reader_config, "reader_no_signing_key")
    fifo = root / "fifo.crt"
    os.mkfifo(fifo, 0o600)
    bad_config = copy.deepcopy(packed["reader"])
    bad_config["database"]["ca_file"] = str(fifo)
    bad_path = root / "bad.json"
    recovery.write_private(bad_path, bad_config)
    try:
        journal.load_configuration(bad_path, "reader")
    except journal.JournalError:
        pass
    else:
        raise RuntimeError("journal_fixture_special_ca_allowed")
    return {
        "status": "passed",
        "uid": os.getuid(),
        "real_postgresql": True,
        "authority_restart_preserved_state": True,
        "verified_tls": True,
        "wrong_hostname_rejected": True,
        "concurrent_publishers": 2,
        "commits": 1,
        "conflicts": 1,
        "latest_sequence": current["sequence"],
        "direct_role_operations_denied": denied,
        "null_preconditions_rejected": True,
        "stale_cursor_rejected": True,
        "recovery_export_without_primary_db": True,
        "recovery_export_binds_latest_head": True,
        "reader_has_no_signing_key": True,
        "special_ca_file_rejected": True,
        "human_audio_used": False,
        "model_requests": 0,
    }


if __name__ == "__main__":
    try:
        print(json.dumps(main(), sort_keys=True))
    except Exception as error:  # noqa: BLE001 -- Never print private framework, SQL or key bodies.
        print(json.dumps({"status": "failed", "error_type": type(error).__name__}))
        raise SystemExit(1)
