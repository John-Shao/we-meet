"""Project resolved meeting materials; report unresolved rows without guessing."""

import json

from django.core.management.base import BaseCommand, CommandError
from django.db.models import F, Q

from core import models
from core.services.meeting_records import (
    RecordConflict,
    ensure_online_record,
    sessions_with_materials,
)


class Command(BaseCommand):
    """Dry-run by default; explicit --apply creates idempotent record rows."""

    help = "Inspect meeting-record backfill; --apply writes only new record identities."

    def add_arguments(self, parser):
        """Require an explicit switch for writes."""
        parser.add_argument("--apply", action="store_true")
        parser.add_argument(
            "--strict",
            action="store_true",
            help="Fail if any unresolved migration differences remain.",
        )
        parser.add_argument(
            "--sample-limit",
            type=int,
            default=20,
            help="Maximum UUID samples per category (0-100); no content is exported.",
        )

    def handle(self, *args, **options):
        """Keep old artifacts intact, including their unresolved session fields."""
        candidates = sessions_with_materials().order_by("id")
        limit = options["sample_limit"]
        if not 0 <= limit <= 100:
            raise CommandError("sample-limit must be between 0 and 100.")
        report = {
            "apply": options["apply"],
            "eligible_sessions": candidates.count(),
            "existing_records": candidates.filter(record__isnull=False).count(),
            "created": 0,
            "apply_conflicts": 0,
        }
        if options["apply"]:
            for session in candidates.iterator(chunk_size=200):
                try:
                    _, created = ensure_online_record(session)
                    report["created"] += int(created)
                except RecordConflict:
                    report["apply_conflicts"] += 1
        self._audit(report, candidates, limit)
        self.stdout.write(json.dumps(report, sort_keys=True))
        if options["apply"] and (report["conflicts"] or report["apply_conflicts"]):
            raise CommandError(
                "Record provenance conflicts require review; see the report."
            )
        if options["strict"] and not report["ready"]:
            raise CommandError(
                "Meeting-record migration differences remain; see the report."
            )

    def _audit(self, report, candidates, limit):
        """Inspect both dry-run and post-write state without exporting meeting text."""
        matches = Q(meeting_session_id=F("source_session_id")) & (
            Q(organization_id=F("meeting_session__room__organization_id"))
            | Q(
                organization__isnull=True,
                meeting_session__room__organization__isnull=True,
            )
        )
        conflicts = models.MeetingRecord.objects.filter(
            meeting_session__isnull=False
        ).exclude(matches)
        orphans = models.MeetingRecord.objects.filter(
            source_type="meeting", meeting_session__isnull=True
        )
        missing = candidates.filter(record__isnull=True)
        report.update(
            {
                "conflicts": conflicts.count(),
                "orphan_records": orphans.count(),
                "remaining_sessions": missing.count(),
                "unresolved": {},
                "mismatched_room": {},
                "samples": {},
            }
        )
        samples = report["samples"]

        def sample(queryset):
            return [
                str(pk)
                for pk in queryset.order_by("pk").values_list("pk", flat=True)[:limit]
            ]

        samples["missing_session_ids"] = sample(missing)
        samples["conflict_record_ids"] = sample(conflicts)
        samples["orphan_record_ids"] = sample(orphans)
        for model in (models.Transcript, models.Recording, models.Summary):
            unresolved = model.objects.filter(session__isnull=True)
            mismatch = model.objects.filter(session__isnull=False).exclude(
                room_id=F("session__room_id")
            )
            name = model.__name__
            report["unresolved"][name] = unresolved.count()
            report["mismatched_room"][name] = mismatch.count()
            samples[f"unresolved_{name}_ids"] = sample(unresolved)
            samples[f"mismatched_{name}_ids"] = sample(mismatch)
        report["ready"] = not any(
            [
                report["apply_conflicts"],
                report["conflicts"],
                report["orphan_records"],
                report["remaining_sessions"],
                *report["unresolved"].values(),
                *report["mismatched_room"].values(),
            ]
        )
