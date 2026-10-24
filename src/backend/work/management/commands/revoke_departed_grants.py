"""Revoke Work grants for members who have already left.

Run once after deploying the departure signal:

    python manage.py revoke_departed_grants --dry-run
    python manage.py revoke_departed_grants

Only grants whose member has a ``left`` membership and no active one in the
same organization are touched, so a multi-department member keeps access as
long as any membership remains active. Re-running is a no-op.
"""

from django.core.management.base import BaseCommand
from django.db import transaction
from django.db.models import Exists, OuterRef

from core.models import Membership, MembershipStatusChoices

from work import lifecycle
from work.models import WorkMemberGrant


class Command(BaseCommand):
    help = "Revoke Work grants for departed members (idempotent backfill)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would be revoked without writing.",
        )
        parser.add_argument(
            "--organization",
            default=None,
            help="Limit to one organization UUID.",
        )
        parser.add_argument("--batch-size", type=int, default=200)

    def handle(self, *args, **options):
        left = Membership.objects.filter(
            organization_id=OuterRef("organization_id"),
            user_id=OuterRef("user_id"),
            status=MembershipStatusChoices.LEFT,
        )
        active = Membership.objects.filter(
            organization_id=OuterRef("organization_id"),
            user_id=OuterRef("user_id"),
            status=MembershipStatusChoices.ACTIVE,
        )
        queryset = (
            WorkMemberGrant.objects.filter(
                enabled=True, revoked_at__isnull=True
            )
            .annotate(has_left=Exists(left), has_active=Exists(active))
            .filter(has_left=True, has_active=False)
            .order_by("pk")
        )
        if options["organization"]:
            queryset = queryset.filter(organization_id=options["organization"])

        revoked = 0
        dry_run = options["dry_run"]
        batch_size = max(1, options["batch_size"])
        while True:
            batch = list(queryset[:batch_size])
            if not batch:
                break
            for grant in batch:
                if dry_run:
                    self.stdout.write(
                        f"would revoke {grant.organization_id}:{grant.user_id}"
                    )
                else:
                    with transaction.atomic():
                        lifecycle.revoke_grant(
                            grant.organization_id,
                            grant.user_id,
                            reason=WorkMemberGrant.RevokedReason.BACKFILL,
                        )
                    self.stdout.write(
                        f"revoked {grant.organization_id}:{grant.user_id}"
                    )
                revoked += 1
            queryset = queryset.filter(pk__gt=batch[-1].pk)

        verb = "would revoke" if dry_run else "revoked"
        self.stdout.write(
            self.style.SUCCESS(f"{verb} {revoked} grant(s)")
        )
