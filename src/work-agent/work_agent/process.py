"""Hard deadline/cancellation is enforced outside the upstream runtime."""

import os
import signal
import subprocess


def spawn_options():
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {"start_new_session": True}


def kill_tree(process):
    if os.name == "nt":
        if process.poll() is not None:
            return
        # Taskkill receives a numeric PID, never interpolated shell commands.
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
        )
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)
