"""Ephemeral Pod bootstrap and result delivery; credentials never reach stdout."""

import json
import os
import ssl
import stat
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPSHandler, ProxyHandler, Request, build_opener

from .contract import (
    MAX_REQUEST_BYTES,
    MAX_RESULT_BYTES,
    canonical,
    digest,
    validate_request,
    validate_result,
)
from .model_broker import NoRedirect
from .runner import run

ENVIRONMENT = {
    "WORK_AGENT_ENGINE",
    "WORK_AGENT_MODEL",
    "WORK_AGENT_PROVIDER",
    "WORK_AGENT_MODEL_TOKEN",
    "WORK_AGENT_MODEL_BASE_URL",
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
}


def execute(directory, *, ca_path="/trust/ca.crt"):
    url = os.environ["WORK_AGENT_TASK_URL"]
    token = os.environ.pop("WORK_AGENT_TASK_TOKEN")
    uid = os.environ.pop("WORK_AGENT_POD_UID")
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("invalid task endpoint")
    context = ssl.create_default_context()
    context.load_verify_locations(cafile=ca_path)
    opener = build_opener(ProxyHandler({}), NoRedirect(), HTTPSHandler(context=context))

    def post(action, body, maximum):
        request = Request(
            url + "/" + action,
            data=canonical(body),
            headers={
                "Authorization": "Bearer " + token,
                "Content-Type": "application/json",
            },
        )
        with opener.open(request, timeout=5) as response:
            encoded = response.read(maximum + 1)
        if len(encoded) > maximum:
            raise ValueError("task response too large")
        return json.loads(encoded)

    # Only a confirmed not-ready response is safe to repeat. Lost ACKs fail closed.
    for attempt in range(120):
        try:
            bootstrap = post("bootstrap", {"pod_uid": uid}, MAX_REQUEST_BYTES + 10_000)
            break
        except HTTPError as error:
            if error.code != 409:
                raise
            response = json.loads(error.read(4096))
            if response.get("error", {}).get("code") != "task_not_ready":
                raise
            if attempt == 119:
                raise
            time.sleep(0.1)
    request = validate_request(bootstrap["request"])
    environment = bootstrap["environment"]
    if set(environment) != ENVIRONMENT or any(
        not isinstance(value, str) for value in environment.values()
    ):
        raise ValueError("invalid task environment")
    if (
        environment["WORK_AGENT_MODEL_BASE_URL"]
        != (parsed.scheme + "://" + parsed.netloc + "/model/" + request["run_id"])
        or environment["DEEPSEEK_BASE_URL"] != environment["WORK_AGENT_MODEL_BASE_URL"]
    ):
        raise ValueError("invalid task model endpoint")
    os.environ.update(environment)
    os.environ["SSL_CERT_FILE"] = ca_path
    os.environ["NODE_EXTRA_CA_CERTS"] = ca_path
    directory = Path(directory).resolve()
    (directory / "request.json").write_bytes(canonical(request))
    run(directory)
    result_path = directory / "result.json"
    info = result_path.lstat()
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_nlink != 1
        or info.st_size > MAX_RESULT_BYTES
    ):
        raise ValueError("invalid result file")
    result = validate_result(json.loads(result_path.read_text("utf-8")))
    result_hash = digest(canonical(result))
    for attempt in range(3):
        try:
            receipt = post("result", {"pod_uid": uid, "result": result}, 4096)
            if receipt != {"accepted": True, "sha256": result_hash}:
                raise ValueError("invalid result receipt")
            return
        except (URLError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(0.1)


if __name__ == "__main__":
    try:
        execute(Path(sys.argv[1]))
    except Exception:
        sys.exit(1)
