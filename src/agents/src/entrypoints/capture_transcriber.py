"""Start the capture transcriber worker."""

from capture.worker import run_worker

if __name__ == "__main__":
    raise SystemExit(run_worker())
