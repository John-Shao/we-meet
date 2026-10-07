"""One authorized real-account task; OTP/tokens stay in process/encrypted app profiles."""

import base64
import getpass
import hashlib
import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

root = Path(__file__).resolve().parents[3]
assert os.environ.get("WORK_ACCOUNT_COHORT") == "1", (
    "Reviewed production account cohort opt-in required"
)
out = Path(os.environ["WORK_CROSS_DEVICE_OUTPUT"]).resolve()
assert out.is_relative_to((root / ".work-acceptance").resolve()), (
    "Use private ignored acceptance output"
)
out.mkdir(parents=True, exist_ok=True)
assert not (out / "started.json").exists(), "One task only; do not rerun"
adb = Path("D:/ProgramData/AndroidSDK/platform-tools/adb.exe")
android = root.parent / "we-meet-android"
serial = "emulator-5556"
base = "https://meet.we-meet.online"
phone = getpass.getpass("Authorized demo phone (memory only): ")
otp = getpass.getpass("Demo OTP (memory only): ")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


http = urllib.request.build_opener(NoRedirect())
token = None
session = None
claimed = set()
children = []
server = None
installed = []
reverse_owned = False
workspace_id = None


def api(path, body=None):
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(
        base + path,
        headers=headers,
        data=None if body is None else json.dumps(body).encode(),
    )
    try:
        with http.open(req, timeout=20) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, {}


def device(*args, timeout=30):
    return subprocess.run(
        [str(adb), "-s", serial, *args],
        capture_output=True,
        check=True,
        timeout=timeout,
    ).stdout.decode("utf8")


def wait_file(name, deadline=180):
    limit = time.monotonic() + deadline
    while not (out / name).exists():
        if time.monotonic() > limit:
            raise RuntimeError("checkpoint_timeout:" + name)
        if any(child.poll() not in (None, 0) for child in children):
            raise RuntimeError("client_failed")
        time.sleep(0.5)
    return json.loads((out / name).read_text()) if name.endswith(".json") else None


class Broker(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if (
            self.path not in ("/android", "/desktop")
            or self.path in claimed
            or session is None
        ):
            self.send_response(403)
            self.end_headers()
            return
        claimed.add(self.path)
        value = (
            {"access": session["access"], "workspace_id": workspace_id}
            if self.path == "/android"
            else session
        )
        data = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


try:
    assert (
        device("shell", "pm", "list", "packages", "com.we.meet.fixturecohort").strip()
        == ""
    )
    assert "tcp:48762" not in device("reverse", "--list")
    metadata = json.loads(
        (android / "app/build/outputs/apk/debug/output-metadata.json").read_text()
    )
    assert metadata["applicationId"] == "com.we.meet.fixturecohort"
    for suffix, package in [
        ("app/build/outputs/apk/debug/app-debug.apk", "com.we.meet.fixturecohort"),
        (
            "app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
            "com.we.meet.fixturecohort.test",
        ),
    ]:
        device("install", str(android / suffix), timeout=90)
        installed.append(package)
    device("reverse", "tcp:48762", "tcp:48762")
    reverse_owned = True
    server = ThreadingHTTPServer(("127.0.0.1", 48762), Broker)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    (out / "clients-prepared.json").write_text(
        json.dumps(
            {
                "fixture_package": "com.we.meet.fixturecohort",
                "production_api": True,
                "provider_calls": 0,
            }
        )
    )
    print("Clients prepared; awaiting production open verification", flush=True)
    wait_file("start-clients", 1800)
    assert api("/api/mobile/auth/send-otp/", {"phone": phone})[0] == 200
    status, tokens = api("/api/mobile/auth/verify-otp/", {"phone": phone, "otp": otp})
    otp = None
    assert status == 200 and tokens.get("access_token")
    token = tokens["access_token"]
    status, user = api("/api/v1.0/users/me/")
    assert (
        status == 200
        and hashlib.sha256(str(user["id"]).encode()).hexdigest()
        == "ada9bbbb960ea8fdc825a05b31265b5b9c9eab7334d677244ea555af491dc7e5"
    )
    status, caps = api("/api/v1.0/work/capabilities/")
    assert (
        status == 200
        and caps["agent_token_budget"] == 20000
        and caps["local_agent_enabled"]
        and caps["remote_agent_enabled"]
        and not caps["agent_enabled"]
        and not caps["review_enabled"]
    )
    claims = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "===").decode())
    session = {
        "access": token,
        "refresh": tokens["refresh_token"],
        "subject": claims["sub"],
        "expiresAt": claims["exp"] * 1000,
    }
    tokens = None
    claims = None
    (out / "started.json").write_text(
        json.dumps(
            {
                "real_account_verified": True,
                "one_task_limit": 1,
                "caps_verified": True,
                "plaintext_credentials_persisted": False,
            }
        )
    )
    env = {
        **os.environ,
        "WORK_COORDINATION_URL": base,
        "WORK_ACCOUNT_COHORT": "1",
        "WORK_LOCAL_ALLOW_PAID": "1",
        "WE_MEET_LOCAL_KEY_FILE": os.environ["WE_MEET_LOCAL_KEY_FILE"],
        "WORK_CROSS_DEVICE_OUTPUT": str(out),
    }
    desktoplog = (out / "desktop-log.txt").open("w")
    desktop = subprocess.Popen(
        ["node", str(root / "src/desktop/scripts/account-cohort-acceptance.cjs")],
        cwd=root,
        env=env,
        stdout=desktoplog,
        stderr=subprocess.STDOUT,
    )
    children.append(desktop)
    ready = wait_file("desktop-ready.json", 180)
    workspace_id = ready["workspace_id"]
    print(
        "Desktop workspace ready; dispatching exactly one task from Android UI",
        flush=True,
    )
    androidlog = (out / "android-instrumentation.txt").open("w")
    androidprocess = subprocess.Popen(
        [
            str(adb),
            "-s",
            serial,
            "shell",
            "am",
            "instrument",
            "-w",
            "-e",
            "class",
            "com.we.meet.ui.work.WorkAccountCohortIntegrationTest",
            "-e",
            "workAccountCohort",
            "1",
            "com.we.meet.fixturecohort.test/com.we.meet.ui.records.IsolatedRecordsRunner",
        ],
        stdout=androidlog,
        stderr=subprocess.STDOUT,
    )
    children.append(androidprocess)
    receipt = wait_file("desktop-receipt.json", 600)
    if androidprocess.wait(timeout=90) != 0:
        raise RuntimeError("android_process_failed")
    androidlog.close()
    assert "OK (1 test)" in (out / "android-instrumentation.txt").read_text()
    for source, destination in [
        ("receipt.json", "android-receipt.json"),
        ("result.png", "android-result.png"),
    ]:
        device(
            "pull",
            "/sdcard/Android/data/com.we.meet.fixturecohort/files/work-cohort/"
            + source,
            str(out / destination),
        )
    a = json.loads((out / "android-receipt.json").read_text())
    assert a["passed"] and a["run_id"] == receipt["run_id"]
    status, files = api("/api/v1.0/work/runs/" + receipt["run_id"] + "/files/")
    assert (
        status == 200
        and len(files) == 1
        and files[0]["sha256"]
        == hashlib.sha256(b"cross-device-marker-20261007\n").hexdigest()
    )
    status, alias = api(
        "/api/v1.0/work/local/workspaces/",
        {
            "device_id": receipt["device_id"],
            "workspace_id": receipt["workspace_id"],
            "label": "Cohort workspace",
            "model": receipt["deployment"]["model"],
            "enabled": False,
        },
    )
    assert status == 200 and alias["workspace"]["enabled"] is False
    status, canceled = api("/api/v1.0/work/runs/" + receipt["run_id"] + "/cancel/", {})
    assert status == 200 and canceled["status"] == "succeeded"
    (out / "task-verified.json").write_text(
        json.dumps(
            {
                "passed": True,
                "one_task": True,
                "mobile_desktop_same_run": True,
                "sha256_verified": True,
                "completed_cancel_idempotent": True,
                "running_cancel_revocation": "covered offline; no second production task",
            }
        )
    )
    print("One production task verified; awaiting cohort closure", flush=True)
    wait_file("production-closed", 1800)
    status, caps = api("/api/v1.0/work/capabilities/")
    assert status == 200 and all(
        not caps[k]
        for k in (
            "local_agent_enabled",
            "remote_agent_enabled",
            "agent_enabled",
            "review_enabled",
        )
    )
    status, _ = api("/api/v1.0/work/local/remote-tasks/", {})
    assert status == 503
    status, _ = api(
        "/api/v1.0/work/local/runs/" + receipt["run_id"] + "/claim/",
        {"device_id": receipt["device_id"]},
    )
    assert status == 409
    (out / "close-client").touch()
    assert desktop.wait(timeout=45) == 0
    (out / "final-receipt.json").write_text(
        json.dumps(
            {
                "passed": True,
                "closed_capabilities": True,
                "new_dispatch_rejected": 503,
                "reclaim_rejected": 409,
                "clients_logged_out": True,
                "one_synthetic_task": 1,
            }
        )
    )
    print("Production cohort closed and client cleanup complete", flush=True)
except Exception as error:  # noqa: BLE001 - redact credential-bearing HTTP failures
    (out / "failure.json").write_text(
        json.dumps(
            {
                "failed": True,
                "error_type": type(error).__name__,
                "reason": str(error)
                if type(error) is RuntimeError
                else "acceptance_assertion_failed",
                "automatic_task_retry": False,
            }
        )
    )
    print("Acceptance stopped; close production cohort before recovery", flush=True)
    raise SystemExit(1)
finally:
    otp = None
    token = None
    session = None
    if server:
        server.shutdown()
        server.server_close()
    (out / "abort-client").touch()
    for child in children:
        if child.poll() is None:
            try:
                child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                if os.name == "nt":
                    subprocess.run(
                        ["taskkill", "/PID", str(child.pid), "/T", "/F"],
                        capture_output=True,
                        timeout=30,
                        check=False,
                    )
                else:
                    child.terminate()
    try:
        if reverse_owned:
            device("reverse", "--remove", "tcp:48762")
    except (OSError, subprocess.SubprocessError):
        print("Owned ADB reverse cleanup failed", flush=True)
    for package in reversed(installed):
        try:
            device("uninstall", package)
        except (OSError, subprocess.SubprocessError):
            print("Owned Android fixture cleanup failed", flush=True)
