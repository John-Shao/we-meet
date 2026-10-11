"""Owned MinIO initialization and read-only evidence of a real public upload.

Source rows, transcription, dispatch, queries and suggestions must all be made by
the application. Only synthetic accounts/contact data and storage are fixtures.
"""

import os
import threading
import time
from urllib.parse import quote

from voiceprint_rtc_identity_probe import IdentityFixture, require


class ImportFixture(IdentityFixture):
    def __init__(self, actor, contact_actor):
        from django.conf import settings  # noqa: PLC0415

        from core import models  # noqa: PLC0415
        from core.services.capture_storage import audio_storage  # noqa: PLC0415
        from core.services.voiceprint_source_storage import (  # noqa: PLC0415
            from_storage,
        )

        require(
            os.environ.get("VOICEPRINT_SYNTHETIC_IMPORT") == "1"
            and os.environ.get("VOICEPRINT_SYNTHETIC_PROBE") == "1"
            and os.environ.get("VOICEPRINT_SYNTHETIC_IDENTITY") == "1"
            and settings.MEETING_VOICEPRINT_MATCHING_ENABLED
            and settings.DATABASES["default"]["NAME"] == "voiceprint_rtc_fixture"
            and settings.MEETING_VOICEPRINT_JOURNAL_REQUIRED
            and settings.MEETING_FILE_ASR_ENABLED
            and settings.QWEN_FILE_ASR_BASE_URL
            == "https://filetrans.aliyuncs.com/api/v1",
            "import_scope",
        )
        self.actor, self.record, self.speaker = actor, None, None
        self.lock = threading.Lock()
        self.observations = {"heads": 0, "gets": 0}
        self.storage = audio_storage()
        configuration = from_storage(self.storage).validate()
        self.storage_configuration = configuration
        require(
            configuration.endpoint == "http://127.0.0.1:9000"
            and configuration.bucket == "voiceprint-rtc-fixture",
            "import_storage",
        )
        client = self.storage.connection.meta.client
        deadline = time.monotonic() + 30
        while True:
            try:
                client.create_bucket(Bucket=configuration.bucket)
                client.put_bucket_versioning(
                    Bucket=configuration.bucket,
                    VersioningConfiguration={"Status": "Enabled"},
                )
                break
            except Exception:  # noqa: BLE001 -- Only an empty owned MinIO's startup may be retried.
                require(time.monotonic() < deadline, "minio_startup")
                time.sleep(0.2)
        first, second = sorted([actor, contact_actor], key=lambda user: user.pk)
        models.ExternalContact.objects.create(
            user_a=first, user_b=second, requested_by=actor, status="accepted"
        )
        self.web_complete = False

    def setup(self):
        from core import models  # noqa: PLC0415

        require(
            models.VoiceprintTemplate.objects.filter(
                profile__consent__user=self.actor, status="active"
            ).count()
            == 1,
            "registered_template",
        )
        require(not models.UploadedRecording.objects.exists(), "upload_not_seeded")
        return {"status": "awaiting_public_upload"}

    def evidence(self):
        from django.conf import settings  # noqa: PLC0415

        import requests  # noqa: PLC0415

        from core import models  # noqa: PLC0415

        uploads = models.UploadedRecording.objects.filter(record__owner=self.actor)
        if not uploads.exists():
            return {"upload_seen": False, "web_complete": False}
        require(uploads.count() == 1, "single_public_upload")
        upload = uploads.select_related("record").get()
        self.record = upload.record
        self.speaker = models.MeetingSpeaker.objects.filter(record=self.record).first()
        if self.speaker is None:
            return {
                "upload_seen": True,
                "web_complete": False,
                "upload_status": upload.status,
            }
        # IdentityFixture's storage counters belong to its memory object server;
        # MinIO/provider observations below replace them for this mode.
        value = super().evidence()
        with requests.get(
            "https://filetrans.aliyuncs.com/fixture-evidence",
            headers={"Authorization": "Bearer " + settings.DASHSCOPE_API_KEY},
            timeout=5,
            allow_redirects=False,
        ) as response:
            require(response.status_code == 200, "provider_evidence")
            provider = response.json()
        unsigned = (
            self.storage_configuration.endpoint
            + "/"
            + self.storage_configuration.bucket
            + "/"
            + quote(
                "/".join(
                    value
                    for value in (
                        self.storage_configuration.prefix,
                        upload.storage_name,
                    )
                    if value
                ),
                safe="/",
            )
        )
        with requests.head(unsigned, timeout=5, allow_redirects=False) as response:
            unsigned_status = response.status_code
        dispatch = models.RecordingIdentityDispatch.objects.filter(
            upload=upload
        ).first()
        receipts = list(
            models.RecordingImportInput.objects.filter(upload=upload).values_list(
                "receipt", flat=True
            )
        )
        # Only private aggregate receipts leave this observer, never URLs or keys.
        value.update(
            {
                "upload_seen": True,
                "web_complete": self.web_complete,
                "upload_status": upload.status,
                "upload_attempt": upload.attempt,
                "preflight_status": upload.identity_state,
                "dispatch_status": dispatch.status if dispatch else None,
                "dispatch_attempts": dispatch.attempts if dispatch else 0,
                "original_segments": self.record.original_segments.count(),
                "original_speakers": models.MeetingSpeaker.objects.filter(
                    record=self.record
                ).count(),
                "attribution_kind": self.speaker.attribution_kind,
                "manual_label": self.speaker.manual_label,
                "decision_actions": list(
                    self.record.identity_decisions.order_by("created_at").values_list(
                        "action", flat=True
                    )
                ),
                "versioned_prepared_inputs": sum(
                    bool(row.get("version_id")) for row in receipts
                ),
                "provider": provider,
                "unsigned_source_status": unsigned_status,
                "jobs_canceled_for_presentation": models.SpeakerIdentityJob.objects.filter(
                    record=self.record,
                    status="canceled",
                    error_code="identity_presentation_changed",
                ).count(),
            }
        )
        return value

    def complete(self):
        value = self.evidence()
        require(
            value["upload_status"] == "succeeded"
            and value["preflight_status"] == "ready"
            and value["dispatch_status"] == "submitted"
            and value["upload_attempt"] == value["dispatch_attempts"] == 1
            and value["original_segments"] == 3
            and value["original_speakers"] == 1
            and value["jobs"] == 1
            and value["attempts"] == [1]
            # Human contact/label edits cancel the completed request's old context.
            and value["jobs_succeeded"] == 0
            and value["jobs_canceled_for_presentation"] == 1
            and value["suggested"] == 1
            and value["confirmed"] == 1
            and value["support_samples"] == 3
            and value["query_temp_children"] == 0
            and value["attribution_kind"] == "custom"
            and value["manual_label"] == "Synthetic final label"
            and value["decisions"] == 5
            and value["decision_actions"]
            == [
                "confirm_suggestion",
                "select_contact",
                "set_label",
                "set_label",
                "set_label",
            ]
            and value["provider"]["submissions"] == 1
            and value["provider"]["signed_audio_reads"] == 1
            and value["provider"]["polls"] == value["provider"]["result_reads"] == 1
            and value["versioned_prepared_inputs"] == 1,
            # Keep the synthetic source private even in the test harness.
            "public_import_and_web_complete",
        )
        require(value["unsigned_source_status"] == 403, "unsigned_storage_denied")
        self.web_complete = True
        return {"status": "passed"}

    def close(self):
        pass
