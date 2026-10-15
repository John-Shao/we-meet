"""Manage remote-control lease signing. Secrets only come from environment/files."""

import json

from django.core.management.base import BaseCommand, CommandError

from core.services import remote_control_keys as keys
from core.services.remote_control_livekit import RemoteControlError


class Command(BaseCommand):
    help = "Inspect or rotate remote-control lease keys (not Windows code signing)."

    def add_arguments(self, parser):
        parser.add_argument(
            "action",
            choices=["show", "check", "initialize", "stage", "activate", "revoke"],
        )
        parser.add_argument("--kid")
        parser.add_argument("--expected-revision", type=int)
        parser.add_argument(
            "--operator", help="Audited operator/change identifier; never a password"
        )
        parser.add_argument(
            "--replacement", help="New configured kid when revoking the active key"
        )

    def handle(self, *args, **options):
        action = options["action"]
        if action not in ("show", "check") and (
            not options["kid"] or not options["operator"]
        ):
            raise CommandError("--kid and --operator are required")
        if (
            action in ("stage", "activate", "revoke")
            and options["expected_revision"] is None
        ):
            raise CommandError("--expected-revision is required; inspect show first")
        if options["replacement"] and action != "revoke":
            raise CommandError("--replacement is only valid with revoke")
        try:
            if action == "show":
                result = keys.public_ring()
            elif action == "check":
                if not options["kid"]:
                    raise CommandError("--kid is required")
                result = keys.check_configuration(options["kid"])
            elif action == "initialize":
                result = keys.initialize(options["kid"], operator=options["operator"])
            else:
                result = keys.operate(
                    action,
                    options["kid"],
                    revision=options["expected_revision"],
                    operator=options["operator"],
                    replacement=options["replacement"],
                )
        except RemoteControlError as exc:
            raise CommandError(exc.code) from None
        self.stdout.write(json.dumps(result, sort_keys=True))
