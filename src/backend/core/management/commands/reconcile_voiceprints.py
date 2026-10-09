"""Revoke scopes after bulk account/member changes that bypass Django signals."""

import json

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Exists, OuterRef, Q

from core import models
from core.services.voiceprint_consent import active_member, invalidate_subject


class Command(BaseCommand):
    help = "Reconcile inactive voiceprint subjects/scopes; do not grant or enroll."

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=100)

    def handle(self, *args, **options):
        limit = options["limit"]
        if not 1 <= limit <= 1000:
            raise CommandError("Limit must be between 1 and 1000.")
        current_member = models.Membership.objects.filter(
            user_id=OuterRef("user_id"),
            organization_id=OuterRef("organization_id"),
            status=models.MembershipStatusChoices.ACTIVE,
        )
        live_profile = models.VoiceprintProfile.objects.filter(
            consent_id=OuterRef("pk")
        ).exclude(status="deleted")
        identifiers = list(
            models.VoiceprintConsent.objects.annotate(
                member_active=Exists(current_member),
                profile_live=Exists(live_profile),
            )
            .filter(
                Q(allow_enrollment=True)
                | Q(allow_accumulation=True)
                | Q(allow_identification=True)
                | Q(profile_live=True),
            )
            .filter(
                Q(user__is_active=False)
                | Q(user__is_device=True)
                | Q(organization__isnull=False, organization__is_active=False)
                | Q(organization__isnull=False, member_active=False),
            )
            .order_by("created_at", "id")
            .values_list("pk", flat=True)[:limit]
        )
        revoked = 0
        for identifier in identifiers:
            with transaction.atomic():
                row = models.VoiceprintConsent.objects.filter(pk=identifier).first()
                if row is None:
                    continue
                user = (
                    models.User.objects.select_for_update()
                    .filter(pk=row.user_id)
                    .first()
                )
                if user is None:
                    continue
                row = (
                    models.VoiceprintConsent.objects.select_for_update(of=("self",))
                    .select_related("organization")
                    .filter(pk=identifier)
                    .first()
                )
                if row is None:
                    continue
                lost_account = not user.is_active or user.is_device
                lost_scope = row.organization_id is not None and not active_member(
                    user, row.organization
                )
                if lost_account or lost_scope:
                    invalidate_subject(
                        user,
                        row.organization_id,
                        reason="account_unavailable"
                        if lost_account
                        else "membership_unavailable",
                    )
                    revoked += 1
        self.stdout.write(json.dumps({"revoked": revoked}, sort_keys=True))
