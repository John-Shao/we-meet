"""Per-org expiry sweep: inputs, audit exports and queued shred requests."""

import logging
from datetime import datetime

from django.utils import timezone

from core.models import Organization

from work.api.context import role_cursor

logger = logging.getLogger(__name__)


def run_once(now: datetime | None = None) -> dict:
    now = now or timezone.now()
    inputs = 0
    exports = 0
    shreds = 0
    for org in Organization.objects.all().order_by("id"):
        org_id = str(org.id)
        try:
            with role_cursor(org_id, "work_worker") as cursor:
                cursor.execute("SELECT work.expire_due_inputs(%s)", [now])
                inputs += int(cursor.fetchone()[0] or 0)
                cursor.execute("SELECT work.expire_due_audit_exports(%s)", [now])
                exports += int(cursor.fetchone()[0] or 0)
                cursor.execute("SELECT work.shred_due_audit_exports(%s)", [now])
                shreds += int(cursor.fetchone()[0] or 0)
        except Exception:  # one tenant must not stop the sweep
            logger.exception("work expiry sweep failed org_id=%s", org_id)
    return {"inputs": inputs, "exports": exports, "shreds": shreds}
