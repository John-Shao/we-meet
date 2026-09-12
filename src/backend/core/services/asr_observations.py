"""Validate bounded agent observations, never infer full meeting audio coverage."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from core.services.meeting_records import RecordConflict


class ASRObservation(BaseModel):
    """Counters contain no participant names, source text or credentials."""

    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    schema_version: Literal[1]
    provider: Literal["qwen"]
    model: str = Field(pattern=r"^[A-Za-z0-9._-]{1,128}$")
    streams_started: int = Field(ge=1, le=100000)
    streams_finished: int = Field(ge=0, le=100000)
    tasks_started: int = Field(ge=0, le=100000)
    tasks_finished: int = Field(ge=0, le=100000)
    input_samples: int = Field(ge=0, le=100000000000)
    final_sentences: int = Field(ge=0, le=10000000)
    billed_seconds: float = Field(ge=0, le=10000000)
    errors: list[
        Literal[
            "asr_stream_failed",
            "asr_buffer_exceeded",
            "pipeline_incomplete",
            "asr_observation_limit",
            "asr_observation_conflict",
        ]
    ] = Field(max_length=5)

    @model_validator(mode="after")
    def check_counters(self):
        """Completion counts cannot exceed their corresponding started counts."""
        if (
            self.streams_finished > self.streams_started
            or self.tasks_finished > self.tasks_started
        ):
            raise ValueError("Inconsistent observation counts")
        if not self.tasks_started and (
            self.input_samples or self.final_sentences or self.billed_seconds
        ):
            raise ValueError("Audio observations require a provider task")
        if len(set(self.errors)) != len(self.errors):
            raise ValueError("Duplicate observation error codes")
        return self


def validate_observation(value):
    """Legacy empty reports remain byte-for-byte compatible with old snapshots."""
    if value == {}:
        return {}
    try:
        return ASRObservation.model_validate(value).model_dump()
    except ValidationError:
        raise RecordConflict("Invalid ASR observation manifest.") from None


def observation_status(report):
    """Only summarize the reported tasks; this is not an audio coverage verdict."""
    if not report:
        return "unverified"
    if (
        report["errors"]
        or report["streams_started"] != report["streams_finished"]
        or report["tasks_started"] != report["tasks_finished"]
    ):
        return "incomplete"
    return "finished" if report["tasks_started"] else "no_audio_observed"


def snapshot_asr_status(delivery):
    """Mixed legacy/unreported sources can never become an all-finished verdict."""
    statuses = [
        observation_status(stream.get("source_report"))
        for stream in delivery.get("streams", [])
    ]
    statuses.extend(
        item.get("asr_status", "unverified")
        for item in delivery.get("capture_transcriptions", [])
    )
    if "incomplete" in statuses:
        return "incomplete"
    if not statuses or "unverified" in statuses:
        return "unverified"
    return "finished" if "finished" in statuses else "no_audio_observed"
