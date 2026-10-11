"""Per-pod expiry cleanup sharing the worker's UID and bounded private tmp volume."""

import json
import signal
import threading

from core.services.voiceprint_media_process import MediaError
from core.services.voiceprint_query_files import purge


def sweep():
    try:
        return {"status": "ready", **purge(limit=100)}
    except (OSError, MediaError):
        # Filesystem errors must never disclose paths or private contents.
        return {"status": "unavailable"}


def main():
    stopped = threading.Event()

    def stop(_signal, _frame):
        stopped.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while not stopped.is_set():
        print(json.dumps(sweep(), sort_keys=True), flush=True)  # noqa: T201 -- Fixed aggregate operational output only.
        stopped.wait(30)


if __name__ == "__main__":
    main()
