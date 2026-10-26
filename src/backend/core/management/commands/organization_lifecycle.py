"""Provider-only organization lifecycle command (P0-4)."""

import json
import uuid

from django.core.management.base import BaseCommand, CommandError

from core.models import Organization, User
from core.services import organization_lifecycle


class Command(BaseCommand):
    """Provider-only operator entry point for tenant lifecycle transitions."""

    help = "Suspend, activate, archive or restore a tenant organization."

    def add_arguments(self, parser):
        parser.add_argument(
            "action", choices=["suspend", "activate", "archive", "restore"]
        )
        parser.add_argument("identifier", help="Organization slug or UUID.")
        parser.add_argument("--actor", default=None, help="Operator email for audit.")
        parser.add_argument("--reason", default="", help="Operator-facing reason.")
        parser.add_argument(
            "--confirm",
            default=None,
            help="Required for archive/restore: repeat the organization slug.",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report affected rows without writing.",
        )

    def _organization(self, value):
        try:
            uuid.UUID(value)
        except (TypeError, ValueError):
            pass
        else:
            found = Organization.objects.filter(id=value).first()
            if found:
                return found
        found = Organization.objects.filter(slug=value).first()
        if found is None:
            raise CommandError(f"Organization {value!r} not found.")
        return found

    def _actor(self, email):
        if not email:
            return None
        actor = User.objects.filter(email=email).first()
        if actor is None:
            raise CommandError(f"Actor {email!r} not found.")
        return actor

    def handle(self, *args, **options):
        action = options["action"]
        organization = self._organization(options["identifier"])
        actor = self._actor(options["actor"])

        if options["dry_run"]:
            payload = {
                "organization": organization.slug,
                "action": action,
                "dry_run": True,
                "state": organization_lifecycle.organization_state(organization),
                "counts": {},
            }
            self.stdout.write(json.dumps(payload, ensure_ascii=False))
            return

        if action in ("archive", "restore"):
            if not options["confirm"]:
                raise CommandError(f"--confirm {organization.slug} is required.")
            if options["confirm"] != organization.slug:
                raise CommandError(
                    f"--confirm must equal the slug {organization.slug!r}."
                )

        handler = getattr(organization_lifecycle, action)
        try:
            result = handler(organization, actor=actor, reason=options["reason"])
        except organization_lifecycle.LifecycleError as exc:
            raise CommandError(f"{exc.code}: {exc.detail}") from exc

        payload = {
            "organization": organization.slug,
            "action": action,
            **result,
        }
        self.stdout.write(json.dumps(payload, ensure_ascii=False))
