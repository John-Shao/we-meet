"""Local one-shot gates before any provider tool call reaches the runtime."""

import json
import time
import uuid

from .contract import ContractError, canonical, digest


def tool_calls(data, streaming):
    calls = {}
    records = (
        [
            json.loads(line[6:])
            for line in data.splitlines()
            if line.startswith(b"data: ") and line.strip() != b"data: [DONE]"
        ]
        if streaming
        else [json.loads(data)]
    )
    for record in records:
        choices = record.get("choices", [])
        if len(choices) > 1:
            raise ContractError("invalid_tool_response", 502)
        for choice in choices:
            message = choice.get("delta" if streaming else "message", {})
            if message.get("function_call"):
                raise ContractError("invalid_tool_response", 502)
            for index, call in enumerate(message.get("tool_calls", [])):
                if call.get("type", "function") != "function":
                    raise ContractError("invalid_tool_response", 502)
                key = call.get("index", index)
                accumulated = calls.setdefault(key, {"name": "", "arguments": ""})
                function = call.get("function", {})
                for field in accumulated:
                    accumulated[field] += function.get(field, "")
    for call in calls.values():
        if not call["name"] or len(canonical(call)) > 60000:
            raise ContractError("invalid_tool_response", 502)
        arguments = json.loads(call["arguments"])
        if not isinstance(arguments, dict):
            raise ContractError("invalid_tool_response", 502)
    return list(calls.values())


class ApprovalGate:
    def __init__(self, store, timeout=120):
        self.store, self.timeout = store, timeout
        with store.lock, store.db:
            store.db.execute("""CREATE TABLE IF NOT EXISTS local_approvals (
                id TEXT PRIMARY KEY, job_id TEXT NOT NULL, body TEXT NOT NULL,
                sha256 TEXT NOT NULL, state TEXT NOT NULL,
                created REAL NOT NULL, decided REAL)""")
            # A lost decision must never become a grant after restart.
            store.db.execute(
                "UPDATE local_approvals SET state='cancelled', decided=? "
                "WHERE state='pending'",
                (time.time(),),
            )

    def paused_seconds(self, run_id):
        with self.store.lock:
            rows = self.store.db.execute(
                "SELECT created, decided FROM local_approvals WHERE job_id=?", (run_id,)
            ).fetchall()
        return min(
            600,
            sum(
                min(self.timeout, (r["decided"] or time.time()) - r["created"])
                for r in rows
            ),
        )

    def pending(self, run_id):
        with self.store.lock:
            rows = self.store.db.execute(
                "SELECT * FROM local_approvals WHERE job_id=? AND state='pending'",
                (run_id,),
            ).fetchall()
        return [
            {"id": r["id"], "sha256": r["sha256"], **json.loads(r["body"])}
            for r in rows
        ]

    def decide(self, run_id, identifier, fingerprint, allow):
        if type(allow) is not bool:
            raise ContractError("invalid_approval")
        with self.store.lock, self.store.db:
            row = self.store.db.execute(
                "SELECT * FROM local_approvals WHERE id=? AND job_id=?",
                (identifier, run_id),
            ).fetchone()
            if not row or row["sha256"] != fingerprint or row["state"] != "pending":
                raise ContractError("approval_unavailable", 409)
            if (
                self.store.get(run_id)["state"] != "running"
                or time.time() - row["created"] >= self.timeout
            ):
                raise ContractError("approval_unavailable", 409)
            self.store.db.execute(
                "UPDATE local_approvals SET state=?, decided=? WHERE id=?",
                ("allowed" if allow else "rejected", time.time(), identifier),
            )

    def review(self, run_id, data, streaming, advertised):
        for call in tool_calls(data, streaming):
            if call["name"] not in advertised:
                raise ContractError("invalid_tool_response", 502)
            body = {"tool": call["name"], "arguments": call["arguments"]}
            encoded = canonical(body)
            identifier = str(uuid.uuid4())
            created = time.time()
            with self.store.lock, self.store.db:
                if self.store.get(run_id)["state"] != "running":
                    raise ContractError("approval_cancelled", 409)
                self.store.db.execute(
                    "INSERT INTO local_approvals VALUES "
                    "(?, ?, ?, ?, 'pending', ?, NULL)",
                    (identifier, run_id, encoded.decode(), digest(encoded), created),
                )
            outcome = "pending"
            while outcome == "pending":
                time.sleep(0.05)
                with self.store.lock, self.store.db:
                    outcome = self.store.db.execute(
                        "SELECT state FROM local_approvals WHERE id=?", (identifier,)
                    ).fetchone()["state"]
                    if (
                        self.store.get(run_id)["state"] != "running"
                        or time.time() - created >= self.timeout
                    ):
                        outcome = "cancelled"
                        self.store.db.execute(
                            "UPDATE local_approvals SET state='cancelled', decided=? "
                            "WHERE id=? AND state='pending'",
                            (time.time(), identifier),
                        )
            if outcome != "allowed":
                with self.store.lock, self.store.db:
                    self.store.db.execute(
                        "INSERT OR REPLACE INTO model_denials VALUES (?, ?)",
                        (run_id, "approval_denied"),
                    )
                raise ContractError("approval_denied", 403)
