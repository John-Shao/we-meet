"""Explicit locked-desktop denial probe. Does not lock/unlock or inject input.

Run only when Windows is already locked. A changed/unlocked environment fails
the precondition rather than being reported as a successful locked-state test.
"""
import json
import os
from pathlib import Path
import struct
import subprocess
import unittest

EXE = Path(__file__).resolve().parents[2] / "dist/remote-input/we-meet-remote-input.exe"


class LockedSessionTest(unittest.TestCase):
    def test_locked_desktop_never_advertises_ready_or_accepts_arm(self):
        probe = subprocess.run(
            [str(EXE), "--session-state"], capture_output=True, check=True,
            text=True, timeout=5, creationflags=subprocess.CREATE_NO_WINDOW,
        )
        state = json.loads(probe.stdout)
        self.assertEqual(state["state"], "locked", "This test requires an already locked Windows session")
        self.assertFalse(state["defaultDesktop"])
        # Arm is deliberately unapproved. No keyboard/mouse packets are sent.
        result = subprocess.run(
            [str(EXE), "--parent", str(os.getpid())],
            input=struct.pack("<II", 136, 2) + bytes(136), capture_output=True,
            timeout=6, creationflags=subprocess.CREATE_NO_WINDOW,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        events = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertFalse(next(e for e in events if e["event"] == "hello")["ready"])
        self.assertFalse(any(e["event"] in ("armed", "inputAck", "consentShown") for e in events))
        self.assertTrue(any(e["event"] == "closed" and e["reason"] == "arm_denied" for e in events))
        self.assertEqual(next(e for e in events if e["event"] == "guardianClosed")["cleanup"], 1)


if __name__ == "__main__":
    unittest.main()
