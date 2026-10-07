"""Single-claim task delivery and idempotent results, scoped to one Pod UID."""

import copy
import hmac
import secrets
import threading

from .contract import (
    MAX_RESULT_BYTES,
    ContractError,
    canonical,
    digest,
    validate_result,
)


class TaskTransport:
    def __init__(self, store):
        self.store = store
        self.lock = threading.Lock()
        self.tasks = {}

    def register(self, request, environment):
        token = secrets.token_urlsafe(32)
        with self.lock:
            if request["run_id"] in self.tasks:
                raise RuntimeError("task_already_registered")
            self.tasks[request["run_id"]] = {
                "token": token,
                "uid": None,
                "claimed": False,
                "result": None,
                "payload": {
                    "request": copy.deepcopy(request),
                    "environment": dict(environment),
                },
            }
        return token

    def assign(self, run_id, uid):
        with self.lock:
            self.tasks[run_id]["uid"] = uid

    def exchange(self, run_id, action, authorization, body):
        with self.lock:
            task = self.tasks.get(run_id)
            if not task or not hmac.compare_digest(
                authorization.encode(), ("Bearer " + task["token"]).encode()
            ):
                raise ContractError("unauthorized", 401)
            if self.store.get(run_id)["state"] != "running":
                raise ContractError("task_not_running", 409)
            if not task["uid"]:
                raise ContractError("task_not_ready", 409)
            if not isinstance(body, dict) or body.get("pod_uid") != task["uid"]:
                raise ContractError("task_identity_mismatch", 403)
            if action == "bootstrap":
                if set(body) != {"pod_uid"}:
                    raise ContractError("invalid_request")
                if task["claimed"]:
                    raise ContractError("task_already_claimed", 409)
                task["claimed"] = True
                return copy.deepcopy(task["payload"])
            if (
                action != "result"
                or set(body) != {"pod_uid", "result"}
                or not task["claimed"]
            ):
                raise ContractError("invalid_request")
            encoded = canonical(body["result"])
            if len(encoded) > MAX_RESULT_BYTES or any(
                token and token.encode() in encoded
                for token in (
                    task["token"],
                    task["payload"]["environment"].get("WORK_AGENT_MODEL_TOKEN"),
                )
            ):
                raise ContractError("invalid_result")
            result = validate_result(body["result"])
            result_hash = digest(canonical(result))
            if (
                task["result"] is not None
                and digest(canonical(task["result"])) != result_hash
            ):
                raise ContractError("task_result_conflict", 409)
            task["result"] = copy.deepcopy(result)
            return {"accepted": True, "sha256": result_hash}

    def result(self, run_id):
        with self.lock:
            return copy.deepcopy(self.tasks[run_id]["result"])

    def revoke(self, run_id):
        with self.lock:
            self.tasks.pop(run_id, None)
