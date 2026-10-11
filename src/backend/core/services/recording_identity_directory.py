"""Pre-import choices expose scoped names only, never biometric availability."""

from django.db.models import Q

from core import models
from core.services import recording_identity_preflight as preflight
from core.services import speaker_contacts
from core.services import voiceprint_candidates as candidates
from core.services import voiceprint_consent as consent
from core.services.speaker_identification_directory import (
    MAX_OFFSET,
    PAGE_SIZE,
    following,
)
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_media import MAX_DURATION_MS, MAX_SOURCE_BYTES


def capability(actor):
    try:
        consent.owner(actor)
        if not candidates.enabled():
            raise VoiceprintError("voiceprint_matching_disabled", status=503)
        limit = preflight.identity_jobs.policy().max_candidates
        preflight.media_config()
    except VoiceprintError as error:
        return {"available": False, "reason": str(error), "max_candidates": 0}
    return {
        "available": True,
        "reason": "",
        "max_candidates": limit,
        "max_bytes": MAX_SOURCE_BYTES,
        "max_duration_ms": MAX_DURATION_MS,
    }


def lookup(actor, *, organization_id, query="", offset=0):
    actor = consent.owner(actor)
    gate = capability(actor)
    if not gate["available"]:
        raise VoiceprintError(gate["reason"], status=503)
    if type(offset) is not int or not 0 <= offset <= MAX_OFFSET:
        raise VoiceprintError("voiceprint_directory_offset_invalid", status=400)
    if not isinstance(query, str) or len(query) > 80:
        raise VoiceprintError("voiceprint_directory_query_invalid", status=400)
    organization_id = candidates.explicit_scope(organization_id)
    organization = consent.scope(actor, organization_id)
    if not consent.available(actor, organization):
        raise VoiceprintError("voiceprint_candidate_scope_unavailable")
    users = models.User.objects.filter(is_active=True, is_device=False)
    if organization is None:
        users = users.filter(pk=actor.pk)
    else:
        users = users.filter(
            pk__in=models.Membership.objects.filter(
                organization=organization,
                status=models.MembershipStatusChoices.ACTIVE,
            ).values("user_id")
        )
    if query:
        users = users.filter(
            Q(full_name__icontains=query) | Q(short_name__icontains=query)
        )
    rows = list(users.order_by("full_name", "pk")[offset : offset + PAGE_SIZE + 1])
    return {
        "organization_id": str(organization_id) if organization_id else None,
        "results": [
            {"id": str(user.pk), "name": speaker_contacts.name(user)}
            for user in rows[:PAGE_SIZE]
        ],
        "next_offset": following(offset, rows),
    }
