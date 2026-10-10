"""Record/media-bound scope and candidate selection, without reading templates."""

from django.db.models import Q

from core import models
from core.services import speaker_contacts
from core.services import speaker_identification as identification
from core.services import voiceprint_candidates as candidates
from core.services import voiceprint_consent as consent
from core.services import voiceprint_sources as sources
from core.services.voiceprint_consent import VoiceprintError

PAGE_SIZE = 25
MAX_OFFSET = 10000


def access(record_id, actor, expected_revision, offset):
    if type(offset) is not int or not 0 <= offset <= MAX_OFFSET:
        raise VoiceprintError("voiceprint_directory_offset_invalid", status=400)
    record, actor = identification.record_access(
        record_id, actor, expected_revision=expected_revision
    )
    if not candidates.enabled():
        raise VoiceprintError("voiceprint_matching_disabled", status=503)
    return record, actor


def following(offset, page):
    return (
        offset + PAGE_SIZE
        if len(page) > PAGE_SIZE and offset + PAGE_SIZE <= MAX_OFFSET
        else None
    )


def options(record_id, actor, *, expected_revision, offset=0):
    record, actor = access(record_id, actor, expected_revision, offset)
    source = sources.snapshot(record, actor, expected_revision=expected_revision)
    targets = list(
        models.MeetingSpeaker.objects.filter(
            record=record,
            pk__in={row.speaker_id for row in source.intervals} - {None},
            user__isnull=True,
            manual_label="",
            attribution_kind="none",
        )
        .order_by("pk")
        .values("id", "label", "source_key")
    )
    organizations = models.Organization.objects.filter(
        pk__in=models.Membership.objects.filter(
            user=actor,
            status=models.MembershipStatusChoices.ACTIVE,
        ).values("organization_id"),
        is_active=True,
    ).order_by("name", "pk")
    if record.organization_id:
        organizations = organizations.filter(pk=record.organization_id)
    page = list(organizations[offset : offset + PAGE_SIZE + 1])
    return {
        "record_revision": record.revision,
        "required_organization_id": str(record.organization_id)
        if record.organization_id
        else None,
        "personal_allowed": record.organization_id is None,
        "targets": [
            {
                "id": str(target["id"]),
                "name": target["label"] or f"Speaker {target['source_key']}",
            }
            for target in targets
        ],
        "scopes": {
            "results": [
                {
                    "id": str(organization.pk),
                    "name": organization.name,
                    "enabled": consent.organization_policy(organization)["enabled"],
                }
                for organization in page[:PAGE_SIZE]
            ],
            "next_offset": following(offset, page),
        },
    }


def lookup(  # noqa: PLR0913 -- Explicit source version and selected library scope.
    record_id, actor, *, expected_revision, organization_id, query="", offset=0
):
    record, actor = access(record_id, actor, expected_revision, offset)
    if not isinstance(query, str) or len(query) > 80:
        raise VoiceprintError("voiceprint_directory_query_invalid", status=400)
    organization_id = candidates.explicit_scope(organization_id)
    sources.header(record.pk, actor.pk, expected_revision)
    _, _, organization = candidates.scope(
        record.pk, actor.pk, organization_id, (actor.pk,), expected_revision
    )
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
    page = list(users.order_by("full_name", "pk")[offset : offset + PAGE_SIZE + 1])
    return {
        "record_revision": record.revision,
        "organization_id": str(organization_id) if organization_id else None,
        "results": [
            {"id": str(user.pk), "name": speaker_contacts.name(user)}
            for user in page[:PAGE_SIZE]
        ],
        "next_offset": following(offset, page),
    }
