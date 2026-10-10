"""Small published-generation pointers for owner state; no media or proof loading."""

from core import models


def current_diarization_id(capture):
    return (
        models.CaptureDiarizationJob.objects.filter(
            pk=capture.active_diarization_id,
            capture_id=capture.pk,
            source_transcription_id=capture.active_transcription_id,
            source_transcription__status="succeeded",
            status="succeeded",
            phase="completed",
            published_count__gte=1,
        )
        .values_list("pk", flat=True)
        .first()
    )
