"""Start the capture live transcriber worker."""

from capture.live import LiveCaptureAttempt
from capture.worker import run_worker

if __name__ == "__main__":
    raise SystemExit(run_worker(live=True, attempt_type=LiveCaptureAttempt))
