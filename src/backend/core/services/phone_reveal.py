"""P3: notify a phone's owner when someone reveals their full number.

When user A reveals user B's full phone (via the reveal-phone endpoint), B
gets a directional system message in the A↔B direct conversation — rendered by
the clients as 「对方查看了你的手机号码」 on B's side (sender = A). Mirrors the
P1 call-log directional pattern; the message carries content_type
``phone-viewed`` and no meaningful body.

Server-sent (not client-sent) so the notice can't be skipped by a non-official
client. Best-effort: a jusi hiccup must not fail the reveal, so callers wrap
this in their own try/except and still return the number.
"""

from __future__ import annotations

import logging
import uuid

from django.conf import settings

from core.services.jusi_im import JusiImAdminClient

logger = logging.getLogger(__name__)

# Non-empty because post_message rejects an empty body; the clients key off
# content_type=phone-viewed and ignore the body.
_PHONE_VIEWED_BODY = "{}"


def send_phone_viewed_notice(viewer, owner) -> None:
    """Post a `phone-viewed` system message into the viewer↔owner direct
    conversation, sender = viewer. Raises on jusi failure (caller swallows)."""
    cfg = getattr(settings, "JUSI_IM_CONFIGURATION", None)
    if not cfg:
        logger.warning("phone-viewed notice skipped: JUSI_IM not configured")
        return

    client = JusiImAdminClient(
        api_url=str(cfg["api_url"]),
        admin_hmac_secret=str(cfg["admin_hmac_secret"]),
        timeout_seconds=float(cfg.get("request_timeout_seconds") or 5),
    )

    # Resolve both IM uids (lazy-registers on first touch; token discarded).
    viewer_uid = client.issue_token(external_id=str(viewer.sub), ttl_seconds=60).uid
    owner_uid = client.issue_token(external_id=str(owner.sub), ttl_seconds=60).uid
    if viewer_uid == owner_uid:
        return  # self-reveal already excluded by the caller, but be safe

    # Deterministic direct cid over the sorted pair — same formula as
    # im.conversations_direct, so A↔B always resolve to the one row.
    lo, hi = sorted([viewer_uid, owner_uid])
    cid = str(uuid.uuid5(uuid.NAMESPACE_OID, f"direct:{lo}:{hi}"))
    client.create_direct(cid=cid, owner_uid=viewer_uid, peer_uid=owner_uid)
    client.post_message(
        cid=cid,
        body=_PHONE_VIEWED_BODY,
        sender_uid=viewer_uid,
        content_type="phone-viewed",
    )
