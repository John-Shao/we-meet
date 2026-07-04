"""Audit-log writes for the management console (M 端).

A single ``record_audit`` helper the admin API write paths call so audit
capture stays in one place. Best-effort by design: a logging failure must never
roll back or break the administrative action it is recording.
"""

import logging

from core import models

logger = logging.getLogger(__name__)


def record_audit(
    *,
    actor,
    organization,
    action,
    target_type="",
    target_id="",
    target_label="",
    metadata=None,
):
    """Append one audit-log row (no-op if there is no organization to scope to)."""
    if organization is None:
        return
    try:
        models.AuditLog.objects.create(
            organization=organization,
            actor=actor if getattr(actor, "is_authenticated", False) else None,
            action=action,
            target_type=target_type,
            target_id=str(target_id) if target_id else "",
            target_label=target_label or "",
            metadata=metadata or {},
        )
    except Exception:  # noqa: BLE001 — audit must not break the mutation it records
        logger.exception("Failed to write audit log (action=%s)", action)
