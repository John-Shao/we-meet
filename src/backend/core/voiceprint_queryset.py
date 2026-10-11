"""ORM bulk paths enter the same biometric journal transaction as Model.save.

No core models/services are imported at module initialization.
"""

from django.contrib.auth.models import UserManager
from django.db import models


class VoiceprintJournalQuerySet(models.QuerySet):
    def guarded(self, fields=None, *, physical_delete=False):
        from core import models as core_models  # noqa: PLC0415
        from core.services import voiceprint_journal_runtime as runtime  # noqa: PLC0415

        name = self.model._meta.model_name  # noqa: SLF001 -- Django's documented metadata API.
        protected = runtime.FIELDS.get(name, ())
        relevant = name in runtime.FIELDS or name in {
            "meetingsession",
            "voiceprintsamplingtrack",
        }
        if fields is not None:
            relevant = bool(
                set(protected).intersection(
                    set(fields) | {key + "_id" for key in fields}
                )
            )
        if (
            not relevant
            or runtime.ACTIVE.get()
            or not runtime.required()
            or not core_models.VoiceprintJournalCheckpoint.objects.exists()
        ):
            return False
        if physical_delete and name == "voiceprintsample":
            # Already-fenced bytes can be physically erased during authority outages.
            relevant = (
                self.exclude(status__in=["rejected", "expired", "deleted"])
                .exclude(profile__encrypted_key=b"")
                .exclude(
                    pk__in=core_models.VoiceprintContributionRemoval.objects.values(
                        "sample_uuid"
                    )
                )
                .exists()
            )
        elif physical_delete and name == "voiceprintprofile":
            relevant = (
                self.exclude(status="deleted").exclude(encrypted_key=b"").exists()
            )
        if (
            fields is not None
            and name == "voiceprintprofile"
            and (
                fields.get("encrypted_key") == b""
                and fields.get("status") == "deleted"
                and "generation" not in fields
                and not self.exclude(status="deleted", encrypted_key=b"").exists()
            )
        ):
            return False
        return relevant

    def update(self, **kwargs):
        if not self.guarded(kwargs):
            return super().update(**kwargs)
        from core.services import voiceprint_journal_runtime as runtime  # noqa: PLC0415

        with runtime.mutation():
            subjects = self.subjects()
            count = super().update(**kwargs)
            self.reconcile(subjects)
            return count

    def delete(self):
        if not self.guarded(physical_delete=True):
            return super().delete()
        from core.services import voiceprint_journal_runtime as runtime  # noqa: PLC0415

        with runtime.mutation():
            return super().delete()

    def bulk_create(self, objs, *args, **kwargs):
        if not self.guarded():
            return super().bulk_create(objs, *args, **kwargs)
        from core.services import voiceprint_journal_runtime as runtime  # noqa: PLC0415

        with runtime.mutation():
            return super().bulk_create(objs, *args, **kwargs)

    def subjects(self):
        from core.services import voiceprint_recovery as recovery  # noqa: PLC0415

        name = self.model._meta.model_name  # noqa: SLF001 -- Django's documented metadata API.
        fields = (
            ("id", "user_id", "organization_id") if name == "membership" else ("id",)
        )
        return recovery.rows(self.values(*fields).order_by("pk"))

    def reconcile(self, subjects):
        from core import models as core_models  # noqa: PLC0415
        from core.services import voiceprint_consent as consent  # noqa: PLC0415
        from core.services import voiceprint_lifecycle as lifecycle  # noqa: PLC0415

        name = self.model._meta.model_name  # noqa: SLF001 -- Django's documented metadata API.
        identifiers = [row["id"] for row in subjects]
        if name == "membership":
            for previous in subjects:
                user = core_models.User.objects.filter(pk=previous["user_id"]).first()
                organization = core_models.Organization.objects.filter(
                    pk=previous["organization_id"]
                ).first()
                if user is not None and not consent.active_member(user, organization):
                    consent.invalidate_subject(
                        user,
                        previous["organization_id"],
                        reason="membership_unavailable",
                    )
        handlers = {
            "user": lifecycle.account_changed,
            "membership": lifecycle.membership_changed,
            "organization": lifecycle.organization_changed,
            "meetingrecord": lifecycle.record_removed,
        }
        handler = handlers.get(name)
        if handler is not None:
            for instance in (
                self.model.objects.filter(pk__in=identifiers)
                .order_by("pk")
                .iterator(chunk_size=64)
            ):
                handler(self.model, instance)


class VoiceprintManager(models.Manager.from_queryset(VoiceprintJournalQuerySet)):
    pass


class VoiceprintUserManager(UserManager.from_queryset(VoiceprintJournalQuerySet)):
    pass
