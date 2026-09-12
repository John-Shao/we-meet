"""Bounded source counters for a delivery manifest; never an audio coverage claim."""

MAX_OBSERVATIONS = 100000


class ASRObserver:
    """Aggregate idempotent per-stream/task observations without storing source text."""

    def __init__(self):
        """Hold only source identifiers and non-content transport counters."""
        self.model = None
        self.streams = set()
        self.ended_streams = set()
        self.tasks = {}
        self.errors = set()

    def observe(self, event):
        """Reject conflicting task receipts and bound long-running process memory."""
        kind = event["type"]
        if kind == "stream_started":
            if len(self.streams) >= MAX_OBSERVATIONS:
                self.errors.add("asr_observation_limit")
                return
            if self.model is not None and self.model != event["model"]:
                self.errors.add("asr_observation_conflict")
                return
            self.model = event["model"]
            self.streams.add(event["stream_id"])
        elif kind == "stream_finished":
            if event["stream_id"] not in self.streams:
                self.errors.add("asr_observation_conflict")
                return
            self.ended_streams.add(event["stream_id"])
        elif kind == "task":
            if event["stream_id"] not in self.streams:
                self.errors.add("asr_observation_conflict")
                return
            task_id = event["task_id"]
            if task_id in self.tasks:
                if self.tasks[task_id] != event:
                    self.errors.add("asr_observation_conflict")
                return
            if len(self.tasks) >= MAX_OBSERVATIONS:
                self.errors.add("asr_observation_limit")
                return
            self.tasks[task_id] = event.copy()
            if not event["finished"]:
                self.errors.add("asr_stream_failed")
        elif kind == "failure":
            self.errors.add(
                event["code"]
                if event["code"] == "asr_buffer_exceeded"
                else "asr_stream_failed"
            )

    def manifest(self, *, pipeline_failed=False):
        """Snapshot observations; legacy sources retain their original wire format."""
        if self.model is None:
            return {}
        errors = self.errors | ({"pipeline_incomplete"} if pipeline_failed else set())
        tasks = list(self.tasks.values())
        return {
            "schema_version": 1,
            "provider": "qwen",
            "model": self.model,
            "streams_started": len(self.streams),
            "streams_finished": len(self.ended_streams),
            "tasks_started": len(tasks),
            "tasks_finished": sum(task["finished"] for task in tasks),
            "input_samples": sum(task["input_samples"] for task in tasks),
            "final_sentences": sum(task["final_sentences"] for task in tasks),
            "billed_seconds": float(sum(task["billed_seconds"] for task in tasks)),
            "errors": sorted(errors),
        }
