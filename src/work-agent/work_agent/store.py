"""Single-gateway durable inbox. Unknown executions are never auto-replayed."""

import json
import sqlite3
import threading
import time
from pathlib import Path

from . import CONTRACT
from .contract import DEFAULT_LIMITS, TERMINAL, ContractError, canonical, digest


class Store:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("""CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, request TEXT NOT NULL,
            state TEXT NOT NULL, result TEXT, error TEXT NOT NULL DEFAULT '',
            created REAL NOT NULL, updated REAL NOT NULL)""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS events (
            job_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
            created REAL NOT NULL, PRIMARY KEY(job_id, seq))""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS model_calls (
            job_id TEXT NOT NULL, seq INTEGER NOT NULL, request_sha256 TEXT NOT NULL,
            reservation INTEGER NOT NULL, usage TEXT,
            PRIMARY KEY(job_id, seq))""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS model_denials (
            job_id TEXT PRIMARY KEY, code TEXT NOT NULL)""")
        if "deployment" not in {
            row[1] for row in self.db.execute("PRAGMA table_info(jobs)")
        }:
            self.db.execute(
                "ALTER TABLE jobs ADD COLUMN deployment TEXT NOT NULL DEFAULT '{}'"
            )
        self.db.commit()

    def close(self):
        self.db.close()

    def operation(self, run_id):
        with self.lock:
            row = self.db.execute(
                "SELECT request FROM jobs WHERE id=?", (run_id,)
            ).fetchone()
            return json.loads(row["request"]).get("operation") if row else None

    def frozen_review_files(self, run_id):
        """Private admitted snapshot, independent of client model request fields."""
        with self.lock:
            row = self.db.execute(
                "SELECT request FROM jobs WHERE id=?", (run_id,)
            ).fetchone()
            if not row:
                raise ContractError("not_found", 404)
            request = json.loads(row["request"])
            if request.get("operation") != "review":
                raise ContractError("invalid_request")
            return request["files"]

    def _event(self, run_id, state):
        self.db.execute(
            """INSERT INTO events VALUES (?,
            (SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE job_id=?), ?, ?)""",
            (run_id, run_id, state, time.time()),
        )

    def admit(self, body, deployment=None):
        encoded = canonical(body)
        fingerprint = digest(encoded)
        run_id = body["run_id"]
        with self.lock, self.db:
            previous = self.db.execute(
                "SELECT * FROM jobs WHERE id=?", (run_id,)
            ).fetchone()
            if previous:
                if previous["fingerprint"] == "cancelled-before-admission":
                    return False
                if previous["fingerprint"] != fingerprint:
                    raise ContractError("idempotency_conflict", 409)
                return False
            if (
                self.db.execute(
                    "SELECT COUNT(*) FROM jobs WHERE state IN ('queued', 'running')"
                ).fetchone()[0]
                >= 20
            ):
                raise ContractError("queue_full", 429)
            now = time.time()
            self.db.execute(
                "INSERT INTO jobs VALUES (?, ?, ?, 'queued', NULL, '', ?, ?, ?)",
                (
                    run_id,
                    fingerprint,
                    encoded.decode(),
                    now,
                    now,
                    json.dumps(deployment or {}),
                ),
            )
            self._event(run_id, "queued")
            return True

    def recover(self):
        with self.lock, self.db:
            for row in self.db.execute(
                "SELECT id FROM jobs WHERE state='running'"
            ).fetchall():
                self.finish(row["id"], "failed", error="execution_unknown")

    def running_ids(self):
        with self.lock:
            return [
                row["id"]
                for row in self.db.execute(
                    "SELECT id FROM jobs WHERE state='running'"
                ).fetchall()
            ]

    def cancel(self, run_id):
        """Persist a tombstone even before admission; cancellation wins that race."""
        with self.lock, self.db:
            previous = self.db.execute(
                "SELECT id FROM jobs WHERE id=?", (run_id,)
            ).fetchone()
            if not previous:
                now = time.time()
                self.db.execute(
                    "INSERT INTO jobs VALUES "
                    "(?, ?, '{}', 'cancelled', NULL, '', ?, ?, '{}')",
                    (run_id, "cancelled-before-admission", now, now),
                )
                self._event(run_id, "cancelled")
            else:
                self.finish(run_id, "cancelled")

    def claim(self):
        with self.lock, self.db:
            row = self.db.execute(
                "SELECT * FROM jobs WHERE state='queued' ORDER BY created LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            self.db.execute(
                "UPDATE jobs SET state='running', updated=? WHERE id=?",
                (time.time(), row["id"]),
            )
            self._event(row["id"], "running")
            return json.loads(row["request"])

    def finish(self, run_id, state, result=None, error=""):
        if state not in TERMINAL:
            raise ValueError("terminal state required")
        with self.lock, self.db:
            row = self.db.execute(
                "SELECT state FROM jobs WHERE id=?", (run_id,)
            ).fetchone()
            if row is None:
                raise ContractError("not_found", 404)
            if row["state"] in TERMINAL:
                return False
            self.db.execute(
                "UPDATE jobs SET state=?, result=?, error=?, updated=? WHERE id=?",
                (
                    state,
                    json.dumps(result) if result is not None else None,
                    error,
                    time.time(),
                    run_id,
                ),
            )
            self._event(run_id, state)
            return True

    def get(self, run_id, after=0):
        with self.lock:
            row = self.db.execute("SELECT * FROM jobs WHERE id=?", (run_id,)).fetchone()
            if row is None:
                raise ContractError("not_found", 404)
            events = self.db.execute(
                "SELECT seq, type, created FROM events "
                "WHERE job_id=? AND seq>? ORDER BY seq",
                (run_id, after),
            ).fetchall()
            return {
                "contract": CONTRACT,
                "run_id": run_id,
                "state": row["state"],
                "deployment": json.loads(row["deployment"]),
                "error_code": row["error"],
                "result": json.loads(row["result"]) if row["result"] else None,
                "events": [dict(event) for event in events],
                "metering": self.metering(run_id),
            }

    def limits(self, run_id):
        with self.lock:
            row = self.db.execute(
                "SELECT request FROM jobs WHERE id=?", (run_id,)
            ).fetchone()
            if row is None:
                raise ContractError("not_found", 404)
            return json.loads(row["request"]).get("limits", DEFAULT_LIMITS)

    def request_deadline(self, run_id):
        with self.lock:
            row = self.db.execute(
                "SELECT request, updated FROM jobs WHERE id=?", (run_id,)
            ).fetchone()
            if row is None:
                raise ContractError("not_found", 404)
            return row["updated"] + json.loads(row["request"])["timeout_seconds"]

    def reserve_model_request(self, run_id, body):
        """Fit output to remaining credit without reducing the input reservation."""
        with self.lock:
            limits = self.limits(run_id)
            body = dict(body)
            body["max_tokens"] = limits["max_output_tokens"]
            encoded = canonical(body)
            room = (
                limits["max_total_tokens"]
                - self.metering(run_id)["held_tokens"]
                - len(encoded)
                - 1024
            )
            # The full-size encoding is a conservative bound: a smaller positive
            # integer cannot lengthen it. Unknown calls still hold every byte.
            if room > 0:
                body["max_tokens"] = min(limits["max_output_tokens"], room)
                encoded = canonical(body)
            sequence = self.reserve_model_call(
                run_id, encoded, output_tokens=body["max_tokens"]
            )
            return sequence, encoded

    def reserve_model_call(self, run_id, request_bytes, *, output_tokens=None):
        """Unknown attempts retain a full reservation; no implicit model retry."""
        with self.lock, self.db:
            row = self.db.execute(
                "SELECT state FROM jobs WHERE id=?", (run_id,)
            ).fetchone()
            if row is None or row["state"] != "running":
                raise ContractError("job_not_running", 409)
            limits = self.limits(run_id)
            meter = self.metering(run_id)
            if output_tokens is None:
                output_tokens = limits["max_output_tokens"]
            if (
                type(output_tokens) is not int
                or not 1 <= output_tokens <= limits["max_output_tokens"]
            ):
                raise ContractError("invalid_output_limit")
            reservation = len(request_bytes) + 1024 + output_tokens
            if meter["calls"] >= limits["max_model_calls"] or (
                meter["held_tokens"] + reservation > limits["max_total_tokens"]
            ):
                self.db.execute(
                    "INSERT OR REPLACE INTO model_denials VALUES (?, ?)",
                    (run_id, "budget_exceeded"),
                )
                self._event(run_id, "model_budget_exhausted")
                # Commit the denial before raising out of this transaction.
                self.db.commit()
                raise ContractError("budget_exceeded", 429)
            seq = meter["calls"] + 1
            self.db.execute(
                "INSERT INTO model_calls VALUES (?, ?, ?, ?, NULL)",
                (run_id, seq, digest(request_bytes), reservation),
            )
            self._event(run_id, "model_started")
            return seq

    def record_model_usage(self, run_id, seq, usage):
        with self.lock, self.db:
            # Usage may arrive after cancellation; preserve it independently.
            self.db.execute(
                "UPDATE model_calls SET usage=? "
                "WHERE job_id=? AND seq=? AND usage IS NULL",
                (json.dumps(usage), run_id, seq),
            )

    def metering(self, run_id):
        with self.lock:
            calls = self.db.execute(
                "SELECT reservation, usage FROM model_calls "
                "WHERE job_id=? ORDER BY seq",
                (run_id,),
            ).fetchall()
            totals = {
                "input_tokens": 0,
                "output_tokens": 0,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
            }
            known = 0
            held = 0
            for call in calls:
                if call["usage"] is None:
                    held += call["reservation"]
                else:
                    usage = json.loads(call["usage"])
                    known += 1
                    for key in totals:
                        totals[key] += usage[key]
                    held += sum(usage.values())
            denial = self.db.execute(
                "SELECT code FROM model_denials WHERE job_id=?", (run_id,)
            ).fetchone()
            return {
                "calls": len(calls),
                "complete": known == len(calls),
                "usage": totals if calls and known else None,
                "held_tokens": held,
                "denial_code": denial["code"] if denial else "",
            }
