"""Stdlib-only Linux containment probe, runnable in a read-only offline container."""

import ctypes
import os
import subprocess
import sys
import threading
import time

from voiceprint.process_lifetime import contain_parent_exit


def main():
    assert sys.platform.startswith("linux")
    try:
        contain_parent_exit(os.getppid() + 999999)
    except OSError:
        pass
    else:
        raise AssertionError("Wrong parent was accepted")
    # Adopt/reap the killed grandchild instead of leaving container PID 1 zombies.
    libc = ctypes.CDLL(None)
    assert libc.prctl(36, 1, 0, 0, 0) == 0  # PR_SET_CHILD_SUBREAPER.
    child_script = """
import os, sys, time
from voiceprint.process_lifetime import contain_parent_exit
contain_parent_exit(int(sys.argv[1]))
print(os.getpid(), flush=True)
time.sleep(120)
"""
    parent_script = """
import os, subprocess, sys, time
subprocess.Popen([sys.executable, "-c", sys.argv[1], str(os.getpid())])
time.sleep(120)
"""
    parent = subprocess.Popen(  # noqa: S603 -- Fixed trusted local probe code.
        [sys.executable, "-c", parent_script, child_script], stdout=subprocess.PIPE
    )
    timeout = threading.Timer(10, parent.kill)
    timeout.start()
    try:
        child_pid = int(parent.stdout.readline(32))
        parent.kill()
        parent.wait(timeout=3)
        deadline = time.monotonic() + 5
        while True:
            pid, status = os.waitpid(child_pid, os.WNOHANG)
            if pid == child_pid:
                assert os.WIFSIGNALED(status) and os.WTERMSIG(status) == 9
                break
            assert time.monotonic() < deadline, "Orphan child survived"
            time.sleep(0.05)
        print("Linux parent mismatch and SIGKILL/reap probes passed")
    finally:
        timeout.cancel()
        timeout.join()
        if parent.poll() is None:
            parent.kill()
        parent.wait(timeout=3)
        parent.stdout.close()


if __name__ == "__main__":
    main()
