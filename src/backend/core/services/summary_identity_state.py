"""Live identity metadata over frozen AI and human summary inputs."""

from dataclasses import dataclass

from core.services.meeting_records import RecordConflict
from core.services.meeting_summary_versions import source_payload


@dataclass(frozen=True)
class SummaryIdentityState:
    latest_revision: int
    current_names: dict[str, str]
    fingerprint: str | None

    def updated(self, snapshot):
        return bool(
            self.latest_revision > snapshot.revision
            or any(
                row["segment_id"] in self.current_names
                and row.get("speaker_name", "") != self.current_names[row["segment_id"]]
                for row in snapshot.segments
            )
        )


def read_state(record):
    """One bounded source read and audit lookup per response, never per history row."""
    try:
        source, fingerprint = source_payload(record, require_ended=False)
        names = {row["segment_id"]: row.get("speaker_name", "") for row in source}
    except RecordConflict:
        names, fingerprint = {}, None
    # A rejected suggestion advances revision without changing final attribution.
    revision = (
        record.identity_decisions.exclude(action="reject_suggestion")
        .order_by("-record_revision")
        .values_list("record_revision", flat=True)
        .first()
    ) or 0
    return SummaryIdentityState(revision, names, fingerprint)
