"""Exercise only the freshly launched diagnostic's labelled test window.

No meeting, production consent surface, Arm, or SendInput is involved.
"""
import json
from pathlib import Path
import queue
import subprocess
import sys
import threading

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "native/remote-input"))
from consent_test_driver import approve, window_for, user, text  # noqa: E402


def run(allow):
    exe = ROOT / "test-results/native-consent-diagnostic/WeMeet-Consent-Diagnostic.exe"
    child = subprocess.Popen([str(exe), "--no-wait"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, encoding="utf-8-sig", creationflags=subprocess.CREATE_NO_WINDOW)
    events = queue.Queue()

    def read():
        for line in child.stdout:
            if line.startswith("{"):
                events.put(json.loads(line))
        events.put(None)

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    observed, helper = [], None
    try:
        while True:
            item = events.get(timeout=12)
            if item is None:
                break
            observed.append(item)
            data = item["data"]
            if item["kind"] == "native" and data["event"] == "hello":
                assert data["ready"], "Unlock Windows before the native diagnostic test"
                helper = data["pid"]
            if item["kind"] == "native" and data["event"] == "consentShown":
                assert helper is not None
                if allow:
                    approve(helper)
                else:
                    button = user.GetDlgItem(window_for(helper), 1)
                    assert text(button) == "拒绝"
                    user.SendMessageW(button, 0xF5, 0, 0)
        child.wait(timeout=3)
        result = next(row["data"] for row in observed if row["kind"] == "result")
        assert result["allowed"] is allow, observed
        assert result["cleanup"] == 1 and not result["failed"], observed
        assert result["inputCommandsSent"] == 0 and result["workerExitCode"] == 0, observed
        assert not any(row["kind"] == "native" and row["data"]["event"] in ("armed", "inputAck") for row in observed)
        assert child.returncode == (0 if allow else 1), observed
        print(json.dumps({"case": "allow" if allow else "deny", "result": result}))
    finally:
        if child.poll() is None:
            child.kill()  # Guardian remains responsible for its own child cleanup.
            child.wait(timeout=3)
        reader.join(timeout=3)
        child.stdout.close()
        child.stderr.close()


if __name__ == "__main__":
    run(True)
    run(False)
