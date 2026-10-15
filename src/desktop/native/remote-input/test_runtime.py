"""Black-box native protocol and guardian tests (Windows only).

Default mode never injects keyboard/mouse input. --inject additionally creates
an isolated foreground test window and verifies a held Ctrl is released after
killing the worker. It never types text or issues application commands.
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import queue
import struct
import subprocess
import threading
import time
import unittest
import uuid

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

EXE = Path(__file__).resolve().parents[2] / "dist/remote-input/we-meet-remote-input.exe"
INJECT = False


class Client:
    def __init__(self):
        self.process = subprocess.Popen([str(EXE), "--parent", str(os.getpid())], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW)
        self.events = queue.Queue()
        self.lock = threading.Lock()
        self.done = threading.Event()
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.session, self.share, self.generation = (uuid.uuid4().bytes for _ in range(3))
        self.epoch = 1
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        self.hello = self.wait("hello")
        if not self.hello["ready"]:
            self.close()
            raise RuntimeError("Native hooks/hotkey unavailable: close other runtime tests first")
        self.pulse = threading.Thread(target=self._pulse, daemon=True)
        self.pulse.start()
        self.send(1)
        self.display = self.wait("displays")["displays"][0]

    def _read(self):
        for line in self.process.stdout:
            self.events.put(json.loads(line))

    def _pulse(self):
        while not self.done.wait(.2):
            try:
                self.send(4)
            except (BrokenPipeError, OSError, ValueError):
                return

    def send(self, command, data=b""):
        with self.lock:
            self.process.stdin.write(struct.pack("<II", len(data), command) + data)
            self.process.stdin.flush()

    def wait(self, event, timeout=4):
        deadline = time.monotonic() + timeout
        seen = []
        while time.monotonic() < deadline:
            item = self.events.get(timeout=max(.01, deadline-time.monotonic()))
            if item["event"] == event:
                return item
            seen.append(item)
        raise AssertionError((event, seen))

    def arm(self, lease=15000):
        p = self.key.public_key().public_numbers()
        d = self.display
        body = self.session + self.share + self.generation + struct.pack("<IiiiiI", self.epoch,
            d["left"], d["top"], d["width"], d["height"], lease) + p.x.to_bytes(32,"big") + p.y.to_bytes(32,"big")
        self.send(2, body)
        self.challenge = bytes.fromhex(self.wait("challenge")["nonce"])
        self.wait("armed")

    def event(self, seq=1, kind=7, action=0, code=0, challenge=None, generation=None):
        body = bytearray(640)
        struct.pack_into("<II", body, 0, 0x31435257, 1)
        body[8:24], body[24:40], body[40:56] = self.session, self.share, generation or self.generation
        struct.pack_into("<IHHQ", body, 56, self.epoch, kind, action, seq)
        body[72:88] = challenge or self.challenge
        struct.pack_into("<II", body, 88, code, 0)
        struct.pack_into("<dd", body, 96, .5, .5)
        signature = self.key.sign(bytes(body), ec.ECDSA(hashes.SHA256()))
        r, s = decode_dss_signature(signature)
        return bytes(body) + r.to_bytes(32,"big") + s.to_bytes(32,"big")

    def close(self):
        self.done.set()
        if self.process.poll() is None:
            try:
                self.send(5)
                self.process.stdin.close()
                self.process.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                self.process.kill()
                self.process.wait(timeout=3)
        self.reader.join(timeout=1)
        for pipe in (self.process.stdout,self.process.stderr):
            pipe.close()
        if not self.process.stdin.closed:
            try:
                self.process.stdin.close()
            except OSError:
                pass
        # Let the guardian observe worker exit and relinquish inherited handles.
        time.sleep(.1)


class NativeRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.c = Client()

    def tearDown(self):
        self.c.close()

    def test_valid_signed_heartbeat_and_replay(self):
        self.c.arm()
        self.c.send(7, self.c.event())
        self.assertEqual(self.c.wait("heartbeatAck")["seq"], 1)
        self.c.send(7, self.c.event())
        self.c.send(7, self.c.event(seq=2))
        self.assertEqual(self.c.wait("heartbeatAck")["seq"], 2)

    def test_invalid_signature_closes_before_execution(self):
        self.c.arm()
        event = bytearray(self.c.event(kind=4, action=1, code=0x1d))
        event[-1] ^= 1
        self.c.send(7, bytes(event))
        self.assertEqual(self.c.wait("closed")["reason"], "invalid_signature_or_binding")

    def test_foreign_generation_closes(self):
        self.c.arm()
        self.c.send(7, self.c.event(generation=uuid.uuid4().bytes))
        self.assertEqual(self.c.wait("closed")["reason"], "invalid_signature_or_binding")

    def test_unknown_challenge_closes(self):
        self.c.arm()
        self.c.send(7, self.c.event(challenge=bytes(16)))
        self.assertEqual(self.c.wait("closed")["reason"], "expired_input")

    def test_input_gap_does_not_inject(self):
        self.c.arm()
        self.c.send(7, self.c.event(seq=2, kind=4, action=1, code=0x1d))
        self.assertEqual(self.c.wait("closed")["reason"], "input_gap")

    def test_lease_expires_even_with_parent_alive(self):
        self.c.arm(lease=200)
        self.assertEqual(self.c.wait("closed")["reason"], "lease_expired")

    def test_controller_watchdog_independent_of_parent(self):
        self.c.arm()
        self.assertEqual(self.c.wait("closed")["reason"], "controller_timeout")

    def test_oversized_frame_exits_without_input(self):
        with self.c.lock:
            self.c.process.stdin.write(struct.pack("<II",4097,7))
            self.c.process.stdin.flush()
        self.c.process.wait(timeout=3)
        self.assertNotEqual(self.c.process.returncode, 0)

    def test_guardian_death_closes_worker_gate(self):
        self.c.arm()
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(1, False, self.c.hello["guardianPid"])
        self.assertTrue(handle)
        self.assertTrue(kernel.TerminateProcess(handle, 99))
        kernel.CloseHandle(handle)
        self.assertEqual(self.c.wait("closed")["reason"], "guardian_lost")

    def test_parent_watchdog_terminates_worker(self):
        self.c.arm()
        self.c.done.set()
        self.c.process.wait(timeout=4)
        self.assertNotEqual(self.c.process.returncode, 0)

    def test_guardian_releases_held_key_after_worker_kill(self):
        self._assert_guardian_release(kind=4, code=0x1d, virtual_key=0x11)

    def test_guardian_releases_drag_after_worker_kill(self):
        self._assert_guardian_release(kind=2, code=0, virtual_key=0x01)

    def _assert_guardian_release(self, kind, code, virtual_key):
        if not INJECT:
            self.skipTest("Use --inject for an isolated foreground window and real input")
        user = ctypes.WinDLL("user32", use_last_error=True)
        user.CreateWindowExW.restype = wintypes.HWND
        user.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
            ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_int,wintypes.HWND,wintypes.HMENU,wintypes.HINSTANCE,wintypes.LPVOID]
        user.SetForegroundWindow.argtypes = [wintypes.HWND]
        user.DestroyWindow.argtypes = [wintypes.HWND]
        user.GetForegroundWindow.restype = wintypes.HWND
        display=self.c.display
        x=display["left"]+display["width"]//2-240
        y=display["top"]+display["height"]//2-90
        window = user.CreateWindowExW(0,"STATIC","We-Meet input safety test",0x10CF0000,x,y,480,180,None,None,None,None)
        self.assertTrue(window)
        try:
            user.SetForegroundWindow(window)
            self.assertEqual(user.GetForegroundWindow(), window)
            self.assertFalse(user.GetAsyncKeyState(virtual_key) & 0x8000, "Test key already held locally")
            self.c.arm()
            self.c.send(7,self.c.event(kind=kind,action=1,code=code))
            self.assertEqual(self.c.wait("inputAck")["seq"],1)
            deadline=time.monotonic()+1
            while not (user.GetAsyncKeyState(virtual_key)&0x8000) and time.monotonic()<deadline:
                time.sleep(.01)
            self.assertTrue(user.GetAsyncKeyState(virtual_key)&0x8000,"Native down did not take effect")
            self.c.process.kill()
            self.c.process.wait(timeout=2)
            deadline=time.monotonic()+3
            while user.GetAsyncKeyState(virtual_key)&0x8000 and time.monotonic()<deadline:
                time.sleep(.01)
            self.assertFalse(user.GetAsyncKeyState(virtual_key)&0x8000,"Guardian failed to release input")
            self.assertEqual(self.c.wait("guardianClosed")["cleanup"],1)
        finally:
            user.DestroyWindow(window)


if __name__ == "__main__":
    user=ctypes.WinDLL("user32")
    user.SetProcessDpiAwarenessContext.argtypes=[wintypes.HANDLE]
    user.SetProcessDpiAwarenessContext(wintypes.HANDLE(-4))
    parser = argparse.ArgumentParser()
    parser.add_argument("--inject",action="store_true")
    args, remaining = parser.parse_known_args()
    INJECT = args.inject
    unittest.main(argv=[__file__,*remaining])
