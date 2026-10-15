"""Meeting remote-control authorization. A signed lease never replaces local consent.

All transitions lock the two account rows in stable order, then the session. This
serializes inverse requests and cross-role chains across application processes.
LiveKit is queried independently of client assertions before a grant is renewed.
"""

from datetime import timedelta
from uuid import UUID

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from core import models
from core.services import remote_control_crypto as crypto
from core.services import remote_control_livekit as livekit
from core.services.remote_control_livekit import RemoteControlError

OPEN = models.REMOTE_CONTROL_OPEN_STATES
SCOPE = ["pointer", "keyboard", "text"]
PROOF_STATES = {
    "prepare": ("PENDING",),
    "approve": ("PREPARING",),
    "resume": ("PAUSED",),
    "lease": ("ACTIVE", "PAUSED"),
}


def human(user):
    if (
        not user
        or not user.is_authenticated
        or not user.is_active
        or not user.sub
        or user.is_device
    ):
        raise RemoteControlError("human_account_required", 403)


def enabled():
    return bool(
        settings.REMOTE_CONTROL_ENABLED
        and settings.REMOTE_CONTROL_SIGNING_KEY
        and settings.REMOTE_CONTROL_SIGNING_KID
    )


def policy(room, controller=None, target=None):
    if (
        not enabled()
        or room.ended_at
        or not room.organization_id
        or not room.organization.is_active
    ):
        raise RemoteControlError("remote_control_disabled", 403)
    organization = room.organization.settings.get("remote_control", {})
    local = room.configuration.get("remote_control", {})
    if (
        not isinstance(organization, dict)
        or organization.get("enabled") is not True
        or not isinstance(local, dict)
        or local.get("enabled") is False
    ):
        raise RemoteControlError("remote_control_disabled", 403)
    for user, role in ((controller, "controllers"), (target, "targets")):
        if user is None:
            continue
        human(user)
        if not models.Membership.objects.filter(
            user=user,
            organization=room.organization,
            status=models.MembershipStatusChoices.ACTIVE,
        ).exists():
            raise RemoteControlError("organization_access_denied", 403)
        for configuration in (organization, local):
            allowed = configuration.get(role)
            if allowed is not None and (
                not isinstance(allowed, list) or str(user.pk) not in allowed
            ):
                raise RemoteControlError("remote_control_not_allowed", 403)
    durations = [organization.get("max_seconds", 1800), local.get("max_seconds", 1800)]
    if any(type(n) is not int or not 30 <= n <= 1800 for n in durations):
        raise RemoteControlError("invalid_remote_control_policy", 503)
    return min(durations), crypto.digest({"organization": organization, "room": local})


def _room(room_id):
    try:
        return models.Room.objects.select_related("organization").get(pk=room_id)
    except models.Room.DoesNotExist as exc:
        raise RemoteControlError("not_found", 404) from exc


def _lock_users(*ids):
    users = list(
        models.User.objects.select_for_update().filter(pk__in=ids).order_by("pk")
    )
    if len(users) != len(set(ids)):
        raise RemoteControlError("human_account_required", 403)
    return {user.pk: user for user in users}


def _audit(row, event, actor=None, reason=""):
    models.RemoteControlAudit.objects.create(
        session=row,
        actor=actor,
        event=event,
        state=row.state,
        state_version=row.state_version,
        reason=reason,
    )
    notice = {
        "v": 1,
        "type": "STATE_CHANGED",
        "sessionId": str(row.pk),
        "stateVersion": row.state_version,
    }
    identities = [row.request["controllerIdentity"], row.request["targetIdentity"]]
    transaction.on_commit(lambda: livekit.notify(row.room_id, identities, notice))


def _finish(row, state, reason, actor=None):
    if row.state not in OPEN:
        return
    row.state = state
    row.state_version += 1
    row.ended_at = timezone.now()
    row.end_reason = reason
    row.lease_expires_at = row.ended_at
    row.save()
    _audit(row, "ended", actor, reason)


def _expire(row):
    if row.state in OPEN and row.deadline <= timezone.now():
        _finish(row, "EXPIRED", "authorization_expired")
    return row.state not in OPEN


def _serialize(row):
    return {
        "id": str(row.pk),
        "requestId": str(row.request_id),
        "requestDigest": row.request_digest,
        "request": row.request,
        "binding": row.binding,
        "state": row.state,
        "stateVersion": row.state_version,
        "epoch": row.epoch,
        "deadline": int(row.deadline.timestamp()),
        "endReason": row.end_reason,
        "serverTime": int(timezone.now().timestamp()),
    }


@transaction.atomic
def publish_presence(room_id, user, data):
    human(user)
    evidence = livekit.snapshot(room_id)
    user = _lock_users(user.pk)[user.pk]
    human(user)
    room = _room(room_id)
    policy(
        room,
        user if data["canControl"] else None,
        user if data["canBeControlled"] else None,
    )
    _member(room, user)
    entry = livekit.participant(evidence, user, data["participantSid"])
    if evidence.room_sid != data["roomSid"]:
        raise RemoteControlError("connection_changed")
    if data["canBeControlled"]:
        if data["platform"] != "win32" or not data["helperVersion"]:
            raise RemoteControlError("unsupported", 400)
        livekit.screen_allowed(entry)
    values = {
        "room_sid": evidence.room_sid,
        "participant_sid": entry.sid,
        "device_session_id": data["deviceSessionId"],
        "can_control": data["canControl"],
        "can_be_controlled": data["canBeControlled"],
        "protocol_versions": data["protocolVersions"],
        "platform": data["platform"],
        "helper_version": data["helperVersion"],
        "expires_at": timezone.now() + timedelta(seconds=20),
    }
    previous = models.RemoteControlPresence.objects.filter(room=room, user=user).first()
    if previous and (
        previous.participant_sid != entry.sid
        or previous.room_sid != evidence.room_sid
        or str(previous.device_session_id) != str(data["deviceSessionId"])
    ):
        invalidate(
            room_id,
            previous.room_sid,
            participant_sid=previous.participant_sid,
            reason="connection_changed",
        )
    models.RemoteControlPresence.objects.update_or_create(
        room=room, user=user, defaults=values
    )
    return {"expiresIn": 20, "protocolVersions": [1]}


def list_presence(room_id, user):
    human(user)
    if not enabled():
        return {"enabled": False, "participants": []}
    room = _room(room_id)
    policy(room)
    _member(room, user)
    evidence = livekit.snapshot(room_id)
    own = livekit.participant(evidence, user)
    items = []
    for row in models.RemoteControlPresence.objects.select_related("user").filter(
        room=room, room_sid=evidence.room_sid, expires_at__gt=timezone.now()
    ):
        try:
            livekit.participant(evidence, row.user, row.participant_sid)
            human(row.user)
        except RemoteControlError:
            continue
        items.append(
            {
                "userId": str(row.user_id),
                "identity": str(row.user.sub),
                "participantSid": row.participant_sid,
                "canControl": row.can_control,
                "canBeControlled": row.can_be_controlled,
                "protocolVersions": row.protocol_versions,
            }
        )
    return {
        "enabled": True,
        "roomSid": evidence.room_sid,
        "participants": items,
        "self": {
            "identity": str(user.sub),
            "participantSid": own.sid,
            "screenTrackSids": livekit.screen_tracks(own),
        },
    }


def _capability(room, evidence, user, *, target=False):
    entry = livekit.participant(evidence, user)
    row = models.RemoteControlPresence.objects.filter(
        room=room,
        user=user,
        room_sid=evidence.room_sid,
        participant_sid=entry.sid,
        expires_at__gt=timezone.now(),
    ).first()
    if (
        not row
        or 1 not in row.protocol_versions
        or not (row.can_be_controlled if target else row.can_control)
    ):
        raise RemoteControlError("capability_unavailable")
    return row


def _request_body(room, evidence, users, capabilities, data):
    controller, target = users
    a, b = capabilities
    return {
        "v": 1,
        "roomId": str(room.pk),
        "roomSid": evidence.room_sid,
        "controllerUserId": str(controller.pk),
        "controllerIdentity": str(controller.sub),
        "controllerSid": a.participant_sid,
        "targetUserId": str(target.pk),
        "targetIdentity": str(target.sub),
        "targetSid": b.participant_sid,
        "targetDeviceSessionId": str(b.device_session_id),
        "controllerPublicKey": data["controllerPublicKey"],
        "controllerName": controller.full_name
        or controller.short_name
        or str(controller.sub),
        "targetName": target.full_name or target.short_name or str(target.sub),
        "scope": SCOPE,
        "expiresAt": int(timezone.now().timestamp()) + 30,
    }


@transaction.atomic
def create_request(room_id, user, data):
    human(user)
    crypto.public_key(data["controllerPublicKey"])
    if user.pk == data["targetUserId"]:
        raise RemoteControlError("different_accounts_required", 400)
    evidence = livekit.snapshot(room_id)
    users = _lock_users(user.pk, data["targetUserId"])
    user, target = users[user.pk], users[data["targetUserId"]]
    room = _room(room_id)
    _, policy_digest = policy(room, user, target)
    previous = (
        models.RemoteControlSession.objects.select_for_update()
        .filter(controller=user, request_id=data["requestId"])
        .first()
    )
    if previous:
        original = previous.request
        if (
            previous.room_id != room.pk
            or previous.target_id != target.pk
            or original["controllerPublicKey"] != data["controllerPublicKey"]
            or previous.target_sid != data["targetSid"]
            or previous.controller_sid != data["controllerSid"]
            or previous.room_sid != data["roomSid"]
        ):
            raise RemoteControlError("idempotency_conflict")
        _expire(previous)
        return _serialize(previous)
    a, b = (
        _capability(room, evidence, user),
        _capability(room, evidence, target, target=True),
    )
    if (
        data["roomSid"] != evidence.room_sid
        or data["controllerSid"] != a.participant_sid
        or data["targetSid"] != b.participant_sid
    ):
        raise RemoteControlError("connection_changed")
    livekit.screen_allowed(livekit.participant(evidence, target))
    recent = models.RemoteControlSession.objects.filter(
        controller=user,
        target=target,
        created_at__gte=timezone.now() - timedelta(seconds=60),
    )
    if (
        recent.count() >= 3
        or recent.filter(
            state="REJECTED", ended_at__gte=timezone.now() - timedelta(seconds=60)
        ).exists()
    ):
        raise RemoteControlError("request_rate_limited", 429)
    conflicts = (
        models.RemoteControlSession.objects.select_for_update()
        .filter(state__in=OPEN)
        .filter(
            Q(target_device_session_id=b.device_session_id)
            | Q(
                room_sid=evidence.room_sid,
                controller_sid__in=[a.participant_sid, b.participant_sid],
            )
            | Q(
                room_sid=evidence.room_sid,
                target_sid__in=[a.participant_sid, b.participant_sid],
            )
        )
    )
    for conflict in conflicts:
        if not _expire(conflict):
            raise RemoteControlError("busy")
    request = _request_body(room, evidence, (user, target), (a, b), data)
    row = models.RemoteControlSession.objects.create(
        room=room,
        organization=room.organization,
        controller=user,
        target=target,
        request_id=data["requestId"],
        request=request,
        request_digest=crypto.digest(request),
        room_sid=evidence.room_sid,
        controller_sid=a.participant_sid,
        target_sid=b.participant_sid,
        target_device_session_id=b.device_session_id,
        policy_digest=policy_digest,
        deadline=timezone.now() + timedelta(seconds=30),
    )
    _audit(row, "requested", user)
    return _serialize(row)


def _member(room, user):
    if not models.Membership.objects.filter(
        user=user,
        organization_id=room.organization_id,
        status=models.MembershipStatusChoices.ACTIVE,
    ).exists():
        raise RemoteControlError("organization_access_denied", 403)


def _locked(room_id, session_id, user, *, target_only=False, admin_end=False):
    human(user)
    try:
        initial = models.RemoteControlSession.objects.get(
            pk=session_id, room_id=room_id
        )
    except models.RemoteControlSession.DoesNotExist as exc:
        raise RemoteControlError("not_found", 404) from exc
    allowed = (
        (initial.target_id,)
        if target_only
        else (initial.controller_id, initial.target_id)
    )
    admin = (
        admin_end
        and models.Membership.objects.filter(
            user=user,
            organization_id=initial.organization_id,
            status=models.MembershipStatusChoices.ACTIVE,
            org_role__in=(models.OrgRoleChoices.OWNER, models.OrgRoleChoices.ADMIN),
        ).exists()
    )
    if user.pk not in allowed and not admin:
        raise RemoteControlError("not_found", 404)
    users = _lock_users(initial.controller_id, initial.target_id, user.pk)
    human(users[user.pk])
    return (
        models.RemoteControlSession.objects.select_for_update(of=("self",))
        .select_related("room__organization", "controller", "target")
        .get(pk=session_id)
    )


def _current(row, evidence):
    duration, digest = policy(row.room, row.controller, row.target)
    if evidence.room_sid != row.room_sid:
        raise RemoteControlError("connection_changed")
    livekit.participant(evidence, row.controller, row.controller_sid)
    target = livekit.participant(evidence, row.target, row.target_sid)
    if not livekit.participant(evidence, row.controller).permission.can_subscribe:
        raise RemoteControlError("screen_subscription_not_allowed", 403)
    _capability(row.room, evidence, row.controller)
    capability = _capability(row.room, evidence, row.target, target=True)
    if capability.device_session_id != row.target_device_session_id:
        raise RemoteControlError("connection_changed")
    if row.binding:
        livekit.screen_track(target, row.binding["trackSid"])
    return duration, digest


def _prepared_binding(row, evidence, proposal):
    required = {
        "targetPublicKey",
        "shareInstanceId",
        "trackSid",
        "displayBindingHash",
        "targetDeviceSessionId",
    }
    if not isinstance(proposal, dict) or set(proposal) != required:
        raise RemoteControlError("invalid_binding", 400)
    crypto.public_key(proposal["targetPublicKey"])
    try:
        UUID(proposal["shareInstanceId"])
        if UUID(proposal["targetDeviceSessionId"]) != row.target_device_session_id:
            raise ValueError
        if len(proposal["displayBindingHash"]) != 64 or any(
            c not in "0123456789abcdef" for c in proposal["displayBindingHash"]
        ):
            raise ValueError
    except (TypeError, ValueError, AttributeError) as exc:
        raise RemoteControlError("invalid_binding", 400) from exc
    livekit.screen_track(
        livekit.participant(evidence, row.target, row.target_sid), proposal["trackSid"]
    )
    return {**row.request, **proposal, "sessionId": str(row.pk)}


@transaction.atomic
def challenge(room_id, session_id, user, data):
    row = _locked(room_id, session_id, user, target_only=True)
    if _expire(row):
        return {"session": _serialize(row)}
    purpose = data["purpose"]
    if (
        row.state not in PROOF_STATES[purpose]
        or row.state_version != data["stateVersion"]
    ):
        raise RemoteControlError("state_conflict")
    evidence = livekit.snapshot(room_id)
    _current(row, evidence)
    binding = (
        _prepared_binding(row, evidence, data.get("binding"))
        if purpose == "prepare"
        else row.binding
    )
    if purpose != "prepare" and data.get("binding") is not None:
        raise RemoteControlError("immutable_binding", 400)
    now = timezone.now()
    expires = min(row.deadline, now + timedelta(seconds=15))
    previous = row.challenges.filter(
        purpose=purpose,
        state_version=row.state_version,
        epoch=row.epoch,
        consumed_at__isnull=True,
        expires_at__gt=now,
    ).first()
    if previous:
        if previous.payload["binding"] != binding:
            raise RemoteControlError("challenge_conflict")
        return {"proof": previous.payload}
    proof = models.RemoteControlChallenge(
        session=row,
        purpose=purpose,
        state_version=row.state_version,
        epoch=row.epoch,
        expires_at=expires,
    )
    proof.payload = {
        "v": 1,
        "audience": crypto.AUDIENCE,
        "scope": SCOPE,
        "purpose": purpose,
        "challengeId": str(proof.pk),
        "requestId": str(row.request_id),
        "sessionId": str(row.pk),
        "requestDigest": row.request_digest,
        "stateVersion": row.state_version,
        "epoch": row.epoch + 1 if purpose == "resume" else row.epoch,
        "expiresAt": int(expires.timestamp()),
        "binding": binding,
    }
    crypto.canonical(proof.payload)
    proof.save()
    return {"proof": proof.payload}


def _lease(row, duration):
    now = timezone.now()
    if row.approved_at is None:
        row.approved_at = now
        row.max_expires_at = now + timedelta(seconds=duration)
    row.max_expires_at = min(
        row.max_expires_at, row.approved_at + timedelta(seconds=duration)
    )
    row.lease_expires_at = min(now + timedelta(seconds=15), row.max_expires_at)
    row.deadline = row.lease_expires_at
    issued, expires = int(now.timestamp()), int(row.lease_expires_at.timestamp())
    if expires <= issued:
        raise RemoteControlError("authorization_expired")
    binding = {
        **row.binding,
        "epoch": row.epoch,
        "state": row.state,
        "stateVersion": row.state_version,
        "policyDigest": row.policy_digest,
        "maxExpiresAt": int(row.max_expires_at.timestamp()),
    }
    return crypto.issue_lease(
        binding,
        pem=settings.REMOTE_CONTROL_SIGNING_KEY,
        kid=settings.REMOTE_CONTROL_SIGNING_KID,
        issued_at=issued,
        expires_at=expires,
    )


@transaction.atomic
def prove(room_id, session_id, user, purpose, data):  # noqa: PLR0912 -- Atomic, explicit proof state transitions.
    row = _locked(room_id, session_id, user, target_only=True)
    try:
        proof = row.challenges.select_for_update().get(
            pk=data["challengeId"], purpose=purpose
        )
    except models.RemoteControlChallenge.DoesNotExist as exc:
        raise RemoteControlError("invalid_challenge", 400) from exc
    proof_digest = crypto.digest({"signature": data["signature"]})
    if proof.consumed_at:
        if proof.proof_digest != proof_digest:
            raise RemoteControlError("idempotency_conflict")
        # A replay cannot revive a newer/terminal state or return an old lease.
        if _expire(row) or row.state_version != proof.result["session"]["stateVersion"]:
            return {"session": _serialize(row)}
        return proof.result
    if _expire(row):
        return {"session": _serialize(row)}
    if (
        proof.expires_at <= timezone.now()
        or int(timezone.now().timestamp()) >= proof.payload["expiresAt"]
        or proof.state_version != row.state_version
        or proof.epoch != row.epoch
        or row.state not in PROOF_STATES[purpose]
    ):
        raise RemoteControlError("stale_challenge")
    crypto.verify_consent(
        proof.payload["binding"]["targetPublicKey"], proof.payload, data["signature"]
    )
    evidence = livekit.snapshot(room_id)
    duration, row.policy_digest = _current(row, evidence)
    livekit.screen_track(
        livekit.participant(evidence, row.target, row.target_sid),
        proof.payload["binding"]["trackSid"],
    )
    if purpose != "prepare" and proof.payload["binding"] != row.binding:
        raise RemoteControlError("immutable_binding")
    row.state_version += 1
    lease = None
    if purpose == "prepare":
        row.binding = proof.payload["binding"]
        row.state = "PREPARING"
        row.deadline = timezone.now() + timedelta(seconds=60)
    else:
        if purpose in ("approve", "resume"):
            row.state = "ACTIVE"
        if purpose == "resume":
            row.epoch += 1
        lease = _lease(row, duration)
    row.save()
    if purpose != "lease":
        _audit(row, purpose, user)
    proof.consumed_at, proof.proof_digest = timezone.now(), proof_digest
    proof.result = {"session": _serialize(row)}
    if lease:
        proof.result["lease"] = lease
    proof.save()
    return proof.result


@transaction.atomic
def get_session(room_id, session_id, user):
    row = _locked(room_id, session_id, user)
    _expire(row)
    result = _serialize(row)
    # Only the current approved proof is disclosed; polling cannot extend a lease.
    if row.state in ("ACTIVE", "PAUSED"):
        proof = (
            row.challenges.filter(
                consumed_at__isnull=False,
                result__session__stateVersion=row.state_version,
            )
            .order_by("-consumed_at")
            .first()
        )
        if proof:
            result["lease"] = proof.result.get("lease")
    return result


def list_requests(room_id, user):
    human(user)
    evidence = livekit.snapshot(room_id)
    entry = livekit.participant(evidence, user)
    rows = models.RemoteControlSession.objects.filter(
        room_id=room_id, room_sid=evidence.room_sid, state__in=OPEN
    ).filter(
        Q(target=user, target_sid=entry.sid)
        | Q(controller=user, controller_sid=entry.sid)
    )
    return [get_session(room_id, row.pk, user) for row in rows[:10]]


@transaction.atomic
def action(room_id, session_id, user, operation, expected_version):
    row = _locked(room_id, session_id, user, admin_end=operation == "end")
    if _expire(row):
        return _serialize(row)
    if operation == "end":
        _finish(row, "ENDED", "local_stop", user)
        return _serialize(row)
    if operation == "pause" and row.state == "PAUSED":
        return _serialize(row)
    if expected_version != row.state_version:
        raise RemoteControlError("state_conflict")
    if (
        operation == "reject"
        and user.pk == row.target_id
        and row.state in ("PENDING", "PREPARING")
    ):
        _finish(row, "REJECTED", "request_rejected", user)
    elif (
        operation == "cancel"
        and user.pk == row.controller_id
        and row.state in ("PENDING", "PREPARING")
    ):
        _finish(row, "CANCELLED", "request_cancelled", user)
    elif operation == "pause" and row.state in ("ACTIVE", "PAUSED"):
        if row.state == "ACTIVE":
            row.state, row.state_version = "PAUSED", row.state_version + 1
            row.save()
            _audit(row, "paused", user)
    else:
        raise RemoteControlError("action_not_allowed", 403)
    return _serialize(row)


@transaction.atomic
def invalidate(
    room_id, room_sid, *, participant_sid=None, track_sid=None, reason="room_ended"
):
    rows = models.RemoteControlSession.objects.select_for_update().filter(
        room_id=room_id, room_sid=room_sid, state__in=OPEN
    )
    if participant_sid:
        rows = rows.filter(
            Q(controller_sid=participant_sid) | Q(target_sid=participant_sid)
        )
    if track_sid:
        rows = rows.filter(binding__trackSid=track_sid)
    for row in rows:
        _finish(row, "ENDED", reason)


@transaction.atomic
def expire_sessions():
    rows = models.RemoteControlSession.objects.select_for_update(
        skip_locked=True
    ).filter(state__in=OPEN, deadline__lte=timezone.now())[:500]
    for row in rows:
        _expire(row)


@transaction.atomic
def revoke_by_room_action(room_id, *, identity=None, reason="room_ended"):
    """Called only after the existing room-management permission checks."""
    rows = models.RemoteControlSession.objects.select_for_update().filter(
        room_id=room_id, state__in=OPEN
    )
    if identity is not None:
        rows = rows.filter(
            Q(request__controllerIdentity=identity)
            | Q(request__targetIdentity=identity)
        )
    for row in rows:
        _finish(row, "ENDED", reason)


def prune_history():
    """Receipt/input-free lifecycle retention; never delete an open session."""
    now = timezone.now()
    models.RemoteControlPresence.objects.filter(
        expires_at__lt=now - timedelta(minutes=5)
    ).delete()
    models.RemoteControlChallenge.objects.filter(
        expires_at__lt=now - timedelta(minutes=5)
    ).delete()
    models.RemoteControlSession.objects.exclude(state__in=OPEN).filter(
        ended_at__lt=now - timedelta(days=90)
    ).delete()


def audit_history(room_id, session_id, user):
    human(user)
    room = _room(room_id)
    if not models.Membership.objects.filter(
        user=user,
        organization_id=room.organization_id,
        status=models.MembershipStatusChoices.ACTIVE,
        org_role__in=(models.OrgRoleChoices.OWNER, models.OrgRoleChoices.ADMIN),
    ).exists():
        raise RemoteControlError("audit_access_denied", 403)
    return list(
        models.RemoteControlAudit.objects.filter(
            session_id=session_id, session__room=room
        )
        .order_by("created_at")
        .values(
            "id", "actor_id", "event", "state", "state_version", "reason", "created_at"
        )[:200]
    )
