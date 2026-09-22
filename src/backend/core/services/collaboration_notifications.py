"""Durable invitation notices; retried delivery cannot repeat an access mutation."""

import logging
import uuid

from django.conf import settings
from django.db import transaction

from core import models
from core.services import im_bots
from core.services.im_delivery_client import ImDeliveryClient
from core.services.im_provisioning import resolve_uid
from core.services.jusi_im import JusiImAdminClient

logger = logging.getLogger(__name__)


def available():
    config = settings.JUSI_IM_CONFIGURATION or {}
    return bool(
        settings.CELERY_ENABLED
        and config.get("api_url")
        and config.get("admin_hmac_secret")
        and im_bots.get_builtin(im_bots.BOT_MEETING_ASSISTANT)
    )


def dispatch(notice_id):
    from core.tasks.collaboration_notifications import (  # noqa: PLC0415
        deliver_invitation,
    )

    try:
        deliver_invitation.delay(str(notice_id))
    except Exception:  # noqa: BLE001 -- a persisted pending notice can be retried
        logger.warning("Invitation dispatch deferred: %s", notice_id)


@transaction.atomic
def _prepare(notice_id):
    from core.services.meeting_collaboration import SCOPES, can_manage  # noqa: PLC0415
    from core.services.meeting_records import visible_records  # noqa: PLC0415

    notice = (
        models.MeetingCollaborationNotice.objects.select_for_update()
        .select_related("receipt__policy__record", "receipt__actor", "recipient")
        .filter(pk=notice_id)
        .first()
    )
    if not notice or notice.status in {"sent", "canceled"}:
        return
    policy, actor, recipient = (
        notice.receipt.policy,
        notice.receipt.actor,
        notice.recipient,
    )
    record = policy.record
    if (
        not can_manage(record, actor, policy.scope)
        or not visible_records(recipient, ability=SCOPES[policy.scope])
        .filter(pk=record.pk)
        .exists()
    ):
        notice.status = "canceled"
        notice.save(update_fields=["status", "updated_at"])
        return
    if not available():
        return
    config = settings.JUSI_IM_CONFIGURATION
    try:
        client = JusiImAdminClient(config["api_url"], config["admin_hmac_secret"])
        if not notice.sender_uid:
            peer = resolve_uid(client, recipient)
            bot = im_bots.resolve_bot_uid(
                client, im_bots.get_builtin(im_bots.BOT_MEETING_ASSISTANT)
            )
            low, high = sorted([str(bot), str(peer)])
            notice.sender_uid = bot
            notice.conversation_id = uuid.uuid5(
                uuid.NAMESPACE_OID, f"direct:{low}:{high}"
            )
            kind = "智能纪要" if policy.scope == "minutes" else "会议实录"
            url = f"{str(settings.APPLICATION_BASE_URL).rstrip('/')}/meeting/records/{record.pk}?tab={'summary' if policy.scope == 'minutes' else 'overview'}"
            notice.body = f"{actor.full_name or '协作者'} 邀请你协作\n{kind}：{record.title}\n{notice.note}\n{url}"
            notice.save(
                update_fields=["sender_uid", "conversation_id", "body", "updated_at"]
            )
        return notice.pk
    except Exception:  # noqa: BLE001 -- keep persisted invitation pending
        return None


def deliver(notice_id):
    # Commit the exact outbound body before sending. A crash after acceptance
    # must retry the same idempotency key AND body, even if the title changes.
    prepared = _prepare(notice_id)
    if prepared is None:
        return
    from core.services.meeting_collaboration import SCOPES, can_manage  # noqa: PLC0415
    from core.services.meeting_records import visible_records  # noqa: PLC0415

    with transaction.atomic():
        notice = (
            models.MeetingCollaborationNotice.objects.select_for_update()
            .select_related("receipt__policy__record", "receipt__actor", "recipient")
            .get(pk=prepared)
        )
        if notice.status in {"sent", "canceled"}:
            return
        policy = notice.receipt.policy
        if (
            not can_manage(policy.record, notice.receipt.actor, policy.scope)
            or not visible_records(notice.recipient, ability=SCOPES[policy.scope])
            .filter(pk=policy.record_id)
            .exists()
        ):
            notice.status = "canceled"
        else:
            config = settings.JUSI_IM_CONFIGURATION
            try:
                client = JusiImAdminClient(
                    config["api_url"], config["admin_hmac_secret"]
                )
                peer = resolve_uid(client, notice.recipient)
                client.create_direct(
                    cid=str(notice.conversation_id),
                    owner_uid=str(notice.sender_uid),
                    peer_uid=peer,
                )
                receipt = ImDeliveryClient(
                    config["api_url"], config["admin_hmac_secret"]
                ).create(
                    str(notice.pk),
                    {
                        "sender_uid": str(notice.sender_uid),
                        "cid": str(notice.conversation_id),
                        "content_type": "text",
                        "body": notice.body,
                    },
                )
                notice.status = "sent" if receipt.state == "ready" else "pending"
            except Exception:  # noqa: BLE001 -- notification retry never reapplies access
                notice.status = "pending"
        notice.save(update_fields=["status", "updated_at"])
