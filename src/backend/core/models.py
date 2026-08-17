"""
Declare and configure the models for the Meet core application
# pylint: disable=too-many-lines
"""
# pylint: disable=too-many-lines

import secrets
import uuid
from datetime import datetime, timedelta
from datetime import time as dt_time
from logging import getLogger
from os.path import splitext
from typing import List, Optional
from zoneinfo import ZoneInfo

from django.conf import settings
from django.contrib.auth import models as auth_models
from django.contrib.auth.base_user import AbstractBaseUser
from django.contrib.postgres.constraints import ExclusionConstraint
from django.contrib.postgres.fields import (
    ArrayField,
    DateTimeRangeField,
    RangeBoundary,
    RangeOperators,
)
from django.core import mail, validators
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import models, transaction
from django.utils import timezone
from django.utils.text import capfirst, slugify
from django.utils.translation import gettext_lazy as _

from lasuite.tools.email import get_domain_from_email
from timezone_field import TimeZoneField

from . import fields, utils
from .recording.enums import FileExtension

logger = getLogger(__name__)


class RoleChoices(models.TextChoices):
    """Role choices."""

    MEMBER = "member", _("Member")
    ADMIN = "administrator", _("Administrator")
    OWNER = "owner", _("Owner")

    @classmethod
    def check_administrator_role(cls, role):
        """Check if a role is administrator."""
        return role == cls.ADMIN

    @classmethod
    def check_owner_role(cls, role):
        """Check if a role is owner."""
        return role == cls.OWNER


class RecordingStatusChoices(models.TextChoices):
    """Enumeration of possible states for a recording operation."""

    INITIATED = "initiated", _("Initiated")
    ACTIVE = "active", _("Active")
    STOPPED = "stopped", _("Stopped")
    SAVED = "saved", _("Saved")
    ABORTED = "aborted", _("Aborted")
    FAILED_TO_START = "failed_to_start", _("Failed to Start")
    FAILED_TO_STOP = "failed_to_stop", _("Failed to Stop")
    NOTIFICATION_SUCCEEDED = "notification_succeeded", _("Notification succeeded")

    @classmethod
    def is_final(cls, status):
        """Determine if the recording status represents a final state.

        A final status indicates the recording flow has completed, either
        successfully or unsuccessfully.
        """

        return status in {
            cls.STOPPED,
            cls.SAVED,
            cls.ABORTED,
            cls.FAILED_TO_START,
            cls.FAILED_TO_STOP,
        }

    @classmethod
    def is_unsuccessful(cls, status):
        """Determine if the recording status represents an unsuccessful state."""
        return status in {cls.ABORTED, cls.FAILED_TO_START, cls.FAILED_TO_STOP}


class RecordingModeChoices(models.TextChoices):
    """Recording mode choices."""

    SCREEN_RECORDING = "screen_recording", _("SCREEN_RECORDING")
    TRANSCRIPT = "transcript", _("TRANSCRIPT")


class RoomAccessLevel(models.TextChoices):
    """Room access level choices."""

    PUBLIC = "public", _("Public Access")
    TRUSTED = "trusted", _("Trusted Access")
    RESTRICTED = "restricted", _("Restricted Access")


class BaseModel(models.Model):
    """
    Serves as an abstract base model for other models, ensuring that records are validated
    before saving as Django doesn't do it by default.

    Includes fields common to all models: a UUID primary key and creation/update timestamps.
    """

    id = models.UUIDField(
        verbose_name=_("id"),
        help_text=_("primary key for the record as UUID"),
        primary_key=True,
        default=uuid.uuid4,
        editable=False,
    )
    created_at = models.DateTimeField(
        verbose_name=_("created on"),
        help_text=_("date and time at which a record was created"),
        auto_now_add=True,
        editable=False,
    )
    updated_at = models.DateTimeField(
        verbose_name=_("updated on"),
        help_text=_("date and time at which a record was last updated"),
        auto_now=True,
        editable=False,
    )

    class Meta:
        abstract = True

    def save(self, *args, **kwargs):
        """Call `full_clean` before saving."""
        self.full_clean()
        super().save(*args, **kwargs)


class User(AbstractBaseUser, BaseModel, auth_models.PermissionsMixin):
    """User model to work with OIDC only authentication."""

    sub_validator = validators.RegexValidator(
        regex=r"^[\w.@+-]+\Z",
        message=_(
            "Enter a valid sub. This value may contain only letters, "
            "numbers, and @/./+/-/_ characters."
        ),
    )

    sub = models.CharField(
        _("sub"),
        help_text=_(
            "Optional for pending users; required upon account activation. "
            "255 characters or fewer. Letters, numbers, and @/./+/-/_ characters only."
        ),
        max_length=255,
        unique=True,
        validators=[sub_validator],
        blank=True,
        null=True,
    )
    email = models.EmailField(_("identity email address"), blank=True, null=True)

    # Unlike the "email" field which stores the email coming from the OIDC token, this field
    # stores the email used by staff users to log in to the admin site
    admin_email = models.EmailField(
        _("admin email address"), unique=True, blank=True, null=True
    )
    full_name = models.CharField(_("full name"), max_length=100, null=True, blank=True)
    short_name = models.CharField(
        _("short name"), max_length=100, null=True, blank=True
    )
    phone = models.CharField(
        _("phone"),
        help_text=_(
            "Mobile number, authoritative copy in Keycloak (phoneNumber attribute); "
            "synced here on each login by the OIDC backend. Empty for accounts "
            "without a phone (email/device users). Same-org visible, masked by "
            "default — full number only via the reveal endpoint (P3)."
        ),
        max_length=32,
        blank=True,
        default="",
    )
    im_uid = models.CharField(
        _("IM uid"),
        help_text=_(
            "Cached jusi-light-im internal uid, backfilled on first IM token issue. "
            "Lets the IM bridge resolve conversation members (uids) → display names."
        ),
        max_length=36,
        unique=True,
        blank=True,
        null=True,
        editable=False,
    )
    language = models.CharField(
        max_length=10,
        choices=settings.LANGUAGES,
        default=settings.LANGUAGE_CODE,
        verbose_name=_("language"),
        help_text=_("The language in which the user wants to see the interface."),
    )
    timezone = TimeZoneField(
        choices_display="WITH_GMT_OFFSET",
        use_pytz=False,
        default=settings.TIME_ZONE,
        help_text=_("The timezone in which the user wants to see times."),
    )
    is_device = models.BooleanField(
        _("device"),
        default=False,
        help_text=_("Whether the user is a device or a real user."),
    )
    is_staff = models.BooleanField(
        _("staff status"),
        default=False,
        help_text=_("Whether the user can log into this admin site."),
    )
    is_active = models.BooleanField(
        _("active"),
        default=True,
        help_text=_(
            "Whether this user should be treated as active. "
            "Unselect this instead of deleting accounts."
        ),
    )
    # Mobile app extension: extended profile fields editable by the user.
    intro = models.CharField(
        _("intro"),
        max_length=100,
        blank=True,
        default="",
        help_text=_("Short self-introduction shown on the user's profile."),
    )
    # Avatar / cover images live in private buckets — only the object key is
    # stored; clients receive a short-lived presigned GET URL (see serializer).
    avatar_key = models.CharField(
        _("avatar object key"),
        max_length=500,
        blank=True,
        default="",
        help_text=_("Object storage key of the user's avatar image."),
    )
    cover_key = models.CharField(
        _("cover object key"),
        max_length=500,
        blank=True,
        default="",
        help_text=_("Object storage key of the user's profile cover image."),
    )

    objects = auth_models.UserManager()

    USERNAME_FIELD = "admin_email"
    REQUIRED_FIELDS = []

    class Meta:
        db_table = "meet_user"
        ordering = ("-created_at",)
        verbose_name = _("user")
        verbose_name_plural = _("users")

    def __str__(self):
        return self.email or self.admin_email or str(self.id)

    def email_user(self, subject, message, from_email=None, **kwargs):
        """Email this user."""
        if not self.email:
            raise ValueError("User has no email address.")
        mail.send_mail(subject, message, from_email, [self.email], **kwargs)

    def get_teams(self):
        """Team keys granting this user team-based resource access.

        Two kinds of subject, both opaque strings that go verbatim into
        ``BaseAccess.team``:

        - ``dept:<hex>`` — each *direct*, active department membership. Subtree
          expansion is intentionally NOT applied (a manager of a parent
          department does not implicitly gain access to child-department
          resources); that stays an explicit, opt-in grant per roadmap P1.
        - ``group:<hex>`` — each live user group the person is in (P10 M2).

        Memoized on the instance: ``BaseAccessManager.filter_user`` and the
        viewset querysets call this once per request on ``request.user``, so the
        cache turns N access-row checks into two queries without needing a
        cross-request cache.

        No cross-request (Redis) cache on purpose. Two indexed reads per request
        is already cheap, and a cached copy buys a "added to the group but still
        can't see anything" staleness bug that is far more expensive to explain
        than the queries are to run.
        """
        if not hasattr(self, "_teams_cache"):
            dept_keys = Membership.objects.filter(
                user=self,
                status=MembershipStatusChoices.ACTIVE,
                department__isnull=False,
                department__is_active=True,
                department__deleted_at__isnull=True,
            ).values_list("department__team_key", flat=True)
            group_keys = UserGroupMember.objects.filter(
                user=self,
                group__is_active=True,
                group__deleted_at__isnull=True,
            ).values_list("group__group_key", flat=True)
            self._teams_cache = [*dept_keys, *group_keys]
        return self._teams_cache


def get_resource_roles(resource: models.Model, user: User) -> List[str]:
    """Roles a user holds on a resource, including team-based ones where they exist.

    There are two access-control shapes in this codebase, and they are not the
    same system despite the shared vocabulary:

    - **Team-aware** — ``BaseAccess`` subclasses, whose manager is a
      ``BaseAccessManager``. Today that is only ``RecordingAccess``. A grant may
      name a user *or* a team key (``dept:<hex>``), so roles come from
      ``filter_user`` (user OR team).
    - **Plain** — ``ResourceAccess`` (rooms). It has no ``team`` column at all
      and its ``user`` FK is non-null, so a user's roles are exactly their own
      access rows.

    This used to call ``filter_user`` unconditionally, which raised
    ``AttributeError`` for anything of the second shape (the ``except`` clause
    below never caught it). Nothing hit it because both call sites happen to
    pass recordings — but the generic name and signature invited a caller to
    pass a ``Room`` and get a 500. Dispatching on the manager makes the
    behaviour match the name: rooms get user-only roles, which for rooms is the
    complete answer rather than a partial one.

    Args:
        resource: A ``Resource``/``Room`` or ``Recording`` — anything with an
            ``accesses`` related manager.
        user: The user to resolve roles for.

    Returns:
        Distinct role strings, empty when the user is anonymous or has none.
    """
    if not user or not user.is_authenticated:
        return []

    accesses = resource.accesses
    queryset = (
        accesses.filter_user(user)
        if hasattr(accesses, "filter_user")
        else accesses.filter(user=user)
    )
    # ``order_by()`` before ``distinct()`` is load-bearing: the models order by
    # ``-created_at``, and Django puts ORDER BY columns into the SELECT of a
    # DISTINCT query — so it would deduplicate on (role, created_at) and hand
    # back "member, member" for someone granted the same role directly and via
    # their department. Harmless for today's callers (they use ``in`` or wrap in
    # ``set()``), but the ``.distinct()`` was not doing what it claimed.
    return list(queryset.order_by().values_list("role", flat=True).distinct())


class Resource(BaseModel):
    """Model to define access control"""

    users = models.ManyToManyField(
        User,
        through="ResourceAccess",
        through_fields=("resource", "user"),
        related_name="resources",
    )

    class Meta:
        db_table = "meet_resource"
        verbose_name = _("Resource")
        verbose_name_plural = _("Resources")

    def __str__(self):
        try:
            return self.name
        except AttributeError:
            return f"Resource {self.id!s}"

    def get_role(self, user):
        """
        Determine the role of a given user in this resource.
        """
        if not user or not user.is_authenticated:
            return None

        role = None
        for access in self.accesses.filter(user=user):
            if access.role == RoleChoices.OWNER:
                return RoleChoices.OWNER
            if access.role == RoleChoices.ADMIN:
                role = RoleChoices.ADMIN
            if access.role == RoleChoices.MEMBER and role != RoleChoices.ADMIN:
                role = RoleChoices.MEMBER
        return role

    def has_any_role(self, user):
        """Check if a user has any role on the resource."""
        return self.get_role(user) is not None

    def is_administrator_or_owner(self, user):
        """
        Check if a user is administrator or owner of the resource."""
        role = self.get_role(user)
        return RoleChoices.check_administrator_role(
            role
        ) or RoleChoices.check_owner_role(role)

    def is_owner(self, user):
        """Check if a user is owner of the resource."""
        return RoleChoices.check_owner_role(self.get_role(user))


class ResourceAccess(BaseModel):
    """Link table between resources and users"""

    resource = models.ForeignKey(
        Resource,
        on_delete=models.CASCADE,
        related_name="accesses",
    )
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="accesses")
    role = models.CharField(
        max_length=20, choices=RoleChoices.choices, default=RoleChoices.MEMBER
    )

    class Meta:
        db_table = "meet_resource_access"
        ordering = ("-created_at",)
        verbose_name = _("Resource access")
        verbose_name_plural = _("Resource accesses")
        constraints = [
            models.UniqueConstraint(
                fields=["user", "resource"],
                name="resource_access_unique_user_resource",
                violation_error_message=_(
                    "Resource access with this User and Resource already exists."
                ),
            ),
        ]

    def __str__(self):
        role = capfirst(self.get_role_display())
        try:
            resource = self.resource.name
        except AttributeError:
            resource = f"resource {self.resource_id!s}"

        return f"{role:s} role for {self.user!s} on {resource:s}"

    def save(self, *args, **kwargs):
        """Make sure we keep at least one owner for the resource."""
        if self.pk and self.role != RoleChoices.OWNER:
            accesses = self._meta.model.objects.filter(
                resource=self.resource, role=RoleChoices.OWNER
            ).only("pk")
            if len(accesses) == 1 and accesses[0].pk == self.pk:
                raise PermissionDenied("A resource should keep at least one owner.")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        """Disallow deleting the last of the Mohicans."""
        if (
            self.role == RoleChoices.OWNER
            and self._meta.model.objects.filter(
                resource=self.resource, role=RoleChoices.OWNER
            ).count()
            == 1
        ):
            raise PermissionDenied("A resource should keep at least one owner.")
        return super().delete(*args, **kwargs)


class Room(Resource):
    """Model for one room"""

    name = models.CharField(max_length=500)
    resource = models.OneToOneField(
        Resource,
        on_delete=models.CASCADE,
        parent_link=True,
        primary_key=True,
    )
    # The room's meeting code: a generated, unique 8-digit number — also the
    # room's URL handle on the web. Generated in `save()` for new rooms.
    slug = models.SlugField(max_length=100, blank=True, null=True, unique=True)
    access_level = models.CharField(
        max_length=50,
        choices=RoomAccessLevel.choices,
        default=settings.RESOURCE_DEFAULT_ACCESS_LEVEL,
    )
    # Public configuration exposed to any room participant via the API
    configuration = models.JSONField(
        blank=True,
        default=dict,
        verbose_name=_("Visio room configuration"),
        help_text=_("Values for Visio parameters to configure the room."),
    )
    pin_code = models.CharField(
        max_length=None,
        unique=True,
        blank=True,
        null=True,
        verbose_name=_("Room PIN code"),
        help_text=_("Unique n-digit code that identifies this room in telephony mode."),
    )
    ended_at = models.DateTimeField(
        blank=True,
        null=True,
        verbose_name=_("ended at"),
        help_text=_("Date and time at which the room owner ended the room."),
    )
    scheduled_at = models.DateTimeField(
        blank=True,
        null=True,
        verbose_name=_("scheduled for"),
        help_text=_(
            "Date and time at which the room is scheduled to start. "
            "Informational only — the room is reachable as soon as it's "
            "created, but UIs (lobby, history) surface this value as the "
            "intended start so participants know when to show up."
        ),
    )
    # P10 M2 — org scoping. Without it the console's "meetings" figure is
    # platform-wide, so two tenants on one deployment read each other's numbers.
    # Nullable and never a filter for *access* (that stays with ResourceAccess):
    # a room created before this column existed, or by someone with no
    # membership, is still a perfectly valid room.
    #
    # Recording / Summary deliberately do NOT get their own column — they reach
    # the organization through ``room``, and a second copy is a second thing to
    # keep in sync.
    organization = models.ForeignKey(
        "Organization",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="rooms",
    )

    class Meta:
        db_table = "meet_room"
        ordering = ("name",)
        verbose_name = _("Room")
        verbose_name_plural = _("Rooms")

    def __str__(self):
        return capfirst(self.name)

    def save(self, *args, **kwargs):
        """Generate a unique pin code and slug for new rooms."""
        if settings.ROOM_TELEPHONY_ENABLED and not self.pk and not self.pin_code:
            self.pin_code = self.generate_unique_pin_code(
                length=settings.ROOM_TELEPHONY_PIN_LENGTH
            )
        if not self.pk and not self.slug:
            self.slug = self.generate_unique_slug()
        super().save(*args, **kwargs)

    @property
    def is_public(self):
        """Check if a room is public"""
        return self.access_level == RoomAccessLevel.PUBLIC

    @property
    def is_ended(self):
        """Check if the room has been ended by its owner."""
        return self.ended_at is not None

    @staticmethod
    def generate_unique_slug(length=8, max_retries=10):
        """Generate a unique numeric slug — the room's 8-digit meeting code."""

        max_value = 10**length

        for _ in range(max_retries):
            slug = str(secrets.randbelow(max_value)).zfill(length)
            if not Room.objects.filter(slug=slug).exists():
                return slug

        # Log a warning as a temporary measure until backend observability is implemented.
        logger.warning(
            "Failed to generate unique room slug of length %s after %s attempts",
            length,
            max_retries,
        )

        return None

    @staticmethod
    def generate_unique_pin_code(length):
        """Generate a unique n-digit PIN code"""

        if length < 4:
            raise ValueError(
                "PIN code length must be at least 4 digits for minimal security"
            )

        max_value = 10**length

        for _ in range(settings.ROOM_TELEPHONY_PIN_MAX_RETRIES):
            pin_code = str(secrets.randbelow(max_value)).zfill(length)
            if not Room.objects.filter(pin_code=pin_code).exists():
                return pin_code

        # Log a warning as a temporary measure until backend observability is implemented.
        logger.warning(
            "Failed to generate unique PIN code of length %s after %s attempts",
            length,
            settings.ROOM_TELEPHONY_PIN_MAX_RETRIES,
        )

        return None


class MeetingSession(BaseModel):
    """One concrete LiveKit room lifecycle for a reusable :class:`Room`.

    ``Room`` owns the stable meeting link, configuration and ACL.  A new row is
    created here whenever LiveKit assigns a new room SID to that link.  Legacy
    rows created during the later artifact backfill are the only rows allowed
    not to have a LiveKit SID.
    """

    class Status(models.TextChoices):
        ACTIVE = "active", _("Active")
        ENDED = "ended", _("Ended")

    class StartSource(models.TextChoices):
        LIVEKIT_ROOM = "livekit_room", _("LiveKit room creation time")
        WEBHOOK = "webhook", _("Webhook event time")
        TRANSCRIPT = "transcript", _("Transcript fallback")
        LEGACY = "legacy", _("Legacy backfill")

    class EndReason(models.TextChoices):
        ROOM_FINISHED = "room_finished", _("LiveKit room finished")
        OWNER_ENDED = "owner_ended", _("Owner ended room")
        SUPERSEDED = "superseded", _("Superseded by a new LiveKit room")
        RECONCILED = "reconciled", _("Closed by reconciliation")
        LEGACY = "legacy", _("Legacy backfill")

    room = models.ForeignKey(
        Room,
        on_delete=models.CASCADE,
        related_name="meeting_sessions",
        verbose_name=_("room"),
    )
    livekit_room_sid = models.CharField(
        _("LiveKit room SID"),
        max_length=64,
        unique=True,
        null=True,
        blank=True,
        help_text=_("Server-assigned LiveKit room instance identifier."),
    )
    status = models.CharField(
        _("status"),
        max_length=16,
        choices=Status.choices,
        default=Status.ACTIVE,
    )
    started_at = models.DateTimeField(_("started at"), db_index=True)
    ended_at = models.DateTimeField(_("ended at"), null=True, blank=True, db_index=True)
    start_source = models.CharField(
        _("start source"),
        max_length=24,
        choices=StartSource.choices,
        default=StartSource.WEBHOOK,
    )
    end_reason = models.CharField(
        _("end reason"),
        max_length=24,
        choices=EndReason.choices,
        blank=True,
        default="",
    )
    last_event_at = models.DateTimeField(_("last event at"), null=True, blank=True)

    class Meta:
        db_table = "meet_meeting_session"
        ordering = ("-started_at",)
        verbose_name = _("meeting session")
        verbose_name_plural = _("meeting sessions")
        constraints = [
            models.UniqueConstraint(
                fields=["room"],
                condition=models.Q(status="active"),
                name="uniq_active_session_per_room",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(status="active", ended_at__isnull=True, end_reason="")
                    | (
                        models.Q(status="ended", ended_at__isnull=False)
                        & ~models.Q(end_reason="")
                    )
                ),
                name="session_status_end_consistent",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(ended_at__isnull=True)
                    | models.Q(ended_at__gte=models.F("started_at"))
                ),
                name="session_end_not_before_start",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(start_source="legacy", livekit_room_sid__isnull=True)
                    | (
                        ~models.Q(start_source="legacy")
                        & models.Q(livekit_room_sid__isnull=False)
                    )
                ),
                name="session_legacy_sid_consistent",
            ),
        ]
        indexes = [
            models.Index(
                fields=["room", "-started_at"], name="meet_sess_room_start_idx"
            ),
            models.Index(
                fields=["status", "updated_at"], name="meet_sess_status_upd_idx"
            ),
        ]

    def __str__(self):
        sid = self.livekit_room_sid or "legacy"
        return f"MeetingSession({self.room_id}, {sid}, {self.status})"

    def clean(self):
        """Keep lifecycle fields consistent before the database constraints run."""

        super().clean()
        if self.livekit_room_sid == "":
            self.livekit_room_sid = None

        errors = {}
        if self.start_source == self.StartSource.LEGACY:
            if self.livekit_room_sid is not None:
                errors["livekit_room_sid"] = _("A legacy session cannot have a SID.")
        elif not self.livekit_room_sid:
            errors["livekit_room_sid"] = _("A live meeting session requires a SID.")

        if self.status == self.Status.ACTIVE:
            if self.ended_at is not None:
                errors["ended_at"] = _("An active session cannot have an end time.")
            if self.end_reason:
                errors["end_reason"] = _("An active session cannot have an end reason.")
        else:
            if self.ended_at is None:
                errors["ended_at"] = _("An ended session requires an end time.")
            if not self.end_reason:
                errors["end_reason"] = _("An ended session requires an end reason.")

        if self.started_at and self.ended_at and self.ended_at < self.started_at:
            errors["ended_at"] = _("End time cannot be before start time.")

        if errors:
            raise ValidationError(errors)


class MeetingParticipation(BaseModel):
    """One participant connection interval inside a meeting session."""

    session = models.ForeignKey(
        MeetingSession,
        on_delete=models.CASCADE,
        related_name="participations",
        verbose_name=_("meeting session"),
    )
    livekit_participant_sid = models.CharField(
        _("LiveKit participant SID"), max_length=64
    )
    user = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        related_name="meeting_participations",
        null=True,
        blank=True,
        verbose_name=_("user"),
    )
    identity = models.CharField(
        _("participant identity"), max_length=255, db_index=True
    )
    display_name = models.CharField(
        _("display name"), max_length=128, blank=True, default=""
    )
    kind = models.CharField(_("participant kind"), max_length=32, default="unknown")
    joined_at = models.DateTimeField(_("joined at"), db_index=True)
    left_at = models.DateTimeField(_("left at"), null=True, blank=True, db_index=True)
    disconnect_reason = models.CharField(
        _("disconnect reason"), max_length=48, blank=True, default=""
    )

    class Meta:
        db_table = "meet_meeting_participation"
        ordering = ("session", "joined_at")
        verbose_name = _("meeting participation")
        verbose_name_plural = _("meeting participations")
        constraints = [
            models.UniqueConstraint(
                fields=["session", "livekit_participant_sid"],
                name="uniq_session_participant_sid",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(left_at__isnull=True)
                    | models.Q(left_at__gte=models.F("joined_at"))
                ),
                name="participation_leave_after_join",
            ),
        ]
        indexes = [
            models.Index(
                fields=["session", "joined_at"], name="meet_part_sess_join_idx"
            ),
            models.Index(fields=["user", "session"], name="meet_part_user_sess_idx"),
        ]

    def __str__(self):
        return f"MeetingParticipation({self.session_id}, {self.identity})"

    def clean(self):
        """Reject impossible intervals while accepting future LiveKit enum values."""

        super().clean()
        if self.left_at and self.joined_at and self.left_at < self.joined_at:
            raise ValidationError(
                {"left_at": _("Leave time cannot be before join time.")}
            )


class BaseAccessManager(models.Manager):
    """Base manager for handling resource access control."""

    def filter_user(self, user):
        """Filter accesses for a given user, including both direct and team-based access."""
        return self.filter(models.Q(user=user) | models.Q(team__in=user.get_teams()))


class BaseAccess(BaseModel):
    """Base model for accesses to handle resources."""

    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
    )
    # Indexed because ``BaseAccessManager.filter_user`` does ``team__in=…`` on
    # every access check. With one department key per user the missing index was
    # invisible; ``get_teams()`` will soon also return user-group keys
    # (``group:<hex>``), turning that into a ~10-element IN over a sequential
    # scan. Index first, widen the IN list after.
    #
    # NB: ``RecordingAccess`` is currently the ONLY concrete subclass, so team
    # grants reach recordings and nothing else — ``ResourceAccess`` (rooms) is a
    # plain ``BaseModel`` with no team column. Extending team access to rooms is
    # a table change, not a config flag. See P10 §0 F3.
    team = models.CharField(max_length=100, blank=True, db_index=True)
    role = models.CharField(
        max_length=20, choices=RoleChoices.choices, default=RoleChoices.MEMBER
    )

    objects = BaseAccessManager()

    class Meta:
        abstract = True

    def _get_abilities(self, resource, user):
        """
        Compute and return abilities for a given user taking into account
        the current state of the object.
        """

        roles = get_resource_roles(resource, user)

        is_owner = RoleChoices.OWNER in roles
        has_privileges = is_owner or RoleChoices.ADMIN in roles

        # Default values for unprivileged users
        set_role_to = set()
        can_delete = False

        # Special handling when modifying an owner's access
        if self.role == RoleChoices.OWNER:
            # Prevent orphaning the resource
            can_delete = (
                is_owner
                and resource.accesses.filter(role=RoleChoices.OWNER).count() > 1
            )
            if can_delete:
                set_role_to = {RoleChoices.ADMIN, RoleChoices.OWNER, RoleChoices.MEMBER}
        elif has_privileges:
            can_delete = True
            set_role_to = {RoleChoices.ADMIN, RoleChoices.MEMBER}
            if is_owner:
                set_role_to.add(RoleChoices.OWNER)

        # Remove the current role as we don't want to propose it as an option
        set_role_to.discard(self.role)

        return {
            "destroy": can_delete,
            "update": bool(set_role_to),
            "partial_update": bool(set_role_to),
            "retrieve": bool(roles),
            "set_role_to": sorted(r.value for r in set_role_to),
        }


class Recording(BaseModel):
    """Model for recordings that take place in a room.

     Recording Status Flow:
    1. INITIATED: Initial state when recording is requested
    2. ACTIVE: Recording is currently in progress
    3. STOPPED: Recording has been stopped by user/system
    4. SAVED: Recording has been successfully processed and stored
    4. NOTIFICATION_SUCCEEDED: External service has been notified of this recording

    Error States:
    - FAILED_TO_START: Worker failed to initialize recording
    - FAILED_TO_STOP: Worker failed during stop operation
    - ABORTED: Recording was terminated before completion

    Warning: Worker failures may lead to database inconsistency between the actual
    recording state and its status in the database.
    """

    room = models.ForeignKey(
        Room,
        on_delete=models.CASCADE,
        related_name="recordings",
        verbose_name=_("Room"),
    )
    status = models.CharField(
        max_length=50,
        choices=RecordingStatusChoices.choices,
        default=RecordingStatusChoices.INITIATED,
    )
    worker_id = models.CharField(
        max_length=255,
        null=True,
        blank=True,
        verbose_name=_("Worker ID"),
        help_text=_(
            "Enter an identifier for the worker recording."
            "This ID is retained even when the worker stops, allowing for easy tracking."
        ),
    )
    mode = models.CharField(
        max_length=20,
        choices=RecordingModeChoices.choices,
        default=RecordingModeChoices.SCREEN_RECORDING,
        verbose_name=_("Recording mode"),
        help_text=_("Defines the mode of recording being called."),
    )
    options = models.JSONField(
        blank=True,
        default=dict,
        verbose_name=_("Recording options"),
        help_text=_("Recording options"),
    )

    class Meta:
        db_table = "meet_recording"
        ordering = ("-created_at",)
        verbose_name = _("Recording")
        verbose_name_plural = _("Recordings")
        constraints = [
            models.UniqueConstraint(
                fields=["room"],
                condition=models.Q(
                    status__in=[
                        RecordingStatusChoices.ACTIVE,
                        RecordingStatusChoices.INITIATED,
                    ]
                ),
                name="unique_initiated_or_active_recording_per_room",
            )
        ]

    def __str__(self):
        return f"Recording {self.id} ({self.status})"

    def get_abilities(self, user):
        """Compute and return abilities for a given user on the recording."""

        roles = set(get_resource_roles(self, user))

        is_owner_or_admin = bool(
            roles.intersection({RoleChoices.OWNER, RoleChoices.ADMIN})
        )

        is_final_status = RecordingStatusChoices.is_final(self.status)

        return {
            "destroy": is_owner_or_admin and is_final_status,
            "partial_update": False,
            "retrieve": is_owner_or_admin,
            "stop": is_owner_or_admin and not is_final_status,
            "update": False,
        }

    def is_savable(self) -> bool:
        """Determine if the recording can be saved based on its current status."""

        return self.status in {
            RecordingStatusChoices.ACTIVE,
            RecordingStatusChoices.STOPPED,
        }

    @property
    def is_saved(self) -> bool:
        """Check if the recording is in a saved state."""
        return self.status in {
            RecordingStatusChoices.NOTIFICATION_SUCCEEDED,
            RecordingStatusChoices.SAVED,
        }

    @property
    def extension(self):
        """Get recording extension based on its mode."""
        extensions = {
            RecordingModeChoices.TRANSCRIPT: FileExtension.OGG.value,
            RecordingModeChoices.SCREEN_RECORDING: FileExtension.MP4.value,
        }
        return extensions.get(self.mode, FileExtension.MP4.value)

    @property
    def key(self):
        """Generate the file key based on recording mode."""

        return f"{settings.RECORDING_OUTPUT_FOLDER}/{self.id}.{self.extension}"

    @property
    def expired_at(self) -> Optional[datetime]:
        """
        Calculate the expiration date based on created_at and RECORDING_EXPIRATION_DAYS.
        Returns None if no expiration is configured.

        Note: This is a naive and imperfect implementation since recordings are actually
        saved to the bucket after created_at timestamp is set. The actual expiration
        will be determined by the bucket lifecycle policy which operates on the object's
        timestamp in the storage system, not this value.
        """

        if not settings.RECORDING_EXPIRATION_DAYS:
            return None

        return self.created_at + timedelta(days=settings.RECORDING_EXPIRATION_DAYS)

    @property
    def is_expired(self) -> bool:
        """
        Determine if the recording has expired by comparing expired_at with current UTC time.
        Returns False if no expiration is configured or if expiration date is in the future.
        """
        if not self.expired_at:
            return False

        return self.expired_at < timezone.now()


class RecordingAccess(BaseAccess):
    """Relation model to give access to a recording for a user or a team with a role."""

    recording = models.ForeignKey(
        Recording,
        on_delete=models.CASCADE,
        related_name="accesses",
    )

    class Meta:
        db_table = "meet_recording_access"
        ordering = ("-created_at",)
        verbose_name = _("Recording/user relation")
        verbose_name_plural = _("Recording/user relations")
        constraints = [
            models.UniqueConstraint(
                fields=["user", "recording"],
                condition=models.Q(user__isnull=False),  # Exclude null users
                name="unique_recording_user",
                violation_error_message=_("This user is already in this recording."),
            ),
            models.UniqueConstraint(
                fields=["team", "recording"],
                condition=models.Q(team__gt=""),  # Exclude empty string teams
                name="unique_recording_team",
                violation_error_message=_("This team is already in this recording."),
            ),
            models.CheckConstraint(
                condition=models.Q(user__isnull=False, team="")
                | models.Q(user__isnull=True, team__gt=""),
                name="check_recording_access_either_user_or_team",
                violation_error_message=_("Either user or team must be set, not both."),
            ),
        ]

    def __str__(self):
        return f"{self.user!s} is {self.role:s} in {self.recording!s}"

    def get_abilities(self, user):
        """
        Compute and return abilities for a given user on the recording access.
        """
        return self._get_abilities(self.recording, user)


class ApplicationScope(models.TextChoices):
    """Available permission scopes for application operations."""

    ROOMS_CREATE = "rooms:create", _("Create rooms")
    ROOMS_LIST = "rooms:list", _("List rooms")
    ROOMS_RETRIEVE = "rooms:retrieve", _("Retrieve room details")
    ROOMS_UPDATE = "rooms:update", _("Update rooms")
    ROOMS_DELETE = "rooms:delete", _("Delete rooms")


class Application(BaseModel):
    """External application for API authentication and authorization.

    Represents a third-party integration or automated system that accesses
    the API using OAuth2-style client credentials (client_id/client_secret).
    Supports scoped permissions and optional domain restrictions for delegation.
    """

    name = models.CharField(
        max_length=255,
        verbose_name=_("Application name"),
        help_text=_("Descriptive name for this application."),
    )
    is_active = models.BooleanField(default=True)
    client_id = models.CharField(
        max_length=100, unique=True, default=utils.generate_client_id
    )
    client_secret = fields.SecretField(
        max_length=255,
        blank=True,
        default=utils.generate_client_secret,
        help_text=_("Hashed on Save. Copy it now if this is a new secret."),
    )
    scopes = ArrayField(
        models.CharField(max_length=50, choices=ApplicationScope.choices),
        default=list,
        blank=True,
    )

    class Meta:
        db_table = "meet_application"
        ordering = ("-created_at",)
        verbose_name = _("Application")
        verbose_name_plural = _("Applications")

    def __str__(self):
        return f"{self.name!s}"

    def can_delegate_email(self, email):
        """Check if this application can delegate the given email."""

        if not self.allowed_domains.exists():
            return True  # No domain restrictions

        domain = get_domain_from_email(email)
        return self.allowed_domains.filter(domain__iexact=domain).exists()


class ApplicationDomain(BaseModel):
    """Domain authorized for application delegation."""

    domain = models.CharField(
        max_length=253,  # Max domain length per RFC 1035
        validators=[
            validators.DomainNameValidator(
                accept_idna=False,
                message=_("Enter a valid domain"),
            )
        ],
        verbose_name=_("Domain"),
        help_text=_("Email domain this application can act on behalf of."),
    )

    application = models.ForeignKey(
        "Application",
        on_delete=models.CASCADE,
        related_name="allowed_domains",
    )

    class Meta:
        db_table = "meet_application_domain"
        ordering = ("domain",)
        verbose_name = _("Application domain")
        verbose_name_plural = _("Application domains")
        unique_together = [("application", "domain")]

    def __str__(self):
        """Return string representation of the domain."""

        return self.domain

    def save(self, *args, **kwargs):
        """Save the domain after normalizing to lowercase."""

        self.domain = self.domain.lower().strip()
        super().save(*args, **kwargs)


class FileUploadStateChoices(models.TextChoices):
    """Possible states of a file."""

    PENDING = "pending", _("Pending")
    # Commented out for now, as we may need this when we implement the malware detection logic.
    # ANALYZING = "analyzing", _("Analyzing")
    # SUSPICIOUS = "suspicious", _("Suspicious")
    # FILE_TOO_LARGE_TO_ANALYZE = (
    #     "file_too_large_to_analyze",
    #     _("File too large to analyze"),
    # )
    READY = "ready", _("Ready")


class FileTypeChoices(models.TextChoices):
    """Defines the possible types of a file."""

    BACKGROUND_IMAGE = "background_image", _("Background image")


class File(BaseModel):
    """File uploaded by a user."""

    type = models.CharField(
        max_length=25,
        choices=FileTypeChoices.choices,
        null=False,
        blank=False,
    )
    title = models.CharField(_("title"), max_length=255)
    creator = models.ForeignKey(
        User,
        on_delete=models.RESTRICT,
        related_name="files_created",
        blank=True,
        null=True,
    )
    deleted_at = models.DateTimeField(null=True, blank=True)
    hard_deleted_at = models.DateTimeField(null=True, blank=True)

    filename = models.CharField(max_length=255, null=False, blank=False)

    upload_state = models.CharField(
        max_length=25,
        choices=FileUploadStateChoices.choices,
    )
    mimetype = models.CharField(max_length=255, null=True, blank=True)
    size = models.BigIntegerField(null=True, blank=True)
    description = models.TextField(null=True, blank=True)
    malware_detection_info = models.JSONField(
        null=True,
        blank=True,
        default=dict,
        help_text=_("Malware detection info when the analysis status is unsafe."),
    )

    class Meta:
        db_table = "file"
        verbose_name = _("File")
        verbose_name_plural = _("Files")
        ordering = ("created_at",)
        indexes = [
            models.Index(fields=["creator", "type", "-created_at"]),
        ]

    def __str__(self):
        return str(self.title)

    def save(self, *args, **kwargs):
        """Set the upload state to pending if it's the first save and it's a file."""

        if self.created_at is None:
            self.upload_state = FileUploadStateChoices.PENDING

        return super().save(*args, **kwargs)

    def delete(self, using=None, keep_parents=False):
        if self.deleted_at is None:
            raise RuntimeError("The file must be soft deleted before being deleted.")

        return super().delete(using, keep_parents)

    @property
    def is_pending_upload(self):
        """Return whether the file is in a pending upload state"""
        return self.upload_state == FileUploadStateChoices.PENDING

    @property
    def extension(self):
        """Return the extension related to the filename."""
        if self.filename is None:
            raise RuntimeError(
                "The file must have a filename to compute its extension."
            )

        _, extension = splitext(self.filename)

        if extension:
            return extension.lstrip(".")

        return None

    @property
    def key_base(self):
        """Key base of the location where the file is stored in object storage."""
        if not self.pk:
            raise RuntimeError(
                "The file instance must be saved before requesting a storage key."
            )

        return f"{settings.FILE_UPLOAD_PATH}/{self.pk!s}"

    @property
    def file_key(self):
        """Key used to store the file in object storage."""
        _, extension = splitext(self.filename)
        # We store only the extension in the storage system to avoid
        # leaking Personal Information in logs, etc.
        return f"{self.key_base}{extension!s}"

    def get_abilities(self, user):
        """
        Compute and return abilities for a given user on the file.
        """
        # Characteristics that are based only on specific access
        is_creator = user == self.creator
        retrieve = is_creator
        is_deleted = self.deleted_at is not None
        can_update = is_creator and not is_deleted and user.is_authenticated
        can_hard_delete = is_creator and user.is_authenticated
        can_destroy = can_hard_delete and not is_deleted

        return {
            "destroy": can_destroy,
            "hard_delete": can_hard_delete,
            "retrieve": retrieve,
            "media_auth": retrieve and not is_deleted,
            "partial_update": can_update,
            "update": can_update,
            "upload_ended": can_update and user.is_authenticated,
        }

    @transaction.atomic
    def soft_delete(self):
        """
        Soft delete the file.
        We still keep the .delete() method untouched for programmatic purposes.
        """
        if self.deleted_at:
            raise RuntimeError("This file is already deleted.")

        self.deleted_at = timezone.now()
        self.save(update_fields=["deleted_at"])

    def hard_delete(self):
        """
        Hard delete the file.
        We still keep the .delete() method untouched for programmatic purposes.
        """
        if self.hard_deleted_at:
            raise ValidationError(
                {
                    "hard_deleted_at": ValidationError(
                        _("This file is already hard deleted."),
                        code="file_hard_delete_already_effective",
                    )
                }
            )

        if self.deleted_at is None:
            raise ValidationError(
                {
                    "hard_deleted_at": ValidationError(
                        _("To hard delete a file, it must first be soft deleted."),
                        code="file_hard_delete_should_soft_delete_first",
                    )
                }
            )

        self.hard_deleted_at = timezone.now()
        self.save(update_fields=["hard_deleted_at"])


# ---------------------------------------------------------------------------
# AI assistant catalog
#
# Layered model registry (vendor → model → profile) so ops can plug new
# AI providers / models / voices / prompts in via Django admin without code
# changes. Conventions intentionally mirror livekit-agents' string-ID style
# (``vendor/model:variant``), so any future official LiveKit plugin for the
# same vendor can drop in without renaming.
#
# - AIVendor             厂商（火山引擎 / 阿里云 / OpenAI ...）
# - AIModel              具体模型 (vendor + capability + code)
#                        capability ∈ {stt, llm, tts, vlm, omni}
# - AIVoice              TTS / Omni 模型的可选音色
# - AIPrompt             提示词模板
# - AIAgentProfile       装配方案 = wire-level provider
#                        架构 ∈ {pipeline, omni}
# ---------------------------------------------------------------------------


class AIVendor(BaseModel):
    """AI model vendor (Volcengine, Aliyun, OpenAI, ...)."""

    code = models.CharField(_("code"), max_length=64, unique=True)
    display_name = models.CharField(_("display name"), max_length=128)
    sort_order = models.PositiveSmallIntegerField(_("sort order"), default=0)
    is_active = models.BooleanField(_("active"), default=True)

    class Meta:
        verbose_name = _("AI vendor")
        verbose_name_plural = _("AI vendors")
        ordering = ("sort_order", "code")

    def __str__(self) -> str:
        return self.display_name or self.code


class AIModel(BaseModel):
    """A concrete AI model offered by a vendor for a given capability.

    ``capability`` mirrors the livekit-agents base-class taxonomy
    (``livekit.agents.stt.STT`` / ``llm.LLM`` / ``tts.TTS`` /
    ``llm.RealtimeModel``) plus our own ``vlm`` extension. We call the
    end-to-end multimodal class ``omni`` rather than ``realtime`` since
    that is the term the actual products use (Qwen-Omni-Realtime,
    Doubao-S2S-Omni).
    """

    class Capability(models.TextChoices):
        STT = "stt", _("Speech-to-text")
        LLM = "llm", _("Language model")
        TTS = "tts", _("Text-to-speech")
        VLM = "vlm", _("Vision-language model")
        OMNI = "omni", _("End-to-end omni-modal")

    vendor = models.ForeignKey(
        AIVendor,
        on_delete=models.PROTECT,
        related_name="models",
        verbose_name=_("vendor"),
    )
    capability = models.CharField(
        _("capability"),
        max_length=16,
        choices=Capability.choices,
    )
    code = models.CharField(
        _("model code"),
        max_length=128,
        help_text=_(
            "Model identifier in livekit-style ``vendor/model[:variant]`` "
            "form (e.g. ``volcengine/seed-asr``)."
        ),
    )
    display_name = models.CharField(_("display name"), max_length=128)
    endpoint = models.CharField(
        _("endpoint"),
        max_length=512,
        blank=True,
        default="",
        help_text=_(
            "WebSocket / HTTP endpoint URL. Optional — many SDK-based "
            "plugins infer this from the vendor."
        ),
    )
    api_key_env = models.CharField(
        _("API key env var"),
        max_length=128,
        blank=True,
        default="",
        help_text=_(
            "Name of the environment variable holding the API key for "
            "this model. The DB only stores the name; the secret stays "
            "in the agent process env."
        ),
    )
    extra_config = models.JSONField(
        _("extra config"),
        default=dict,
        blank=True,
        help_text=_(
            "Model-specific parameters (sample_rate, model_version, "
            "speaking_style, ...)."
        ),
    )
    sort_order = models.PositiveSmallIntegerField(_("sort order"), default=0)
    is_active = models.BooleanField(_("active"), default=True)
    # --- pricing (P10 M2) ---
    # In micro-CNY so cost arithmetic stays in integers: usage rows are summed
    # by the thousand and float cents would drift. Configuration, not code —
    # switching model or renegotiating a rate must not need a deploy.
    price_input_per_mtok = models.PositiveIntegerField(
        _("input price per million tokens (micro-CNY)"), default=0
    )
    price_output_per_mtok = models.PositiveIntegerField(
        _("output price per million tokens (micro-CNY)"), default=0
    )
    price_per_minute = models.PositiveIntegerField(
        _("audio price per minute (micro-CNY)"),
        default=0,
        help_text=_("Used by STT / TTS models, which are billed by duration."),
    )

    class Meta:
        verbose_name = _("AI model")
        verbose_name_plural = _("AI models")
        ordering = ("vendor", "capability", "sort_order", "code")
        unique_together = ("vendor", "capability", "code")

    def __str__(self) -> str:
        return f"{self.code} ({self.capability})"


class AIPrompt(BaseModel):
    """Prompt template offered to the AI assistant.

    Flat catalog — categories were removed to keep the catalog one
    dimension deep. Labels are unique so the admin can identify a prompt
    without a category prefix.
    """

    label = models.CharField(_("label"), max_length=128, unique=True)
    content = models.TextField(_("content"))
    sort_order = models.PositiveSmallIntegerField(_("sort order"), default=0)
    is_active = models.BooleanField(_("active"), default=True)

    class Meta:
        verbose_name = _("AI prompt")
        verbose_name_plural = _("AI prompts")
        ordering = ("sort_order", "label")

    def __str__(self) -> str:
        return self.label


class AIVoice(BaseModel):
    """Voice (TTS speaker) attached to a TTS or Omni model."""

    model = models.ForeignKey(
        AIModel,
        on_delete=models.CASCADE,
        related_name="voices",
        verbose_name=_("model"),
        limit_choices_to={
            "capability__in": (
                AIModel.Capability.TTS,
                AIModel.Capability.OMNI,
            )
        },
    )
    value = models.CharField(
        _("voice id"),
        max_length=128,
        help_text=_("The voice identifier sent to the provider API."),
    )
    label = models.CharField(
        _("display label"),
        max_length=128,
        help_text=_("Human-readable name shown in the UI."),
    )
    sort_order = models.PositiveSmallIntegerField(_("sort order"), default=0)
    is_active = models.BooleanField(_("active"), default=True)

    class Meta:
        verbose_name = _("AI voice")
        verbose_name_plural = _("AI voices")
        ordering = ("model", "sort_order", "label")
        unique_together = ("model", "value")

    def __str__(self) -> str:
        return f"{self.model.code} · {self.label}"


class AIAgentProfile(BaseModel):
    """Assembly preset = wire-level provider for the AI assistant.

    ``code`` is the identifier passed in the LiveKit job metadata and
    selected from the frontend (e.g. ``qwen``, ``doubao_s2s``,
    ``doubao_pipeline``). One profile groups the STT / VLM / LLM / TTS
    components (pipeline architecture) or a single Omni model (omni
    architecture) used by the agent worker.
    """

    class Architecture(models.TextChoices):
        PIPELINE = "pipeline", _("STT/LLM/TTS pipeline")
        OMNI = "omni", _("End-to-end omni-modal")

    class AgentType(models.TextChoices):
        AUDIO = "audio", _("Audio-only interactive agent")
        VIDEO = "video", _("Video-capable interactive agent")

    code = models.CharField(_("code"), max_length=64, unique=True)
    display_name = models.CharField(_("display name"), max_length=128)
    architecture = models.CharField(
        _("architecture"),
        max_length=16,
        choices=Architecture.choices,
    )
    # User-facing classification used by the client to route a call to the
    # right profile (voice-call vs video-call). Independent of ``architecture``
    # which is the wire-level pipeline shape consumed by the agent worker.
    agent_type = models.CharField(
        _("agent type"),
        max_length=8,
        choices=AgentType.choices,
        default=AgentType.AUDIO,
    )
    stt_model = models.ForeignKey(
        AIModel,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="profile_as_stt",
        limit_choices_to={"capability": AIModel.Capability.STT},
        verbose_name=_("STT model"),
    )
    tts_model = models.ForeignKey(
        AIModel,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="profile_as_tts",
        limit_choices_to={"capability": AIModel.Capability.TTS},
        verbose_name=_("TTS model"),
    )
    vlm_model = models.ForeignKey(
        AIModel,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="profile_as_vlm",
        limit_choices_to={"capability": AIModel.Capability.VLM},
        verbose_name=_("VLM model"),
    )
    llm_model = models.ForeignKey(
        AIModel,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="profile_as_llm",
        limit_choices_to={"capability": AIModel.Capability.LLM},
        verbose_name=_("LLM model"),
    )
    omni_model = models.ForeignKey(
        AIModel,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="profile_as_omni",
        limit_choices_to={"capability": AIModel.Capability.OMNI},
        verbose_name=_("omni model"),
    )
    default_voice = models.ForeignKey(
        AIVoice,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
        verbose_name=_("default voice"),
    )
    sort_order = models.PositiveSmallIntegerField(_("sort order"), default=0)
    is_active = models.BooleanField(_("active"), default=True)

    class Meta:
        verbose_name = _("AI agent profile")
        verbose_name_plural = _("AI agent profiles")
        ordering = ("sort_order", "code")

    def __str__(self) -> str:
        return self.display_name or self.code


# ---------------------------------------------------------------------------
# Transcripts (字幕落表)
#
# One row per FINAL_TRANSCRIPT event from the multi_user_transcriber agent.
# Used as the data source for RAG queries ("ask AI about this meeting") and
# for downstream summary / action-item extraction. Interim transcripts are
# never persisted — they are visual-only.
# ---------------------------------------------------------------------------


class Transcript(BaseModel):
    """A single finalised speech utterance captured from a room."""

    room = models.ForeignKey(
        Room,
        on_delete=models.CASCADE,
        related_name="transcripts",
        verbose_name=_("room"),
    )
    speaker_identity = models.CharField(
        _("speaker identity"),
        max_length=128,
        db_index=True,
        help_text=_("LiveKit participant.identity at the time of speaking."),
    )
    speaker_name = models.CharField(
        _("speaker name"),
        max_length=128,
        blank=True,
        default="",
        help_text=_("LiveKit participant.name (display name) at the time of speaking."),
    )
    text = models.TextField(_("text"))
    language = models.CharField(
        _("language"),
        max_length=16,
        blank=True,
        default="",
        help_text=_("ISO 639-1 language code reported by the STT engine."),
    )
    started_at = models.DateTimeField(_("speech started at"), db_index=True)
    ended_at = models.DateTimeField(_("speech ended at"), null=True, blank=True)
    translations = models.JSONField(
        _("translations"),
        default=dict,
        blank=True,
        help_text=_(
            "Best-effort translations into other languages, keyed by ISO "
            "code (e.g. ``{'en-us': '...', 'zh-cn': '...'}``). Written by "
            "the transcriber agent immediately after the FINAL transcript "
            "is captured; absence of a key means translation was not "
            "requested or failed."
        ),
    )

    class Meta:
        verbose_name = _("transcript")
        verbose_name_plural = _("transcripts")
        ordering = ("room", "started_at")
        indexes = [
            # No explicit name → Django auto-generates one that respects the
            # 30-char index-name limit. Don't add a fixed name back unless
            # you also keep it short (≤30 chars).
            models.Index(fields=["room", "started_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.speaker_identity}: {self.text[:60]}"


# ---------------------------------------------------------------------------
# Meeting summary + action items (Sprint 2.2.a)
#
# One Summary per Room run (latest replaces previous). ActionItem rows hang
# off both the Summary (1-N) and optionally a source Transcript for "why".
# Vectors (TranscriptEmbedding / SummaryEmbedding) are deferred to the
# pgvector enablement step; see ai_strategy.md §3.
# ---------------------------------------------------------------------------


class Summary(BaseModel):
    """A LLM-generated narrative summary of one meeting (one row per Room)."""

    class Status(models.TextChoices):
        PENDING = "pending", _("Pending")
        SUCCESS = "success", _("Success")
        FAILED = "failed", _("Failed")

    room = models.OneToOneField(
        Room,
        on_delete=models.CASCADE,
        related_name="summary",
        verbose_name=_("room"),
    )
    content = models.TextField(_("content"), blank=True, default="")
    model_used = models.CharField(
        _("model used"),
        max_length=128,
        blank=True,
        default="",
        help_text=_("LLM endpoint / model identifier that produced this summary."),
    )
    transcripts_count = models.PositiveIntegerField(
        _("transcripts count"),
        default=0,
        help_text=_(
            "How many Transcript rows fed into this summary. Useful for "
            "detecting when the summary went stale and needs a regen."
        ),
    )
    status = models.CharField(
        _("status"),
        max_length=16,
        choices=Status.choices,
        default=Status.PENDING,
    )
    error_message = models.TextField(_("error message"), blank=True, default="")
    # 纪要闭环 M2(D3)可编辑:AI 原文永存 content,人工编辑落副本。
    # effective_content = edited_content or content;空 = 未编辑。
    edited_content = models.TextField(_("edited content"), blank=True, default="")
    edited_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        related_name="edited_summaries",
        null=True,
        blank=True,
        verbose_name=_("edited by"),
    )
    edited_at = models.DateTimeField(_("edited at"), null=True, blank=True)
    # regen 只更新 content 与此时间戳,不动 edited_*;与 edited_at 比较得出
    # 「AI 原文已在你编辑后更新」提示(ai_updated_after_edit)。
    content_generated_at = models.DateTimeField(
        _("content generated at"), null=True, blank=True
    )

    class Meta:
        verbose_name = _("meeting summary")
        verbose_name_plural = _("meeting summaries")
        ordering = ("-updated_at",)

    @property
    def is_edited(self) -> bool:
        return bool(self.edited_content)

    @property
    def effective_content(self) -> str:
        return self.edited_content or self.content

    @property
    def ai_updated_after_edit(self) -> bool:
        return bool(
            self.edited_content
            and self.edited_at
            and self.content_generated_at
            and self.content_generated_at > self.edited_at
        )

    def __str__(self) -> str:
        return f"Summary({self.room_id}, {self.status})"


class ActionItem(BaseModel):
    """A single follow-up extracted by the LLM from the meeting transcript."""

    room = models.ForeignKey(
        Room,
        on_delete=models.CASCADE,
        related_name="action_items",
        verbose_name=_("room"),
    )
    summary = models.ForeignKey(
        Summary,
        on_delete=models.CASCADE,
        related_name="action_items",
        null=True,
        blank=True,
        verbose_name=_("summary"),
    )
    source_transcript = models.ForeignKey(
        "Transcript",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="action_items",
        verbose_name=_("source transcript"),
        help_text=_(
            "Transcript row the LLM cited as the source for this action item, "
            "if any. Optional — many items synthesise across multiple lines."
        ),
    )
    content = models.TextField(_("content"))
    owner_text = models.CharField(
        _("owner"),
        max_length=128,
        blank=True,
        default="",
        help_text=_(
            "Free-text owner as extracted by the LLM (e.g. 'John', '王总', "
            "'frontend team'). Not FK to User — matching is fuzzy at best."
        ),
    )
    due_text = models.CharField(
        _("due"),
        max_length=128,
        blank=True,
        default="",
        help_text=_("Free-text deadline (e.g. '下周五', 'before EOQ')."),
    )
    sort_order = models.PositiveSmallIntegerField(_("sort order"), default=0)
    is_completed = models.BooleanField(_("completed"), default=False)

    class Meta:
        verbose_name = _("action item")
        verbose_name_plural = _("action items")
        ordering = ("room", "sort_order", "created_at")

    def __str__(self) -> str:
        owner = f"[{self.owner_text}] " if self.owner_text else ""
        return f"{owner}{self.content[:80]}"


class SummaryChapter(BaseModel):
    """智能章节(纪要闭环 P0-3 D1):LLM 按话题切分的会议时间轴段落。

    与 ActionItem 同生命周期——``_persist`` 事务内全删重建,regen 幂等。
    时间窗来自转写时间戳(``[HH:MM:SS]`` 由 LLM 回填,服务端按转写首条
    日期锚点还原为 aware datetime,跨零点单调修正)。
    """

    room = models.ForeignKey(
        Room,
        on_delete=models.CASCADE,
        related_name="summary_chapters",
        verbose_name=_("room"),
    )
    summary = models.ForeignKey(
        Summary,
        on_delete=models.CASCADE,
        related_name="chapters",
        verbose_name=_("summary"),
    )
    title = models.CharField(_("title"), max_length=200)
    digest = models.TextField(
        _("digest"),
        blank=True,
        default="",
        help_text=_("1-3 sentence gist of this chapter."),
    )
    started_at = models.DateTimeField(_("started at"), null=True, blank=True)
    ended_at = models.DateTimeField(_("ended at"), null=True, blank=True)
    sort_order = models.PositiveSmallIntegerField(_("sort order"), default=0)

    class Meta:
        db_table = "meet_summary_chapter"
        verbose_name = _("summary chapter")
        verbose_name_plural = _("summary chapters")
        ordering = ("room", "sort_order", "created_at")

    def __str__(self) -> str:
        return f"Chapter({self.sort_order}, {self.title[:40]})"


class TranscriptChunk(BaseModel):
    """A retrieval unit for cross-meeting RAG (Sprint 2.4).

    One row groups several consecutive ``Transcript`` utterances by the
    same speaker (or a sliding window thereof) plus the dense vector
    embedding of that text. Lookup at query time is: filter by user's
    accessible rooms, then numpy cosine top-K on the embedding column —
    no pgvector dependency. See docs/features/personal_ai_rag.md for
    the rationale (path D).

    Lifecycle:
        * Written by the ``embed_meeting_transcripts`` Celery task,
          chained after a successful ``generate_meeting_summary``.
        * Re-run idempotent: the task deletes existing chunks for the
          room before inserting fresh ones, so Summary regenerations
          stay in sync.
    """

    room = models.ForeignKey(
        Room,
        on_delete=models.CASCADE,
        related_name="chunks",
        verbose_name=_("room"),
    )
    summary = models.ForeignKey(
        Summary,
        on_delete=models.CASCADE,
        related_name="chunks",
        null=True,
        blank=True,
        verbose_name=_("summary"),
        help_text=_(
            "Summary generation this chunk-set belongs to. Null only "
            "for chunks produced by direct backfill before Summary v2."
        ),
    )
    chunk_index = models.PositiveIntegerField(
        _("chunk index"),
        help_text=_("0-based ordinal within the room, stable across re-embeds."),
    )
    speaker_identity = models.CharField(
        _("speaker identity"),
        max_length=128,
        blank=True,
        default="",
    )
    speaker_name = models.CharField(
        _("speaker name"),
        max_length=128,
        blank=True,
        default="",
    )
    text = models.TextField(_("text"))
    started_at = models.DateTimeField(_("speech started at"))
    ended_at = models.DateTimeField(_("speech ended at"), null=True, blank=True)
    source_transcript_ids = ArrayField(
        models.UUIDField(),
        default=list,
        blank=True,
        verbose_name=_("source transcript ids"),
        help_text=_(
            "UUIDs of the Transcript rows aggregated into this chunk. "
            "Audit trail for citation rendering; not enforced FKs so a "
            "deleted Transcript doesn't kill its chunk."
        ),
    )
    embedding = models.JSONField(
        _("embedding"),
        default=list,
        help_text=_(
            "Dense vector as a list of floats. Length depends on the "
            "embedding model (Doubao text-embedding-large = 1024). "
            "Stored as JSON to avoid the pgvector dependency; the "
            "service layer pulls these into numpy at query time."
        ),
    )
    embedding_model = models.CharField(
        _("embedding model"),
        max_length=64,
        blank=True,
        default="",
        help_text=_(
            "Doubao embedding endpoint id (ep-...) used at write time. "
            "Lets us spot mixed-model chunks during a model migration."
        ),
    )

    class Meta:
        verbose_name = _("transcript chunk")
        verbose_name_plural = _("transcript chunks")
        ordering = ("room", "chunk_index")
        indexes = [
            # Hot path: load all chunks for a set of user-accessible
            # rooms. (room_id, chunk_index) covers both filter & sort.
            models.Index(fields=["room", "chunk_index"]),
            models.Index(fields=["summary"]),
        ]

    def __str__(self) -> str:
        speaker = self.speaker_name or self.speaker_identity[:12] or "?"
        preview = self.text[:60]
        return f"#{self.chunk_index} {speaker}: {preview}"


# ---- P5: meeting ↔ jusi-light-im group bridge ----


class MeetingConversation(BaseModel):
    """1:1 mapping between a Room and its jusi-light-im group conversation.

    `cid` is deterministic from `room_id` (UUIDv5) — this is what makes our
    ensure-group endpoint naturally idempotent: concurrent calls converge to the
    same `cid` without any explicit locking.

    Room ON DELETE SET NULL: removing a Room does NOT delete the IM conversation
    — the chat history persists so "after-meeting discussion" stays available
    (this is jusi-light-im's whole value-add on top of LiveKit).
    """

    room = models.OneToOneField(
        Room,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="im_conversation",
        help_text=_("the meeting room this conversation was created for"),
    )
    cid = models.CharField(
        max_length=64,
        unique=True,
        help_text=_("jusi-light-im conversation id (UUIDv5 from room id)"),
    )
    summary_pushed_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text=_(
            "set when the meeting summary has been posted as a system message to the "
            "conversation — read by the summary push hook to avoid duplicate sends"
        ),
    )

    class Meta:
        db_table = "meet_meeting_conversation"
        verbose_name = _("Meeting conversation")
        verbose_name_plural = _("Meeting conversations")

    @staticmethod
    def cid_for_room(room_id) -> str:
        """Deterministic cid for a room. Stable across processes / restarts."""
        return str(uuid.uuid5(uuid.NAMESPACE_OID, f"jusi-light-im:room:{room_id}"))

    def __str__(self) -> str:
        room_repr = str(self.room_id) if self.room_id else "<orphan>"
        return f"MeetingConversation room={room_repr} cid={self.cid}"


# ---- P3: meeting ↔ La Suite Docs document bridge ----


class MeetingDoc(BaseModel):
    """1:1 mapping between a Room and its La Suite Docs document (P3 妙记落 Doc).

    Created when a meeting Summary is pushed to Docs via the server-to-server
    ``create-for-owner`` endpoint. Mirrors MeetingConversation: Room ON DELETE
    SET NULL so the document outlives the room (the doc is the lasting artefact).
    The row's existence is the idempotency guard for the summary→doc push — once a
    MeetingDoc exists for a room, the push hook no-ops.
    """

    room = models.OneToOneField(
        Room,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="meeting_doc",
        help_text=_("the meeting room this document was created for"),
    )
    doc_id = models.CharField(
        max_length=64,
        unique=True,
        help_text=_("La Suite Docs document id"),
    )
    doc_url = models.URLField(
        max_length=512,
        help_text=_("deep link to the document on the Docs site"),
    )

    class Meta:
        db_table = "meet_meeting_doc"
        verbose_name = _("Meeting document")
        verbose_name_plural = _("Meeting documents")

    def __str__(self) -> str:
        room_repr = str(self.room_id) if self.room_id else "<orphan>"
        return f"MeetingDoc room={room_repr} doc={self.doc_id}"


# ---------------------------------------------------------------------------
# Organization / Department / Membership  (P1 — 企业组织架构地基)
#
# Additive enterprise org layer the to-B roadmap depends on. Nothing here
# touches BaseAccess / ResourceAccess: a Department exposes a stable, opaque
# ``team_key`` (``dept:<uuid>``) that is written verbatim into
# ``BaseAccess.team`` (max_length=100). Existing team-based access filtering
# (BaseAccessManager.filter_user) lights up automatically once
# ``User.get_teams()`` returns these keys — see the data migration that
# backfills a default organization + one membership per existing user.
# ---------------------------------------------------------------------------


#: Prefixes for the opaque keys stored verbatim in ``BaseAccess.team``. Defined
#: here so the set of grant subjects is enumerable in one place — a grant row
#: carries only a string, so a typo'd prefix is a silently dead ACL entry rather
#: than an error. The write path whitelists exactly these.
TEAM_PREFIX_DEPT = "dept:"
TEAM_PREFIX_GROUP = "group:"
TEAM_PREFIXES = (TEAM_PREFIX_DEPT, TEAM_PREFIX_GROUP)


class OrgRoleChoices(models.TextChoices):
    """Role of a user *within an organization* (distinct from per-resource RoleChoices).

    Values intentionally overlap RoleChoices where they coincide (member /
    administrator / owner) so admin tooling can reuse the same vocabulary; the
    extra ``dept_admin`` scopes administration to a department subtree.
    """

    MEMBER = "member", _("Member")
    DEPT_ADMIN = "dept_admin", _("Department administrator")
    ADMIN = "administrator", _("Organization administrator")
    OWNER = "owner", _("Organization owner")


class MembershipStatusChoices(models.TextChoices):
    """Lifecycle of a user's membership in an organization."""

    ACTIVE = "active", _("Active")
    INVITED = "invited", _("Invited")
    SUSPENDED = "suspended", _("Suspended")
    LEFT = "left", _("Left")


class SourceChoices(models.TextChoices):
    """How an org row got here — shared by Department / Membership / UserGroup.

    Lets the console tell hand-made rows from imported ones (飞书 calls this
    column 来源), which is what makes a bad bulk import reviewable instead of
    indistinguishable from manual work.
    """

    MANUAL = "manual", _("Created manually")
    IMPORT = "import", _("Bulk import")
    API = "api", _("Open API")
    SYNC = "sync", _("External sync")
    INVITE = "invite", _("Created by invitation")


class DictScopeChoices(models.TextChoices):
    """Which per-organization option list an ``OrgDictItem`` belongs to."""

    EMPLOYEE_TYPE = "employee_type", _("Employee type")
    JOB_LEVEL = "job_level", _("Job level")
    JOB_SEQUENCE = "job_sequence", _("Job sequence")
    ONBOARD_TYPE = "onboard_type", _("Onboarding type")
    PROBATION_STATUS = "probation_status", _("Probation status")
    LEAVE_REASON = "leave_reason", _("Leave reason")


class OrgDictItem(BaseModel):
    """A customer-editable option in one of the organization's dictionaries.

    Deliberately a table, not an enum: every customer renames these (职级1 vs
    P5) and adds their own (返聘 / 兼职), and changing an enum means a release
    plus a migration. Deliberately not a JSON list on ``Organization.settings``
    either: ``Membership.employee_type`` and friends point at these rows, so
    deleting 实习 must be answerable with "3 people still hold it" rather than
    leaving dangling strings behind.

    ``code`` is the stable identifier code branches on; ``label`` is what the
    customer sees and may rename freely.
    """

    # String reference: this model is declared above ``Organization`` so the
    # dictionary choices sit next to the other org enums.
    organization = models.ForeignKey(
        "Organization", on_delete=models.CASCADE, related_name="dict_items"
    )
    scope = models.CharField(max_length=32, choices=DictScopeChoices.choices)
    code = models.CharField(max_length=64)
    label = models.CharField(max_length=64)
    sort_order = models.PositiveIntegerField(default=0)
    is_builtin = models.BooleanField(
        default=False,
        help_text=_(
            "Seeded option: the label may be renamed but it cannot be deleted."
        ),
    )
    is_active = models.BooleanField(default=True)

    class Meta:
        db_table = "meet_org_dict_item"
        ordering = ("scope", "sort_order", "code")
        verbose_name = _("Organization dictionary item")
        verbose_name_plural = _("Organization dictionary items")
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "scope", "code"],
                name="dict_item_unique_org_scope_code",
                violation_error_message=_(
                    "This organization already has an option with this code."
                ),
            ),
        ]

    def __str__(self):
        return f"{self.get_scope_display()}: {self.label}"


class Organization(BaseModel):
    """An enterprise tenant.

    MVP runs a single bootstrapped organization, but the FK is present on every
    org-scoped row from day one so onboarding a second tenant never requires a
    painful backfill. Directory / admin querysets filter by the caller's
    organization even while only one exists.
    """

    name = models.CharField(_("name"), max_length=255)
    slug = models.SlugField(_("slug"), max_length=100, unique=True)
    primary_domain = models.CharField(
        _("primary email domain"),
        max_length=255,
        blank=True,
        default="",
        help_text=_(
            "Primary email domain (e.g. 'example.com'). Used to auto-place "
            "invited members whose email matches."
        ),
    )
    is_active = models.BooleanField(_("active"), default=True)
    settings = models.JSONField(_("settings"), blank=True, default=dict)

    class Meta:
        db_table = "meet_organization"
        ordering = ("name",)
        verbose_name = _("Organization")
        verbose_name_plural = _("Organizations")

    def __str__(self):
        return self.name


class Department(BaseModel):
    """A node in an organization's department tree.

    Adjacency list (``parent``) plus a materialized ``path`` of ancestor ids so
    a subtree is a single ``path__startswith`` lookup with no MPTT dependency.
    ``team_key`` / ``path`` / ``depth`` are maintained in ``save()``; reparenting
    a department (which must rewrite descendant paths) is handled by the admin
    console, not here.
    """

    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="departments"
    )
    parent = models.ForeignKey(
        "self",
        on_delete=models.CASCADE,
        related_name="children",
        null=True,
        blank=True,
    )
    name = models.CharField(_("name"), max_length=255)
    # Slash-joined ancestor ids INCLUDING self (e.g. "<root>/<child>/"). A node's
    # whole subtree (self included) is `filter(path__startswith=node.path)`.
    path = models.CharField(
        _("path"), max_length=1024, blank=True, default="", db_index=True
    )
    depth = models.PositiveIntegerField(_("depth"), default=0)
    head = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        related_name="headed_departments",
        null=True,
        blank=True,
        help_text=_("Department head — the default approver for org workflows."),
    )
    sort_order = models.PositiveIntegerField(_("sort order"), default=0)
    # Opaque, immutable key written verbatim into BaseAccess.team (<=100 chars).
    # Derived from the row id so it is unique, rename-safe and collision-free.
    team_key = models.CharField(
        _("team key"), max_length=100, unique=True, editable=False
    )
    # Customer-facing external identifier (飞书's 部门ID) used to match rows when
    # importing or syncing from an HR system. Distinct from ``team_key``, which
    # must never change because historical BaseAccess rows carry it verbatim;
    # ``code`` is free to be edited.
    code = models.CharField(_("department code"), max_length=64, blank=True, default="")
    source = models.CharField(
        max_length=16, choices=SourceChoices.choices, default=SourceChoices.MANUAL
    )
    is_active = models.BooleanField(_("active"), default=True)
    deleted_at = models.DateTimeField(_("deleted at"), null=True, blank=True)

    class Meta:
        db_table = "meet_department"
        ordering = ("path", "sort_order", "name")
        verbose_name = _("Department")
        verbose_name_plural = _("Departments")
        constraints = [
            # Partial: only non-blank codes are unique, and only among live rows
            # (a soft-deleted department must not squat on its code forever).
            models.UniqueConstraint(
                fields=["organization", "code"],
                condition=~models.Q(code="") & models.Q(deleted_at__isnull=True),
                name="department_unique_org_code",
                violation_error_message=_(
                    "This organization already has a department with this code."
                ),
            ),
        ]

    def __str__(self):
        return self.name

    def save(self, *args, **kwargs):
        # _refresh_tree_fields() must run BEFORE super().save(): BaseModel.save()
        # calls full_clean(), and team_key is required (non-blank).
        self._refresh_tree_fields()
        super().save(*args, **kwargs)

    def _refresh_tree_fields(self):
        """Derive team_key / path / depth from this row's id and its parent.

        Only updates this node — descendant path rewrites on reparent are the
        admin console's job.
        """
        if not self.team_key:
            self.team_key = f"{TEAM_PREFIX_DEPT}{self.id.hex}"
        if self.parent_id:
            self.path = f"{self.parent.path}{self.id.hex}/"
            self.depth = self.parent.depth + 1
        else:
            self.path = f"{self.id.hex}/"
            self.depth = 0


class Membership(BaseModel):
    """Links a user to an organization, and optionally to a department."""

    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="memberships"
    )
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="memberships")
    department = models.ForeignKey(
        Department,
        on_delete=models.SET_NULL,
        related_name="memberships",
        null=True,
        blank=True,
        help_text=_("Null means an organization-level membership (no department)."),
    )
    title = models.CharField(_("title"), max_length=255, blank=True, default="")
    is_primary = models.BooleanField(
        _("primary"),
        default=False,
        help_text=_("The user's primary department within the organization."),
    )
    org_role = models.CharField(
        max_length=20, choices=OrgRoleChoices.choices, default=OrgRoleChoices.MEMBER
    )
    employee_no = models.CharField(max_length=64, blank=True, default="")
    status = models.CharField(
        max_length=20,
        choices=MembershipStatusChoices.choices,
        default=MembershipStatusChoices.ACTIVE,
    )
    joined_at = models.DateTimeField(null=True, blank=True)

    # --- work profile (P10 M1) ---------------------------------------------
    # These live on Membership, not User: every one of them describes the
    # *employment relationship* inside one organization, so a future second
    # tenant cannot cross-contaminate them.
    employee_type = models.ForeignKey(
        OrgDictItem,
        on_delete=models.SET_NULL,
        related_name="+",
        null=True,
        blank=True,
        limit_choices_to={"scope": DictScopeChoices.EMPLOYEE_TYPE},
    )
    job_level = models.ForeignKey(
        OrgDictItem,
        on_delete=models.SET_NULL,
        related_name="+",
        null=True,
        blank=True,
        limit_choices_to={"scope": DictScopeChoices.JOB_LEVEL},
    )
    job_sequence = models.ForeignKey(
        OrgDictItem,
        on_delete=models.SET_NULL,
        related_name="+",
        null=True,
        blank=True,
        limit_choices_to={"scope": DictScopeChoices.JOB_SEQUENCE},
    )
    # Reporting lines point at Membership, not User: "A reports to B" is a
    # statement about two people *within one organization*. A User→User FK would
    # silently follow someone into a second tenant where it is not true.
    manager = models.ForeignKey(
        "self",
        on_delete=models.SET_NULL,
        related_name="direct_reports",
        null=True,
        blank=True,
    )
    dotted_manager = models.ForeignKey(
        "self",
        on_delete=models.SET_NULL,
        related_name="dotted_reports",
        null=True,
        blank=True,
        help_text=_("Dotted-line manager. Never used for automatic approval routing."),
    )
    hire_date = models.DateField(null=True, blank=True)
    work_country = models.CharField(
        max_length=2, blank=True, default="", help_text=_("ISO 3166-1 alpha-2.")
    )
    work_city = models.CharField(max_length=64, blank=True, default="")
    alias = models.CharField(max_length=64, blank=True, default="")
    work_station = models.CharField(max_length=64, blank=True, default="")
    extension = models.CharField(max_length=16, blank=True, default="")
    source = models.CharField(
        max_length=16, choices=SourceChoices.choices, default=SourceChoices.MANUAL
    )

    # --- offboarding (P10 M1) ----------------------------------------------
    left_at = models.DateTimeField(null=True, blank=True, db_index=True)
    left_reason = models.CharField(max_length=64, blank=True, default="")
    # Frozen copy of the org facts at offboard time. Departments get renamed and
    # soft-deleted, so the console's "department before leaving" column cannot be
    # a live JOIN. Days-since-leaving is computed from ``left_at`` and never
    # stored — it would need rewriting every night.
    left_snapshot = models.JSONField(default=dict, blank=True)

    class Meta:
        db_table = "meet_membership"
        ordering = ("-created_at",)
        verbose_name = _("Membership")
        verbose_name_plural = _("Memberships")
        constraints = [
            models.UniqueConstraint(
                fields=["user", "department"],
                name="membership_unique_user_department",
                violation_error_message=_(
                    "This user already belongs to this department."
                ),
            ),
            models.UniqueConstraint(
                fields=["user", "organization"],
                condition=models.Q(is_primary=True),
                name="membership_one_primary_per_user_org",
                violation_error_message=_(
                    "A user can have only one primary department per organization."
                ),
            ),
            models.UniqueConstraint(
                fields=["organization", "employee_no"],
                condition=~models.Q(employee_no=""),
                name="membership_unique_employee_no",
                violation_error_message=_(
                    "This employee number is already used in this organization."
                ),
            ),
            models.CheckConstraint(
                condition=~models.Q(manager=models.F("id")),
                name="membership_manager_not_self",
                violation_error_message=_("A member cannot be their own manager."),
            ),
        ]
        indexes = [
            models.Index(fields=["organization", "status", "employee_type"]),
            models.Index(fields=["organization", "status", "left_at"]),
            models.Index(fields=["manager"]),
        ]

    def __str__(self):
        dept = self.department.name if self.department_id else "<org-level>"
        return f"{self.user} @ {dept} ({self.get_org_role_display()})"

    # Bounds the manager walk. Deep enough for any real hierarchy, shallow
    # enough that a cycle which somehow reached the database still terminates.
    MAX_MANAGER_DEPTH = 32

    def clean(self):
        """Validate reporting lines: same organization, and no cycles.

        The DB check constraint only catches self-reference; A→B→A needs a walk.
        Only the solid line is validated — dotted lines are allowed to cross and
        never drive automatic routing.
        """
        super().clean()
        errors = {}

        for field in ("manager", "dotted_manager"):
            other = getattr(self, field, None)
            if other is not None and other.organization_id != self.organization_id:
                errors[field] = _("The manager must belong to the same organization.")

        if self.manager_id and self.manager_id == self.pk:
            errors["manager"] = _("A member cannot be their own manager.")
        elif self.manager_id:
            seen = {self.pk} if self.pk else set()
            node_id, hops = self.manager_id, 0
            while node_id is not None and hops < self.MAX_MANAGER_DEPTH:
                if node_id in seen:
                    errors["manager"] = _("This would create a reporting-line cycle.")
                    break
                seen.add(node_id)
                node_id = (
                    Membership.objects.filter(pk=node_id)
                    .values_list("manager_id", flat=True)
                    .first()
                )
                hops += 1

        if errors:
            raise ValidationError(errors)

    def build_left_snapshot(self) -> dict:
        """Freeze the org facts the offboarded list needs after live rows move on.

        Departments get renamed and soft-deleted and managers get reassigned, so
        "which department were they in when they left" cannot be a JOIN.
        """
        department = self.department
        manager = self.manager
        return {
            "department_id": str(self.department_id) if self.department_id else None,
            "department_name": department.name if department else "",
            "department_path": department.path if department else "",
            "title": self.title,
            "org_role": self.org_role,
            "employee_no": self.employee_no,
            "employee_type_label": (
                self.employee_type.label if self.employee_type_id else ""
            ),
            "manager_id": str(self.manager_id) if self.manager_id else None,
            "manager_name": (
                manager.user.full_name or manager.user.short_name or ""
                if manager
                else ""
            ),
        }


class UserGroup(BaseModel):
    """A named set of people that can be granted access as a unit (P10 M2).

    Deliberately reuses the existing team-grant plumbing rather than introducing
    a second authorization model: the group exposes an opaque ``group_key``
    (``group:<hex>``) that goes verbatim into ``BaseAccess.team``, exactly the
    way a department's ``team_key`` does. ``User.get_teams()`` returns both, so
    every team-aware queryset lights up with no viewset change.

    ⚠️ Scope of that "for free": today the only concrete ``BaseAccess`` subclass
    is ``RecordingAccess``. Rooms use ``ResourceAccess``, which is a plain
    ``BaseModel`` with no ``team`` column — see ``get_resource_roles``. Granting
    a *room* to a group needs its own table and is not covered here.

    Membership is explicit rows, not a rule. Dynamic (rule-driven) groups are
    deferred: static covers the common cases, and a rule engine wants to share
    its evaluator with department-group membership rules, which do not exist yet.
    """

    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="user_groups"
    )
    name = models.CharField(_("name"), max_length=128)
    description = models.CharField(
        _("description"), max_length=255, blank=True, default=""
    )
    # Opaque and immutable for the same reason as Department.team_key: historical
    # grant rows carry the string verbatim, so a rename must never invalidate it.
    group_key = models.CharField(
        _("group key"), max_length=100, unique=True, editable=False
    )
    source = models.CharField(
        max_length=16, choices=SourceChoices.choices, default=SourceChoices.MANUAL
    )
    is_active = models.BooleanField(_("active"), default=True)
    deleted_at = models.DateTimeField(_("deleted at"), null=True, blank=True)

    class Meta:
        db_table = "meet_user_group"
        ordering = ("name",)
        verbose_name = _("User group")
        verbose_name_plural = _("User groups")
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "name"],
                condition=models.Q(deleted_at__isnull=True),
                name="user_group_unique_org_name",
                violation_error_message=_(
                    "This organization already has a group with this name."
                ),
            ),
        ]

    def __str__(self):
        return self.name

    def save(self, *args, **kwargs):
        # Before super(): BaseModel.save() runs full_clean() and group_key is
        # non-blank. Mirrors Department.save().
        if not self.group_key:
            self.group_key = f"{TEAM_PREFIX_GROUP}{self.id.hex}"
        super().save(*args, **kwargs)


class UserGroupMember(BaseModel):
    """One person's membership of a :class:`UserGroup`."""

    group = models.ForeignKey(
        UserGroup, on_delete=models.CASCADE, related_name="members"
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="user_group_memberships",
    )
    added_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )

    class Meta:
        db_table = "meet_user_group_member"
        ordering = ("-created_at",)
        verbose_name = _("User group member")
        verbose_name_plural = _("User group members")
        constraints = [
            models.UniqueConstraint(
                fields=["group", "user"],
                name="user_group_member_unique",
                violation_error_message=_("This person is already in the group."),
            ),
        ]
        indexes = [
            # get_teams() reads by user on every authenticated request that
            # touches a team-aware queryset — this index is that query's plan.
            models.Index(fields=["user"], name="ugm_user_idx"),
        ]

    def __str__(self):
        return f"{self.user} in {self.group}"


class AIUsageKindChoices(models.TextChoices):
    """Which product surface spent the tokens."""

    SUMMARY = "summary", _("Meeting summary")
    GLOBAL_ASK = "global_ask", _("Ask across content")
    PERSONAL_AI = "personal_ai", _("Personal assistant")
    ROOM_AI = "room_ai", _("In-meeting assistant")
    OTHER = "other", _("Other")


class AIUsageRecord(BaseModel):
    """One billable AI call (P10 M2).

    we-meet's LLM/ASR/TTS spend is real money, not a virtual allowance — which
    is exactly why this is worth doing properly: without per-call attribution
    there is no way to tell a runaway prompt from ordinary growth until the
    invoice arrives.

    ``cost_micros`` is computed from :class:`AIModel`'s price columns at write
    time and then frozen. Recomputing later from current prices would silently
    rewrite history every time a rate is renegotiated.
    """

    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name="ai_usage",
        null=True,
        blank=True,
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    kind = models.CharField(
        max_length=16,
        choices=AIUsageKindChoices.choices,
        default=AIUsageKindChoices.OTHER,
    )
    #: The provider's model string as sent on the wire, not an FK: the record
    #: must stay readable after a model row is renamed or removed.
    model_code = models.CharField(max_length=128, blank=True, default="")
    ref_type = models.CharField(max_length=32, blank=True, default="")
    ref_id = models.CharField(max_length=64, blank=True, default="")
    input_tokens = models.PositiveIntegerField(default=0)
    output_tokens = models.PositiveIntegerField(default=0)
    audio_seconds = models.PositiveIntegerField(default=0)
    cost_micros = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "meet_ai_usage_record"
        ordering = ("-created_at",)
        verbose_name = _("AI usage record")
        verbose_name_plural = _("AI usage records")
        indexes = [
            models.Index(
                fields=["organization", "-created_at"], name="ai_usage_org_time_idx"
            ),
            models.Index(fields=["user", "-created_at"], name="ai_usage_user_time_idx"),
        ]

    def __str__(self):
        return f"{self.kind} {self.model_code} {self.cost_micros}µ"


class UserDailyActivity(BaseModel):
    """Per-person, per-day module activity counters (P10 M2).

    Six integer columns rather than one JSONB ``modules`` map: ``F("im_count")
    + 1`` is an atomic increment, whereas a JSONB map has to be read, modified
    and written back — which races itself the moment two requests land in the
    same second. Aggregating and indexing are also direct.
    """

    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="daily_activity"
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+"
    )
    date = models.DateField()
    im_count = models.PositiveIntegerField(default=0)
    meeting_count = models.PositiveIntegerField(default=0)
    calendar_count = models.PositiveIntegerField(default=0)
    docs_count = models.PositiveIntegerField(default=0)
    approval_count = models.PositiveIntegerField(default=0)
    ai_count = models.PositiveIntegerField(default=0)
    last_seen_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "meet_user_daily_activity"
        ordering = ("-date",)
        verbose_name = _("User daily activity")
        verbose_name_plural = _("User daily activity")
        constraints = [
            models.UniqueConstraint(
                fields=["user", "date"], name="user_daily_activity_unique"
            ),
        ]
        indexes = [
            models.Index(
                fields=["organization", "-date"], name="activity_org_date_idx"
            ),
        ]

    def __str__(self):
        return f"{self.user_id} {self.date}"


class ImportJobStatusChoices(models.TextChoices):
    """Lifecycle of a member-import job."""

    PENDING = "pending", _("Queued for preflight")
    PREVIEWING = "previewing", _("Checking the file")
    PREVIEWED = "previewed", _("Checked — awaiting confirmation")
    APPLYING = "applying", _("Applying")
    DONE = "done", _("Applied")
    PARTIAL = "partial", _("Applied with errors")
    FAILED = "failed", _("Failed")


class ImportJob(BaseModel):
    """One bulk member import, in two explicit phases (P10 M2).

    Preflight and apply are separate rows-states, not separate requests against
    a stateless parser, because the admin must be able to *read the diff before
    it happens*. A single-shot importer that reports what it did after the fact
    is how a 400-person directory gets silently reshaped by a mis-mapped column.

    ``rows`` holds the parsed preview: one entry per source line with its
    resolved action (create / update / rehire / error) and messages. Kept as
    JSON rather than a table because it is written once, read a handful of
    times, and is meaningless outside its job.
    """

    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="import_jobs"
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    filename = models.CharField(_("file name"), max_length=255, blank=True, default="")
    status = models.CharField(
        max_length=16,
        choices=ImportJobStatusChoices.choices,
        default=ImportJobStatusChoices.PENDING,
    )
    #: Raw CSV text, kept until the job is applied so the apply phase parses the
    #: exact bytes that were previewed — re-uploading between the two phases is
    #: the obvious way to make a confirmed preview lie.
    source = models.TextField(blank=True, default="")
    #: Whether departments named in the file but absent from the tree should be
    #: created instead of failing their rows.
    create_missing_departments = models.BooleanField(default=False)
    rows = models.JSONField(default=list, blank=True)
    summary = models.JSONField(default=dict, blank=True)
    error = models.CharField(max_length=500, blank=True, default="")
    applied_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "meet_import_job"
        ordering = ("-created_at",)
        verbose_name = _("Import job")
        verbose_name_plural = _("Import jobs")
        indexes = [
            models.Index(
                fields=["organization", "-created_at"], name="import_job_org_idx"
            ),
        ]

    def __str__(self):
        return f"{self.filename or 'import'} ({self.status})"


class AdminScopeChoices(models.TextChoices):
    """How wide an admin-role assignment reaches."""

    ALL = "all", _("Whole organization")
    DEPARTMENTS = "departments", _("Selected departments")


class AdminRole(BaseModel):
    """A named bundle of administrative permissions (P10 M2).

    Replaces the ``OrgRoleChoices.DEPT_ADMIN`` idea rather than reviving it.
    That enum value has never been a permission check anywhere in the codebase;
    resurrecting it would leave two sources of administrative truth (an enum on
    the membership and a role table) which must eventually disagree. The enum
    stays in ``choices`` so historical rows keep validating, but nothing reads
    it for authorization.

    ``permissions`` is a JSON list of codes from ``core.permissions_registry``.
    Validated on write — an unknown code is worse than an error, because the
    console would render it as a granted right that does nothing.
    """

    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="admin_roles"
    )
    name = models.CharField(_("name"), max_length=64)
    code = models.SlugField(_("code"), max_length=40)
    description = models.CharField(
        _("description"), max_length=255, blank=True, default=""
    )
    permissions = models.JSONField(_("permissions"), default=list, blank=True)
    is_builtin = models.BooleanField(_("built-in"), default=False)
    is_active = models.BooleanField(_("active"), default=True)

    class Meta:
        db_table = "meet_admin_role"
        ordering = ("-is_builtin", "name")
        verbose_name = _("Admin role")
        verbose_name_plural = _("Admin roles")
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "code"],
                name="admin_role_unique_org_code",
                violation_error_message=_(
                    "This organization already has a role with this code."
                ),
            ),
        ]

    def __str__(self):
        return self.name


class AdminRoleAssignment(BaseModel):
    """Grants one :class:`AdminRole` to one membership, optionally scoped.

    Scope is stored as departments, and expanded to ``Department.path``
    prefixes at check time — the subtree of a scoped department is in scope,
    because "administers Engineering" that stops at its direct children would
    be useless for any org with more than two levels.
    """

    role = models.ForeignKey(
        AdminRole, on_delete=models.CASCADE, related_name="assignments"
    )
    membership = models.ForeignKey(
        "Membership", on_delete=models.CASCADE, related_name="admin_role_assignments"
    )
    scope_type = models.CharField(
        max_length=16,
        choices=AdminScopeChoices.choices,
        default=AdminScopeChoices.ALL,
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )

    class Meta:
        db_table = "meet_admin_role_assignment"
        ordering = ("-created_at",)
        verbose_name = _("Admin role assignment")
        verbose_name_plural = _("Admin role assignments")
        constraints = [
            models.UniqueConstraint(
                fields=["role", "membership"],
                name="admin_role_assignment_unique",
                violation_error_message=_("This person already holds this role."),
            ),
        ]
        indexes = [
            # Every permission check for a non-owner starts here.
            models.Index(fields=["membership"], name="admin_role_asg_member_idx"),
        ]

    def __str__(self):
        return f"{self.membership_id} as {self.role_id}"


class AdminRoleScopeDepartment(BaseModel):
    """One department in a ``scope_type='departments'`` assignment's scope."""

    assignment = models.ForeignKey(
        AdminRoleAssignment, on_delete=models.CASCADE, related_name="scope_departments"
    )
    department = models.ForeignKey(
        "Department", on_delete=models.CASCADE, related_name="+"
    )

    class Meta:
        db_table = "meet_admin_role_scope_department"
        verbose_name = _("Admin role scope department")
        verbose_name_plural = _("Admin role scope departments")
        constraints = [
            models.UniqueConstraint(
                fields=["assignment", "department"],
                name="admin_role_scope_unique",
            ),
        ]

    def __str__(self):
        return f"{self.assignment_id} → {self.department_id}"


# --- P2 日历 / 日程 ---


class EventStatusChoices(models.TextChoices):
    """Lifecycle of a calendar event."""

    CONFIRMED = "confirmed", _("Confirmed")
    CANCELLED = "cancelled", _("Cancelled")


class EventVisibilityChoices(models.TextChoices):
    """Per-event override on top of the personal calendar's access level."""

    DEFAULT = "default", _("Default")
    PUBLIC = "public", _("Public")
    PRIVATE = "private", _("Private")


class CalendarAccessChoices(models.TextChoices):
    """A calendar member's effective role, ordered from least to most power."""

    NONE = "none", _("Not shared")
    FREE_BUSY = "free_busy", _("Free/busy only")
    DETAILS = "details", _("Event details")
    WRITER = "writer", _("Can edit events")
    ADMIN = "admin", _("Calendar administrator")


class CalendarKindChoices(models.TextChoices):
    PRIMARY = "primary", _("Primary calendar")
    SHARED = "shared", _("Shared calendar")
    RESOURCE = "resource", _("Resource calendar")


class Calendar(BaseModel):
    """A first-class calendar while preserving the legacy personal-calendar table.

    ``primary`` rows retain the old one-per-membership behaviour. ``shared``
    rows own collaborative events, and ``resource`` rows project meeting-room
    bookings.
    """

    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="personal_calendars"
    )
    owner = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name="personal_calendars",
        null=True,
        blank=True,
    )
    kind = models.CharField(
        max_length=16,
        choices=CalendarKindChoices.choices,
        default=CalendarKindChoices.PRIMARY,
    )
    name = models.CharField(_("calendar name"), max_length=255, blank=True, default="")
    description = models.TextField(_("description"), blank=True, default="")
    meeting_room = models.OneToOneField(
        "MeetingRoom",
        on_delete=models.CASCADE,
        related_name="calendar",
        null=True,
        blank=True,
    )
    deleted_at = models.DateTimeField(null=True, blank=True)
    share_link_version = models.PositiveIntegerField(default=1)
    organization_default_access = models.CharField(
        max_length=16,
        choices=CalendarAccessChoices.choices,
        default=CalendarAccessChoices.FREE_BUSY,
        help_text=_(
            "Access inherited by active members of this organization unless an "
            "explicit grant overrides it."
        ),
    )

    class Meta:
        db_table = "meet_personal_calendar"
        ordering = ("created_at",)
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "owner"],
                condition=models.Q(kind=CalendarKindChoices.PRIMARY),
                name="calendar_unique_primary_org_owner",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(kind=CalendarKindChoices.RESOURCE, meeting_room__isnull=False)
                    | ~models.Q(kind=CalendarKindChoices.RESOURCE)
                ),
                name="calendar_resource_has_room",
            ),
        ]
        indexes = [
            models.Index(
                fields=["organization", "owner"],
                name="personalcal_org_owner_idx",
            )
        ]

    def __str__(self):
        return f"Calendar({self.kind}:{self.display_name} @ {self.organization_id})"

    @property
    def display_name(self):
        if self.kind == CalendarKindChoices.PRIMARY and self.owner_id:
            return self.owner.full_name or self.owner.short_name or self.owner.email
        if self.kind == CalendarKindChoices.RESOURCE and self.meeting_room_id:
            return self.meeting_room.name or self.meeting_room.code
        return self.name or _("Untitled calendar")

    @property
    def is_deleted(self):
        return self.deleted_at is not None


# Compatibility for the already-shipped API and downstream integrations. The
# migration renames Django's state model, while the physical table and UUIDs stay put.
PersonalCalendar = Calendar


class CalendarMembership(BaseModel):
    """An explicit calendar role. Subscription remains presentation-only."""

    calendar = models.ForeignKey(
        Calendar, on_delete=models.CASCADE, related_name="access_grants"
    )
    grantee = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="calendar_access_grants"
    )
    permission = models.CharField(
        max_length=16,
        choices=[
            (CalendarAccessChoices.FREE_BUSY, _("Free/busy only")),
            (CalendarAccessChoices.DETAILS, _("Event details")),
            (CalendarAccessChoices.WRITER, _("Can edit events")),
            (CalendarAccessChoices.ADMIN, _("Calendar administrator")),
        ],
    )

    class Meta:
        db_table = "meet_calendar_access_grant"
        ordering = ("calendar_id", "created_at")
        constraints = [
            models.UniqueConstraint(
                fields=["calendar", "grantee"],
                name="calendar_grant_unique_calendar_grantee",
            ),
        ]
        indexes = [
            models.Index(
                fields=["grantee", "permission"],
                name="calgrant_grantee_perm_idx",
            )
        ]

    def __str__(self):
        return f"CalendarGrant({self.calendar_id} -> {self.grantee_id})"

    def clean(self):
        super().clean()
        if self.calendar_id and self.grantee_id:
            owner_id = self.calendar.owner_id
            if owner_id == self.grantee_id:
                raise ValidationError({"grantee": _("The owner already has access.")})

    @property
    def role(self):
        return self.permission

    @role.setter
    def role(self, value):
        self.permission = value


CalendarAccessGrant = CalendarMembership


class CalendarSubscription(BaseModel):
    """A viewer's presentation preference for a calendar they may access.

    Authorization deliberately remains in ``PersonalCalendar`` and
    ``CalendarAccessGrant``.  Deleting a subscription hides the calendar but
    never changes what the owner has shared.
    """

    calendar = models.ForeignKey(
        Calendar, on_delete=models.CASCADE, related_name="subscriptions"
    )
    subscriber = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="calendar_subscriptions"
    )
    enabled = models.BooleanField(default=True)
    color = models.CharField(max_length=16, blank=True, default="")

    class Meta:
        db_table = "meet_calendar_subscription"
        ordering = ("created_at",)
        constraints = [
            models.UniqueConstraint(
                fields=["calendar", "subscriber"],
                name="calendar_subscription_unique_calendar_subscriber",
            ),
        ]
        indexes = [
            models.Index(
                fields=["subscriber", "enabled"],
                name="calsub_subscriber_enabled_idx",
            )
        ]

    def __str__(self):
        return f"CalendarSubscription({self.subscriber_id} -> {self.calendar_id})"

    def clean(self):
        super().clean()


class CalendarExportStatusChoices(models.TextChoices):
    QUEUED = "queued", _("Queued")
    RUNNING = "running", _("Running")
    SUCCEEDED = "succeeded", _("Succeeded")
    FAILED = "failed", _("Failed")


class CalendarExportJob(BaseModel):
    """One immutable, single-calendar export request."""

    calendar = models.ForeignKey(
        Calendar, on_delete=models.CASCADE, related_name="export_jobs"
    )
    requester = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="calendar_export_jobs"
    )
    range_start = models.DateField()
    range_end = models.DateField(
        help_text=_("Inclusive civil end date in the export timezone.")
    )
    timezone = TimeZoneField(
        choices_display="WITH_GMT_OFFSET", use_pytz=False, default=settings.TIME_ZONE
    )
    status = models.CharField(
        max_length=16,
        choices=CalendarExportStatusChoices.choices,
        default=CalendarExportStatusChoices.QUEUED,
    )
    row_count = models.PositiveIntegerField(default=0)
    document_id = models.CharField(max_length=255, blank=True, default="")
    csv_file = models.FileField(
        upload_to="calendar-exports/%Y/%m/%d/", null=True, blank=True
    )
    csv_token = models.CharField(max_length=96, blank=True, default="")
    csv_expires_at = models.DateTimeField(null=True, blank=True)
    error_code = models.CharField(max_length=64, blank=True, default="")
    error_detail = models.TextField(blank=True, default="")
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "meet_calendar_export_job"
        ordering = ("-created_at",)
        indexes = [
            models.Index(
                fields=["requester", "status"], name="calexport_requester_status_idx"
            )
        ]

    def __str__(self) -> str:
        return f"CalendarExportJob({self.calendar_id}, {self.status})"


class CalendarTimezoneModeChoices(models.TextChoices):
    """How a client resolves the calendar display timezone."""

    AUTO = "auto", _("Use device timezone")
    FIXED = "fixed", _("Use a fixed timezone")


class CalendarWeekStartChoices(models.TextChoices):
    MONDAY = "mon", _("Monday")
    SUNDAY = "sun", _("Sunday")


class CalendarTimeRangeChoices(models.TextChoices):
    WORK = "work", _("Working hours")
    FULL = "full", _("Full day")


class CalendarPreference(BaseModel):
    """Account-portable calendar presentation and creation defaults.

    ``User.timezone`` is intentionally not reused here: Web and Android report
    their current device timezone there for notification/quiet-hour behavior.
    Calendar display can instead remain automatic per device or be pinned to a
    fixed IANA zone and synchronized across every client.
    """

    user = models.OneToOneField(
        User, on_delete=models.CASCADE, related_name="calendar_preference"
    )
    timezone_mode = models.CharField(
        max_length=8,
        choices=CalendarTimezoneModeChoices.choices,
        default=CalendarTimezoneModeChoices.AUTO,
    )
    timezone = TimeZoneField(
        _("calendar timezone"),
        choices_display="WITH_GMT_OFFSET",
        use_pytz=False,
        null=True,
        blank=True,
        help_text=_("Fixed calendar timezone; empty while timezone_mode is auto."),
    )
    week_start = models.CharField(
        max_length=3,
        choices=CalendarWeekStartChoices.choices,
        default=CalendarWeekStartChoices.MONDAY,
    )
    default_duration_minutes = models.PositiveSmallIntegerField(default=60)
    default_reminder_minutes = models.PositiveSmallIntegerField(
        null=True, blank=True, default=10
    )
    dim_past = models.BooleanField(default=True)
    show_weekend = models.BooleanField(default=True)
    working_start_minutes = models.PositiveSmallIntegerField(default=9 * 60)
    working_end_minutes = models.PositiveSmallIntegerField(default=18 * 60)
    calendar_time_range = models.CharField(
        max_length=8,
        choices=CalendarTimeRangeChoices.choices,
        default=CalendarTimeRangeChoices.WORK,
    )
    meeting_rooms_time_range = models.CharField(
        max_length=8,
        choices=CalendarTimeRangeChoices.choices,
        default=CalendarTimeRangeChoices.WORK,
    )
    initialized = models.BooleanField(
        default=False,
        help_text=_("Whether an upgraded client has imported its local settings."),
    )
    revision = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "meet_calendar_preference"

    def __str__(self):
        return f"CalendarPreference({self.user_id}, r{self.revision})"


class EventRSVPChoices(models.TextChoices):
    """An attendee's response to an invitation."""

    NEEDS_ACTION = "needs_action", _("Needs action")
    ACCEPTED = "accepted", _("Accepted")
    DECLINED = "declined", _("Declined")
    TENTATIVE = "tentative", _("Tentative")


class EventAttendeeRoleChoices(models.TextChoices):
    """An attendee's role on an event."""

    ORGANIZER = "organizer", _("Organizer")
    REQUIRED = "required", _("Required")
    OPTIONAL = "optional", _("Optional")


class CalendarEvent(BaseModel):
    """A scheduled event (P2 日历/日程).

    Distinct from Room: an event owns the schedule + attendees + RSVP +
    reminders, and *optionally* links a Room (the "join meeting" target, created
    alongside the event). ``room`` is SET_NULL so the room + its IM group outlive
    the event. Recurring parents store an RRULE and are expanded into
    ``recurrence_parent`` child occurrences for per-occurrence RSVP/reminders.
    """

    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="calendar_events"
    )
    source_calendar = models.ForeignKey(
        Calendar,
        on_delete=models.CASCADE,
        related_name="source_events",
        help_text=_(
            "Owning calendar. Legacy writers that omit it are assigned the "
            "organizer's primary calendar before persistence."
        ),
    )
    organizer = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="organized_events"
    )
    title = models.CharField(_("title"), max_length=255)
    description = models.TextField(_("description"), blank=True, default="")
    location = models.CharField(_("location"), max_length=512, blank=True, default="")
    attachment_names = models.JSONField(
        _("attachment names"), blank=True, default=list
    )
    start_at = models.DateTimeField(_("start at"))
    end_at = models.DateTimeField(_("end at"))
    # Canonical half-open civil-date range for all-day events.  ``start_at`` /
    # ``end_at`` remain non-null compatibility anchors for old clients, search,
    # and reminder scheduling, but must never be used to recover these dates.
    start_date = models.DateField(_("start date"), null=True, blank=True)
    end_date = models.DateField(_("end date"), null=True, blank=True)
    timezone = TimeZoneField(
        _("timezone"),
        choices_display="WITH_GMT_OFFSET",
        use_pytz=False,
        default=settings.TIME_ZONE,
        help_text=_("The event's authoring timezone (for cross-tz display)."),
    )
    all_day = models.BooleanField(_("all day"), default=False)
    room = models.ForeignKey(
        Room,
        on_delete=models.SET_NULL,
        related_name="calendar_events",
        null=True,
        blank=True,
        help_text=_(
            "The video room to join (created with the event); SET_NULL "
            "so the room + IM group outlive the event."
        ),
    )
    status = models.CharField(
        max_length=20,
        choices=EventStatusChoices.choices,
        default=EventStatusChoices.CONFIRMED,
    )
    visibility = models.CharField(
        max_length=20,
        choices=EventVisibilityChoices.choices,
        default=EventVisibilityChoices.DEFAULT,
    )
    # Minutes-before-start at which to remind (e.g. [10]). MVP acts on the first.
    reminders = models.JSONField(_("reminders"), blank=True, default=list)
    reminder_pushed_at = models.DateTimeField(
        _("reminder pushed at"),
        null=True,
        blank=True,
        help_text=_(
            "Idempotency guard: set once the reminder has been handled. "
            "Handled is not the same as delivered — see reminder_outcome."
        ),
    )
    #: 提醒**结果**。``reminder_pushed_at`` 只是幂等位,它对「投出去了」和
    #: 「没有会话可投,放弃」设的是同一个值 —— 真机上查一条「为什么没收到提醒」
    #: 时,库里只能告诉你「已提醒」,而实际上一条消息都没发。
    #:
    #: 分开存是为了让运营侧问得出这个问题。日志里本来就区分了两种情况
    #: (``reminder pushed`` / ``marked handled without push``),但日志会滚掉,
    #: 而这个问题总是**事后**才被问起。
    reminder_outcome = models.CharField(
        _("reminder outcome"),
        max_length=24,
        blank=True,
        default="",
        help_text=_(
            "How the reminder ended: delivered / no_conversation / refused. "
            "Empty for events handled before this field existed."
        ),
    )
    recurrence = models.CharField(
        _("recurrence"),
        max_length=255,
        blank=True,
        default="",
        help_text=_("RRULE string; empty means a single occurrence (MVP)."),
    )
    recurrence_parent = models.ForeignKey(
        "self",
        on_delete=models.SET_NULL,
        related_name="occurrences",
        null=True,
        blank=True,
    )
    # P2-M1 重复日程:被「仅此次」删除的发生(occurrence)的 start_at ISO-8601
    # UTC 字符串列表——物化任务跳过这些时刻,防止删掉的场次被重新生成。
    recurrence_exdates = models.JSONField(
        _("recurrence exdates"), blank=True, default=list
    )
    # 从 IM 会话创建时记录经 roster 鉴权的来源 cid，之后不可重绑。重复
    # 子场次及 following 拆分系列继承它；提醒和范围化变更/取消卡回到该会话。
    # 空 = 非会话来源：提醒只走客户端消息列表；参与人的邀请/变更等个人
    # 生命周期通知仍可由日程助手私聊发送，但不会向任何来源会话发群卡片。
    source_conversation_id = models.CharField(
        _("source conversation id"),
        max_length=64,
        blank=True,
        default="",
        help_text=_(
            "IM conversation this event was created from; change cards are "
            "pushed back to it (best-effort)."
        ),
    )
    class Meta:
        db_table = "meet_calendar_event"
        ordering = ("start_at",)
        verbose_name = _("Calendar event")
        verbose_name_plural = _("Calendar events")
        indexes = [
            # Reminder scan: events starting soon that haven't been pushed yet.
            models.Index(fields=["start_at"], name="calevent_start_idx"),
        ]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(
                        all_day=True,
                        start_date__isnull=False,
                        end_date__isnull=False,
                        end_date__gt=models.F("start_date"),
                    )
                    | models.Q(
                        all_day=False,
                        start_date__isnull=True,
                        end_date__isnull=True,
                    )
                ),
                name="calevent_all_day_dates_consistent",
            ),
            # P2-M1 物化幂等:同一主事件的同一发生时刻只允许一行子事件。
            models.UniqueConstraint(
                fields=["recurrence_parent", "start_at"],
                condition=models.Q(recurrence_parent__isnull=False),
                name="calevent_parent_start_uniq",
            ),
        ]

    def __str__(self):
        return f"{self.title} @ {self.start_at:%Y-%m-%d %H:%M}"

    def save(self, *args, **kwargs):
        """Keep non-API legacy writers compatible with the unified model."""
        if (
            not self.source_calendar_id
            and self.organization_id
            and self.organizer_id
        ):
            self.source_calendar, _ = Calendar.objects.get_or_create(
                organization_id=self.organization_id,
                owner_id=self.organizer_id,
                kind=CalendarKindChoices.PRIMARY,
                defaults={
                    "organization_default_access": CalendarAccessChoices.FREE_BUSY,
                },
            )
        return super().save(*args, **kwargs)


class EventAttendee(BaseModel):
    """An invitee on a CalendarEvent, with their RSVP (P2)."""

    event = models.ForeignKey(
        CalendarEvent, on_delete=models.CASCADE, related_name="attendees"
    )
    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name="event_attendances",
        null=True,
        blank=True,
        help_text=_("Internal attendee; null for an external email-only invite."),
    )
    email = models.CharField(_("email"), max_length=255, blank=True, default="")
    rsvp = models.CharField(
        max_length=20,
        choices=EventRSVPChoices.choices,
        default=EventRSVPChoices.NEEDS_ACTION,
    )
    role = models.CharField(
        max_length=20,
        choices=EventAttendeeRoleChoices.choices,
        default=EventAttendeeRoleChoices.REQUIRED,
    )

    class Meta:
        db_table = "meet_event_attendee"
        ordering = ("created_at",)
        verbose_name = _("Event attendee")
        verbose_name_plural = _("Event attendees")
        constraints = [
            models.UniqueConstraint(
                fields=["event", "user"],
                name="event_attendee_unique_event_user",
                violation_error_message=_("This user is already an attendee."),
            ),
        ]

    def __str__(self):
        who = self.user or self.email or "<?>"
        return f"{who} → {self.event_id} ({self.get_rsvp_display()})"


# --- P5 审批 / 工作流 ---


class ApprovalNodeType(models.TextChoices):
    """How a flow node resolves its approver (see services/approval.py)."""

    DIRECT_MANAGER = "direct_manager", _("Direct manager")
    DEPARTMENT_HEAD = "department_head", _("Department head")
    ORG_ROLE = "org_role", _("Organization role")
    USER = "user", _("Specific user")
    # P5b: a 抄送 (carbon-copy) node — notifies its targets and auto-advances.
    CC = "cc", _("Carbon copy")


class ApprovalStatusChoices(models.TextChoices):
    """Lifecycle of an approval instance."""

    PENDING = "pending", _("Pending")
    APPROVED = "approved", _("Approved")
    REJECTED = "rejected", _("Rejected")
    CANCELLED = "cancelled", _("Cancelled")
    NEEDS_ASSIGNMENT = "needs_assignment", _("Needs assignment")


class ApprovalActionChoices(models.TextChoices):
    """A single approver's action on their task."""

    PENDING = "pending", _("Pending")
    APPROVED = "approved", _("Approved")
    REJECTED = "rejected", _("Rejected")
    # P5b: node skipped by a false condition; or-mode siblings closed after one
    # approval; and a 抄送 row that was merely notified.
    SKIPPED = "skipped", _("Skipped")
    NOTIFIED = "notified", _("Notified")


class ApprovalTaskKind(models.TextChoices):
    """Whether a task is a real approval step or a 抄送 (carbon-copy) notice."""

    APPROVE = "approve", _("Approval")
    CC = "cc", _("Carbon copy")


class ApprovalTemplate(BaseModel):
    """A reusable approval definition: a form + an ordered approver chain (P5).

    ``form_schema`` describes the form fields (MVP: authored via Django admin /
    JSON, no visual designer). ``flow`` is an ordered list of node rules, each
    ``{"type": <ApprovalNodeType>, ...}`` — MVP is a serial single chain.
    """

    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="approval_templates"
    )
    name = models.CharField(_("name"), max_length=255)
    description = models.TextField(_("description"), blank=True, default="")
    form_schema = models.JSONField(_("form schema"), blank=True, default=dict)
    flow = models.JSONField(
        _("flow"),
        blank=True,
        default=list,
        help_text=_("Ordered approver-resolution rules; MVP is a serial chain."),
    )
    is_active = models.BooleanField(_("active"), default=True)

    class Meta:
        db_table = "meet_approval_template"
        ordering = ("name",)
        verbose_name = _("Approval template")
        verbose_name_plural = _("Approval templates")

    def __str__(self):
        return self.name


class ApprovalInstance(BaseModel):
    """A running (or finished) approval request off a template (P5)."""

    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="approval_instances"
    )
    template = models.ForeignKey(
        ApprovalTemplate, on_delete=models.PROTECT, related_name="instances"
    )
    applicant = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="approval_requests"
    )
    form_data = models.JSONField(_("form data"), blank=True, default=dict)
    status = models.CharField(
        max_length=20,
        choices=ApprovalStatusChoices.choices,
        default=ApprovalStatusChoices.PENDING,
    )
    # Index of the flow node currently awaiting action (serial chain pointer).
    current_node = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "meet_approval_instance"
        ordering = ("-created_at",)
        verbose_name = _("Approval instance")
        verbose_name_plural = _("Approval instances")

    def __str__(self):
        return f"{self.template_id} by {self.applicant_id} ({self.status})"


class ApprovalTask(BaseModel):
    """One node's task: the resolved approver and their action (P5)."""

    instance = models.ForeignKey(
        ApprovalInstance, on_delete=models.CASCADE, related_name="tasks"
    )
    node_index = models.PositiveIntegerField()
    approver = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        related_name="approval_tasks",
        null=True,
        blank=True,
        help_text=_("Resolved approver; null when the node could not be resolved."),
    )
    action = models.CharField(
        max_length=20,
        choices=ApprovalActionChoices.choices,
        default=ApprovalActionChoices.PENDING,
    )
    # P5b: a node may now hold several tasks (会签 multi-approver, 抄送 notices).
    kind = models.CharField(
        max_length=20,
        choices=ApprovalTaskKind.choices,
        default=ApprovalTaskKind.APPROVE,
    )
    comment = models.TextField(_("comment"), blank=True, default="")
    acted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "meet_approval_task"
        ordering = ("instance", "node_index")
        verbose_name = _("Approval task")
        verbose_name_plural = _("Approval tasks")
        constraints = [
            # P5b: one row per (node, approver) so a node can carry several
            # approvers. Null-approver rows (needs_assignment / skipped) are
            # exempt — Postgres treats NULLs as distinct — and the engine keeps
            # at most one such row per node itself.
            models.UniqueConstraint(
                fields=["instance", "node_index", "approver"],
                name="approval_task_unique_instance_node_approver",
            ),
        ]

    def __str__(self):
        return f"task#{self.node_index} of {self.instance_id} ({self.action})"


class ApprovalDelegation(BaseModel):
    """Delegate one user's approval tasks to another for a time window (P5).

    When approver resolution lands on ``delegator`` during an active window, the
    task is assigned to ``delegate`` instead (one hop — delegations do not chain,
    which also prevents loops). Ops-configured via Django admin, consistent with
    the management-console transition.
    """

    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name="approval_delegations",
    )
    delegator = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name="approval_delegations_out",
        help_text=_("Whose approval tasks are handed off."),
    )
    delegate = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name="approval_delegations_in",
        help_text=_("Who acts on the delegator's behalf."),
    )
    start_at = models.DateTimeField()
    end_at = models.DateTimeField()
    is_active = models.BooleanField(default=True)

    class Meta:
        db_table = "meet_approval_delegation"
        ordering = ("-start_at",)
        verbose_name = _("Approval delegation")
        verbose_name_plural = _("Approval delegations")

    def __str__(self):
        return f"{self.delegator_id} → {self.delegate_id}"


# --- M 端 (management console) 审计日志 ---


class AuditActionChoices(models.TextChoices):
    """Administrative actions recorded in the console audit log."""

    DEPT_CREATE = "dept.create", _("Department created")
    DEPT_RENAME = "dept.rename", _("Department renamed")
    DEPT_UPDATE = "dept.update", _("Department updated")
    DEPT_MOVE = "dept.move", _("Department moved")
    DEPT_DELETE = "dept.delete", _("Department deleted")
    MEMBER_ADD = "member.add", _("Member added")
    MEMBER_INVITE = "member.invite", _("Member invited")
    MEMBER_INVITE_REVOKE = "member.invite_revoke", _("Member invitation revoked")
    MEMBER_UPDATE = "member.update", _("Member updated")
    MEMBER_ROLE_CHANGE = "member.role_change", _("Member role changed")
    MEMBER_DEPARTMENT_CHANGE = (
        "member.department_change",
        _("Member department changed"),
    )
    MEMBER_SUSPEND = "member.suspend", _("Member suspended")
    MEMBER_RESTORE = "member.restore", _("Member restored")
    MEMBER_REMOVE = "member.remove", _("Member removed")
    # P10 M1 — member lifecycle.
    MEMBER_OFFBOARD = "member.offboard", _("Member offboarded")
    MEMBER_REHIRE = "member.rehire", _("Member rehired")
    MEMBER_PURGE = "member.purge", _("Member record purged")
    MEMBER_BULK_UPDATE = "member.bulk_update", _("Members updated in bulk")
    DICT_ITEM_CREATE = "dict_item.create", _("Dictionary option created")
    DICT_ITEM_UPDATE = "dict_item.update", _("Dictionary option updated")
    DICT_ITEM_DELETE = "dict_item.delete", _("Dictionary option deleted")
    # P10 M2 — user groups. Membership changes are audited because a group key
    # is an ACL subject: adding someone silently widens what they can reach.
    GROUP_CREATE = "group.create", _("User group created")
    GROUP_UPDATE = "group.update", _("User group updated")
    GROUP_DELETE = "group.delete", _("User group deleted")
    GROUP_MEMBER_ADD = "group.member_add", _("User group members added")
    GROUP_MEMBER_REMOVE = "group.member_remove", _("User group member removed")
    # P10 M2 — custom admin roles. Every one of these hands out or takes away
    # administrative power, so none of them is allowed to be silent.
    ROLE_CREATE = "role.create", _("Admin role created")
    ROLE_UPDATE = "role.update", _("Admin role updated")
    ROLE_DELETE = "role.delete", _("Admin role deleted")
    ROLE_ASSIGN = "role.assign", _("Admin role assigned")
    ROLE_UNASSIGN = "role.unassign", _("Admin role revoked")
    # P10 M2 — bulk import/export. One summary row per job, never one per line:
    # a 1000-row import would otherwise bury every other action in the log.
    MEMBER_IMPORT = "member.import", _("Members imported")
    MEMBER_EXPORT = "member.export", _("Members exported")
    # P10 M4 — invite links. The link rows are audited, the applications are
    # not: an application is the applicant's own act and already has its own
    # reviewable row; only the administrator's decisions belong in the log.
    INVITE_LINK_CREATE = "invite_link.create", _("Invite link created")
    INVITE_LINK_REVOKE = "invite_link.revoke", _("Invite link revoked")
    JOIN_REQUEST_APPROVE = "join_request.approve", _("Join request approved")
    JOIN_REQUEST_REJECT = "join_request.reject", _("Join request rejected")
    # 纪要闭环 M2:纪要编辑(会议侧动作,同样入 M 端审计)。
    SUMMARY_EDIT = "summary.edit", _("Meeting summary edited")
    # P9 会议室(实体会议室,与 LiveKit Room 无关)。
    ROOM_NODE_CREATE = "room_node.create", _("Room hierarchy node created")
    ROOM_NODE_UPDATE = "room_node.update", _("Room hierarchy node updated")
    ROOM_NODE_MOVE = "room_node.move", _("Room hierarchy node moved")
    ROOM_NODE_DELETE = "room_node.delete", _("Room hierarchy node deleted")
    MEETING_ROOM_CREATE = "meeting_room.create", _("Meeting room created")
    MEETING_ROOM_UPDATE = "meeting_room.update", _("Meeting room updated")
    MEETING_ROOM_DELETE = "meeting_room.delete", _("Meeting room deleted")
    MEETING_ROOM_FACILITY_CREATE = (
        "meeting_room_facility.create",
        _("Meeting room facility created"),
    )
    MEETING_ROOM_FACILITY_UPDATE = (
        "meeting_room_facility.update",
        _("Meeting room facility updated"),
    )
    MEETING_ROOM_FACILITY_DELETE = (
        "meeting_room_facility.delete",
        _("Meeting room facility deleted"),
    )
    # 群机器人. BOT_WEBHOOK_VIEW is here because reading the address is itself a
    # sensitive act — it is a live credential for posting into a group.
    BOT_CREATE = "bot.create", _("Group bot created")
    BOT_UPDATE = "bot.update", _("Group bot updated")
    BOT_DELETE = "bot.delete", _("Group bot removed")
    BOT_SECRET_RESET = "bot.secret_reset", _("Group bot credential rotated")
    BOT_WEBHOOK_VIEW = "bot.webhook_view", _("Group bot webhook address viewed")
    # 线 B — M 端治理。**不复用 BOT_UPDATE**:「谁停了生产机器人」是这块唯一
    # 真正要能被筛出来的事件,混进 bot.update(C 端改个名也是它)等于没做。
    BOT_DISABLE = "bot.disable", _("Group bot disabled")
    BOT_ENABLE = "bot.enable", _("Group bot enabled")


class AuditLog(BaseModel):
    """An append-only record of an administrative action in the console (M 端).

    Answers "who did what, when" for org governance. Written from the admin API
    write paths via ``core.services.audit.record_audit``; read back (org-scoped)
    through ``core/api/admin_audit.py``. ``actor`` is nulled rather than cascaded
    if the acting user is deleted, so history survives.
    """

    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name="audit_logs",
    )
    actor = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="audit_actions",
        help_text=_("The admin who performed the action (null if since deleted)."),
    )
    action = models.CharField(max_length=40, choices=AuditActionChoices.choices)
    target_type = models.CharField(
        max_length=40,
        blank=True,
        default="",
        help_text=_("The kind of object acted on, e.g. 'department' / 'membership'."),
    )
    target_id = models.CharField(
        max_length=64,
        blank=True,
        default="",
        help_text=_("Id of the object acted on."),
    )
    target_label = models.CharField(
        max_length=255,
        blank=True,
        default="",
        help_text=_("Human-readable name of the target at action time."),
    )
    metadata = models.JSONField(
        blank=True,
        default=dict,
        help_text=_("Action detail, e.g. before/after field values."),
    )

    class Meta:
        db_table = "meet_audit_log"
        ordering = ("-created_at",)
        verbose_name = _("Audit log")
        verbose_name_plural = _("Audit logs")
        indexes = [
            models.Index(
                fields=["organization", "-created_at"],
                name="meet_audit_org_created_idx",
            ),
            models.Index(
                fields=["actor", "-created_at"],
                name="meet_audit_actor_created_idx",
            ),
        ]

    def __str__(self):
        return f"{self.actor_id} {self.action} {self.target_type}:{self.target_id}"


# --- M 端 成员预配置 / 邀请 ---


class InvitationStatusChoices(models.TextChoices):
    """Lifecycle of an organization invitation."""

    PENDING = "pending", _("Pending")
    ACCEPTED = "accepted", _("Accepted")
    REVOKED = "revoked", _("Revoked")


class OrgInvitation(BaseModel):
    """A pre-provisioning invitation: places a person into a department / role
    before they first sign in.

    Matched by **email or phone** when the invitee logs in (OIDC claim hook),
    which then creates their Membership with the invited department / role /
    title instead of the plain org-level default.

    Phone was added in P10 M2-g and is the key that actually matters here.
    we-meet signs people in with a mobile OTP: ``core/api/mobile_auth.py``
    finds-or-creates the Keycloak account by its ``phoneNumber`` attribute, and
    the email those accounts carry is synthesized from the number. An
    administrator holds phone numbers, not mailboxes — an email-only invitation
    asked them for a value they had no way to know, so the feature shipped
    unusable.

    Exactly one of ``email`` / ``phone`` is required; both are allowed. Each is
    unique per organization among pending rows, so the same person cannot be
    queued twice.
    """

    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="invitations"
    )
    email = models.EmailField(_("email"), blank=True, default="")
    #: Mainland-China mobile number, digits only (``1[3-9]`` + 9). Matched
    #: against ``User.phone``, which mirrors Keycloak's ``phoneNumber``.
    phone = models.CharField(_("phone"), max_length=32, blank=True, default="")
    #: What to call this person before they have ever signed in. Display only:
    #: ``User.full_name`` is recomputed from the OIDC claims on every login, so
    #: writing to it here would be reverted at the next sign-in. Giving an
    #: organization a name for someone that outranks the IdP's is a Membership
    #: level concern (P10 M3 字段体系), not an invitation's.
    full_name = models.CharField(_("full name"), max_length=255, blank=True, default="")
    department = models.ForeignKey(
        Department,
        on_delete=models.SET_NULL,
        related_name="invitations",
        null=True,
        blank=True,
        help_text=_("Department the invitee lands in (null = organization-level)."),
    )
    org_role = models.CharField(
        max_length=20, choices=OrgRoleChoices.choices, default=OrgRoleChoices.MEMBER
    )
    title = models.CharField(_("title"), max_length=255, blank=True, default="")
    status = models.CharField(
        max_length=20,
        choices=InvitationStatusChoices.choices,
        default=InvitationStatusChoices.PENDING,
    )
    invited_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        related_name="sent_invitations",
        null=True,
        blank=True,
    )
    accepted_user = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        related_name="accepted_invitations",
        null=True,
        blank=True,
    )
    accepted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "meet_org_invitation"
        ordering = ("-created_at",)
        verbose_name = _("Organization invitation")
        verbose_name_plural = _("Organization invitations")
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "email"],
                # ``email != ""`` matters now that phone-only rows exist: without
                # it every phone invitation would collide on the empty string and
                # an organization could queue exactly one of them.
                condition=models.Q(status="pending") & ~models.Q(email=""),
                name="one_pending_invite_per_email_org",
                violation_error_message=_(
                    "A pending invitation already exists for this email."
                ),
            ),
            models.UniqueConstraint(
                fields=["organization", "phone"],
                condition=models.Q(status="pending") & ~models.Q(phone=""),
                name="one_pending_invite_per_phone_org",
                violation_error_message=_(
                    "A pending invitation already exists for this phone number."
                ),
            ),
            models.CheckConstraint(
                condition=~models.Q(email="") | ~models.Q(phone=""),
                name="invitation_has_email_or_phone",
                violation_error_message=_(
                    "An invitation needs an email address or a phone number."
                ),
            ),
        ]

    def __str__(self):
        return f"{self.email or self.phone} → {self.organization_id} ({self.status})"


#: Alphabet for invite codes: uppercase, minus the glyph pairs that get
#: mis-transcribed (0/O, 1/I/L). An invite code has to survive being read aloud
#: over a phone and copied off a whiteboard.
INVITE_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
INVITE_CODE_LENGTH = 8


def generate_invite_code() -> str:
    """A fresh invite code. Collisions are handled by the unique constraint."""
    return "".join(
        secrets.choice(INVITE_CODE_ALPHABET) for _ in range(INVITE_CODE_LENGTH)
    )


class OrgInviteLink(BaseModel):
    """A shareable credential that lets whoever holds it *apply* to join (P10 M4).

    The counterpart of :class:`OrgInvitation`, and the difference is who names
    the person: an invitation is an administrator saying "13800000001 joins
    Engineering"; a link says "whoever has this may ask to join Engineering".
    That is why a link needs an expiry, a usage cap and an approval step, and an
    invitation needs none of them.

    **Invite code, invite link and QR code are this one row seen three ways** —
    the code is the last path segment of the link, and the QR is that link
    rendered client-side. Modelling them separately would immediately raise
    "if I change the expiry, do I change it in three places?".

    ⚠️ Read `docs/phases/p10b-invitation-system.md` §三 before assuming approval
    here gates entry to the product. It does not, yet: every authenticated user
    is auto-joined to the default organization
    (``authentication/backends.py::ensure_default_org_membership``), so what
    this approves today is the **department and role**, not admission. The
    organization-level ``auto_join_enabled`` switch is what turns it into real
    admission control, and its consequences for the rest of the product are
    deliberately out of scope for M4.
    """

    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="invite_links"
    )
    #: Immutable once issued — it is printed, pasted into chats and turned into
    #: QR codes the moment it exists.
    code = models.CharField(
        _("code"), max_length=16, unique=True, editable=False, db_index=True
    )
    department = models.ForeignKey(
        Department,
        on_delete=models.CASCADE,
        related_name="invite_links",
        null=True,
        blank=True,
        help_text=_("Department applicants land in (null = organization level)."),
    )
    org_role = models.CharField(
        max_length=20, choices=OrgRoleChoices.choices, default=OrgRoleChoices.MEMBER
    )
    title = models.CharField(_("title"), max_length=255, blank=True, default="")
    #: Default on, and turning it off should feel like a decision: a link that
    #: admits people unreviewed means whoever forwards the URL has added them to
    #: a directory full of colleagues' phone numbers.
    require_approval = models.BooleanField(_("require approval"), default=True)
    #: Mandatory. A leaked link that never expires is a permanent back door, and
    #: ``OrgInvitation`` not having this field is a gap, not a precedent.
    expires_at = models.DateTimeField(_("expires at"))
    max_uses = models.PositiveIntegerField(
        _("max uses"),
        null=True,
        blank=True,
        help_text=_("Null means unlimited."),
    )
    #: Incremented when an application is **approved**, not when it is filed —
    #: otherwise a handful of rejected applicants exhaust the quota.
    used_count = models.PositiveIntegerField(default=0)
    is_active = models.BooleanField(_("active"), default=True)
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        related_name="created_invite_links",
        null=True,
        blank=True,
    )

    class Meta:
        db_table = "meet_org_invite_link"
        ordering = ("-created_at",)
        verbose_name = _("Organization invite link")
        verbose_name_plural = _("Organization invite links")
        indexes = [
            models.Index(
                fields=["organization", "is_active"], name="invite_link_org_active_idx"
            ),
        ]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(max_uses__isnull=True) | models.Q(max_uses__gt=0),
                name="invite_link_max_uses_positive",
                violation_error_message=_("Max uses must be greater than zero."),
            ),
        ]

    def __str__(self):
        return f"{self.code} → {self.organization_id}"

    def save(self, *args, **kwargs):
        if not self.code:
            self.code = generate_invite_code()
        super().save(*args, **kwargs)

    @property
    def is_exhausted(self) -> bool:
        return self.max_uses is not None and self.used_count >= self.max_uses

    def is_usable(self, now=None) -> bool:
        """Whether the link may still take applications.

        Callers must not tell the difference between the reasons — see
        ``core/api/invite.py``: distinguishing "expired" from "never existed"
        hands an enumeration oracle to anyone guessing codes.
        """
        now = now or timezone.now()
        return (
            self.is_active
            and self.expires_at > now
            and not self.is_exhausted
            and self.organization.is_active
        )


class OrgJoinStatusChoices(models.TextChoices):
    """Lifecycle of an application to join an organization."""

    PENDING = "pending", _("Pending")
    APPROVED = "approved", _("Approved")
    REJECTED = "rejected", _("Rejected")
    CANCELLED = "cancelled", _("Cancelled")
    EXPIRED = "expired", _("Expired")


class OrgJoinRequest(BaseModel):
    """Somebody asking to join, off an invite link (P10 M4).

    Deliberately **not** an :class:`ApprovalInstance`. Three reasons, and the
    third is the one that would bite later:

    1. ``ApprovalInstance.template`` is a non-null ``PROTECT`` FK and joining an
       organization has no business template to point at;
    2. the approver here is *computed* — whoever holds ``org.member.write`` with
       a scope covering the target department — not a node configured in a flow;
    3. the applicant is not a member of the organization at the moment they
       apply, while every query around ``ApprovalInstance.applicant`` assumes
       they are.

    ``phone`` and ``full_name`` are **snapshots taken when the application was
    filed**, not joins: the reviewer needs to see who applied, and a person who
    changes their display name between applying and being reviewed should not
    silently change what the reviewer is looking at.
    """

    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="join_requests"
    )
    link = models.ForeignKey(
        OrgInviteLink,
        on_delete=models.SET_NULL,
        related_name="join_requests",
        null=True,
        blank=True,
    )
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="join_requests"
    )
    phone = models.CharField(_("phone"), max_length=32, blank=True, default="")
    full_name = models.CharField(_("full name"), max_length=255, blank=True, default="")
    department = models.ForeignKey(
        Department,
        on_delete=models.SET_NULL,
        related_name="join_requests",
        null=True,
        blank=True,
    )
    org_role = models.CharField(
        max_length=20, choices=OrgRoleChoices.choices, default=OrgRoleChoices.MEMBER
    )
    status = models.CharField(
        max_length=20,
        choices=OrgJoinStatusChoices.choices,
        default=OrgJoinStatusChoices.PENDING,
    )
    reviewed_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        related_name="reviewed_join_requests",
        null=True,
        blank=True,
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)
    reject_reason = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        db_table = "meet_org_join_request"
        ordering = ("-created_at",)
        verbose_name = _("Organization join request")
        verbose_name_plural = _("Organization join requests")
        indexes = [
            models.Index(
                fields=["organization", "status", "-created_at"],
                name="join_request_org_status_idx",
            ),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "user"],
                condition=models.Q(status="pending"),
                name="one_pending_join_request",
                violation_error_message=_(
                    "You already have a pending application for this organization."
                ),
            ),
        ]

    def __str__(self):
        return (
            f"{self.full_name or self.phone} → {self.organization_id} ({self.status})"
        )


class DevicePushToken(BaseModel):
    """A mobile device's vendor-push registration (P0 离线推送, see
    docs/features/foundation_p0_p3.md §P0).

    One row per (provider, cid). Getui's cid identifies the device install;
    re-registering after a reinstall or account switch re-binds the row to the
    new user (update_or_create in the view), so a device never pushes to a
    signed-out account.
    """

    class Provider(models.TextChoices):
        GETUI = "getui", _("Getui")

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="push_tokens")
    provider = models.CharField(
        _("provider"),
        max_length=16,
        choices=Provider.choices,
        default=Provider.GETUI,
    )
    cid = models.CharField(_("push client id"), max_length=128)
    device_id = models.CharField(_("device id"), max_length=128, blank=True, default="")
    platform = models.CharField(_("platform"), max_length=16, blank=True, default="")
    app_version = models.CharField(
        _("app version"), max_length=32, blank=True, default=""
    )
    last_seen_at = models.DateTimeField(_("last seen at"), null=True, blank=True)

    class Meta:
        db_table = "meet_device_push_token"
        ordering = ("-updated_at",)
        verbose_name = _("device push token")
        verbose_name_plural = _("device push tokens")
        constraints = [
            models.UniqueConstraint(
                fields=["provider", "cid"], name="one_row_per_provider_cid"
            ),
        ]
        indexes = [
            # Fan-out lookup: all live tokens for a set of users.
            models.Index(fields=["user"], name="pushtoken_user_idx"),
        ]

    def __str__(self):
        return f"PushToken({self.user_id}, {self.provider}:{self.cid[:12]}…)"


class PushPreference(BaseModel):
    """Per-user offline-push preference (P0-M3 免打扰时段, see
    docs/features/foundation_p0_p3.md §P0).

    Quiet hours are wall-clock in the user's own ``User.timezone``. An
    overnight range (``quiet_start > quiet_end``, e.g. 22:00→08:00) wraps
    midnight; ``quiet_start == quiet_end`` with the switch on means all-day
    quiet. Scope: only message notifications (``notify_offline``) are
    suppressed — call invites (``notify_call``) always ring through, 实时呼叫
    错过成本高且被叫可手动拒接(飞书「电话穿透」同款默认).
    """

    user = models.OneToOneField(
        User, on_delete=models.CASCADE, related_name="push_preference"
    )
    quiet_enabled = models.BooleanField(_("quiet hours enabled"), default=False)
    quiet_start = models.TimeField(_("quiet start"), default=dt_time(22, 0))
    quiet_end = models.TimeField(_("quiet end"), default=dt_time(8, 0))
    # NB: there is deliberately no global "starred contacts bypass quiet hours"
    # switch here. Bypassing is decided per contact by
    # ``ContactPreference.special_alert`` — a switch the user flips on the
    # person themselves. An extra global gate on top would just recreate 飞书's
    # override-page structure, which is what we moved away from.

    class Meta:
        db_table = "meet_push_preference"
        verbose_name = _("push preference")
        verbose_name_plural = _("push preferences")

    def __str__(self):
        state = "on" if self.quiet_enabled else "off"
        return f"PushPreference({self.user_id}, quiet={state} {self.quiet_start}-{self.quiet_end})"


class ExternalContactStatusChoices(models.TextChoices):
    """Lifecycle of a cross-organization contact relationship."""

    PENDING = "pending", _("Pending")
    ACCEPTED = "accepted", _("Accepted")
    DECLINED = "declined", _("Declined")


class ExternalContact(BaseModel):
    """A mutual contact relationship between two real users in different orgs.

    The pair is stored once in canonical UUID order.  ``requested_by`` keeps the
    direction while the row is pending; an accepted row is deliberately
    directionless, matching the product rule that external contacts are mutual.
    """

    user_a = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="external_contacts_as_a"
    )
    user_b = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="external_contacts_as_b"
    )
    requested_by = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="external_contact_requests_sent"
    )
    status = models.CharField(
        max_length=16,
        choices=ExternalContactStatusChoices.choices,
        default=ExternalContactStatusChoices.PENDING,
    )
    responded_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "meet_external_contact"
        ordering = ("-updated_at",)
        verbose_name = _("external contact")
        verbose_name_plural = _("external contacts")
        constraints = [
            models.UniqueConstraint(
                fields=["user_a", "user_b"],
                name="one_external_contact_per_user_pair",
            ),
            models.CheckConstraint(
                condition=~models.Q(user_a=models.F("user_b")),
                name="external_contact_users_differ",
            ),
            models.CheckConstraint(
                condition=models.Q(requested_by=models.F("user_a"))
                | models.Q(requested_by=models.F("user_b")),
                name="external_contact_requester_in_pair",
            ),
        ]
        indexes = [
            models.Index(fields=["user_a", "status"], name="extcontact_a_status_idx"),
            models.Index(fields=["user_b", "status"], name="extcontact_b_status_idx"),
        ]

    def __str__(self):
        return f"ExternalContact({self.user_a_id} <-> {self.user_b_id}: {self.status})"

    @staticmethod
    def canonical_pair(first, second):
        """Return a stable ``(user_a, user_b)`` tuple for two users."""
        return (first, second) if str(first.id) < str(second.id) else (second, first)

    def other_user(self, user):
        """Return the other side of the relationship."""
        return self.user_b if self.user_a_id == user.id else self.user_a


class ContactPreference(BaseModel):
    """``owner``'s personal flags on one ``target`` contact (对标企业微信).

    Two **independent** flags, deliberately not one:

    - ``is_starred`` — 星标: pure filing. Puts the person in 通讯录's
      「星标联系人」list and stamps a ⭐ next to them in the conversation list.
      It changes **nothing** about notifications.
    - ``special_alert`` — 他的消息特别提醒: pure notification behaviour. Their
      messages bypass the owner's 免打扰时段 (see
      ``core.services.push_send.special_alert_bypass_user_ids``) and the
      conversation list marks them.

    Why independent (this was 飞书-style coupled at first, and it was wrong):
    starring someone is a filing gesture — "I want to find them quickly" — and
    it must not silently change when the phone rings at 2am. 飞书 fuses the two
    and then needs a settings page of override switches to undo the fusion;
    企业微信 keeps them as two switches on the contact and needs no overrides.
    A row may have either flag alone; both false means the row is deleted.

    Purely personal state — the target is never told. Like ``ImLaterItem`` it
    lives entirely on the we-meet side: it is a *directory* relation (not a
    conversation attribute), and it feeds the offline-push decision, which is
    Django's job anyway.

    Cross-org rows are impossible to create (the API only accepts same-org
    active members) and would anyway drop out of the starred list, which is
    built from the target's *Membership* in the caller's organization.
    """

    owner = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="contact_preferences"
    )
    target = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="contact_preferred_by"
    )
    is_starred = models.BooleanField(
        _("starred"),
        default=False,
        help_text=_(
            "Filing only: listed under 星标联系人 and marked ⭐ in the "
            "conversation list. Does not affect notifications."
        ),
    )
    special_alert = models.BooleanField(
        _("special alert"),
        default=False,
        help_text=_(
            "Their messages push through the owner's quiet hours and are "
            "marked in the conversation list. Independent of is_starred."
        ),
    )

    class Meta:
        db_table = "meet_contact_preference"
        ordering = ("created_at",)
        verbose_name = _("contact preference")
        verbose_name_plural = _("contact preferences")
        constraints = [
            models.UniqueConstraint(
                fields=["owner", "target"],
                name="one_contact_pref_per_owner_target",
            ),
        ]
        indexes = [
            # Push path: "did any of these quiet users special-alert this sender?"
            models.Index(
                fields=["target", "owner"], name="contactpref_target_owner_idx"
            ),
        ]

    def __str__(self):
        flags = (
            ",".join(
                f
                for f in (
                    "starred" if self.is_starred else "",
                    "alert" if self.special_alert else "",
                )
                if f
            )
            or "none"
        )
        return f"ContactPreference({self.owner_id} → {self.target_id}: {flags})"


class ImLaterItem(BaseModel):
    """A per-user「稍后处理」bookmark on one IM message (P3-M1, see
    docs/features/foundation_p0_p3.md §P3-D2).

    Lives entirely on the we-meet side: jusi-light-im has no per-user flag
    store, and a later-bookmark is strictly personal state (never shared with
    other members), so no jusi roster round-trip is needed at mark time.
    ``snippet`` / ``sender_name`` are snapshots taken when the user marks the
    message, so the later-list still renders (as a tombstone-ish row) after
    the original message is recalled or deleted.
    """

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="im_later_items"
    )
    cid = models.CharField(_("conversation id"), max_length=64)
    mid = models.CharField(_("message id"), max_length=32)
    seq = models.BigIntegerField(
        _("message seq"),
        default=0,
        help_text=_("Conversation seq at mark time; reserved for jump-to-message."),
    )
    snippet = models.TextField(_("snippet"), blank=True, default="")
    sender_name = models.CharField(
        _("sender name"), max_length=128, blank=True, default=""
    )
    content_type = models.CharField(
        _("content type"), max_length=32, blank=True, default=""
    )
    done_at = models.DateTimeField(_("done at"), null=True, blank=True)

    class Meta:
        db_table = "meet_im_later_item"
        ordering = ("-created_at",)
        verbose_name = _("IM later item")
        verbose_name_plural = _("IM later items")
        constraints = [
            models.UniqueConstraint(
                fields=["user", "cid", "mid"],
                name="one_later_per_user_message",
            ),
        ]
        indexes = [
            # Badge / pending-list scan.
            models.Index(fields=["user", "done_at"], name="imlater_user_done_idx"),
        ]

    def __str__(self):
        state = "done" if self.done_at else "pending"
        return f"Later({self.user_id}, {self.cid}#{self.mid}, {state})"


class ImBotKindChoices(models.TextChoices):
    """What kind of thing is speaking."""

    CUSTOM = "custom", _("Custom webhook bot")
    BUILTIN = "builtin", _("Built-in assistant")


class ImBot(BaseModel):
    """A bot's **identity** — the avatar, name and one-line description that
    render above its messages (对标飞书「群机器人」).

    Split from :class:`ImBotInstallation` because the two have different
    cardinalities: a custom webhook bot is one identity bound to one group,
    while a built-in assistant (会议助手 / 日程助手 / 审批助手) is one identity
    that speaks in every group it has something to say in.

    Deliberately **not** a :class:`User` row. Bots have no sub, no membership,
    no push tokens; and ``resolve_users`` filters people with
    ``is_device=False``, so a bot-as-User would have to both hide behind that
    flag and stay resolvable — a contradiction. Uniqueness against real people
    is instead enforced where it matters, in jusi: ``users.external_id`` is
    globally unique and a bot's is ``bot:<pk>``, which no Keycloak sub can
    collide with.
    """

    kind = models.CharField(
        _("kind"),
        max_length=16,
        choices=ImBotKindChoices.choices,
        default=ImBotKindChoices.CUSTOM,
    )
    #: Stable handle for built-ins (``meeting-assistant`` …) so code can look one
    #: up without hardcoding a pk. Empty for custom bots.
    slug = models.SlugField(_("slug"), max_length=64, blank=True, default="")
    name = models.CharField(_("name"), max_length=32)
    description = models.CharField(
        _("description"),
        max_length=256,
        blank=True,
        default="",
        help_text=_("Shown next to the name on every message this bot sends."),
    )
    #: Always populated: an uploaded image, or a swatch PNG the server renders
    #: from ``avatar_color_index``. Keeping one path means Web, Android and the
    #: push notification all just read ``avatar_url`` — no client reimplements
    #: the palette.
    avatar_key = models.CharField(
        _("avatar object key"), max_length=500, blank=True, default=""
    )
    avatar_color_index = models.PositiveSmallIntegerField(
        _("avatar colour"),
        default=0,
        help_text=_("Index into the shared bot palette; used to re-render the swatch."),
    )
    #: Minted lazily on first use, never in a migration — the migrate job runs
    #: where jusi may be unreachable.
    im_uid = models.CharField(
        _("IM uid"),
        max_length=36,
        unique=True,
        blank=True,
        null=True,
        editable=False,
    )
    #: Null = a global built-in, resolvable by everyone. Custom bots always
    #: belong to the creator's organization.
    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name="im_bots",
        null=True,
        blank=True,
    )
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        related_name="created_im_bots",
        null=True,
        blank=True,
    )
    is_active = models.BooleanField(_("active"), default=True)

    class Meta:
        db_table = "meet_im_bot"
        ordering = ("created_at",)
        verbose_name = _("IM bot")
        verbose_name_plural = _("IM bots")
        constraints = [
            models.UniqueConstraint(
                fields=["slug"],
                condition=models.Q(kind=ImBotKindChoices.BUILTIN),
                name="one_bot_per_builtin_slug",
            ),
        ]
        indexes = [
            # resolve_users looks bots up by the uid on a message.
            models.Index(fields=["im_uid"], name="im_bot_uid_idx"),
        ]

    def __str__(self):
        return f"ImBot({self.kind}, {self.name})"


class ImConversation(BaseModel):
    """we-meet 这一侧对 jusi 会话的**投影**,只存治理要用的字段(二期线 B)。

    ## 为什么要有它

    jusi **没有任何 admin 读接口** —— `POST /conversations` 是 create-or-get,
    拿它来查一个群不但查不到,还会**建**一个。所以 M 端「这个机器人装在哪个群」
    要显示群名,只能本地投影。

    而 we-meet 恰好是群名的**唯一写入方**:jusi 侧改 meta 只有
    `PATCH /admin/conversations/{cid}` 一条路,门是 admin HMAC。写路径顺手记
    一份,天然是准的;读路径零外部依赖 —— **治理页最该可用的时刻,恰好可能是
    IM 在抽风的时刻**。

    ## 与 MeetingConversation 的区别

    那张是「会议 ↔ 会话」的业务锚点(`cid` 由 room_id UUIDv5 派生,靠它做幂等);
    这张是展示投影。**会议群的名字不存这里** —— 读的时候 join
    `MeetingConversation` 取 `room.name`,房间改名立刻跟着改,不用同步。

    ## organization / created_by 是「写一次」语义

    只在为空时填。否则别组织的人改个群名就能把归属改走 —— 一个很安静的越权。
    """

    cid = models.CharField(_("conversation id"), max_length=64, unique=True)
    #: 归属组织。为空 = 这个群在本表建立之前就存在且还没被任何写路径碰过。
    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name="im_conversations",
        null=True,
        blank=True,
    )
    name = models.CharField(_("group name"), max_length=120, blank=True, default="")
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        related_name="created_im_conversations",
        null=True,
        blank=True,
    )

    class Meta:
        db_table = "meet_im_conversation"
        ordering = ("-created_at",)
        verbose_name = _("IM conversation")
        verbose_name_plural = _("IM conversations")

    def __str__(self):
        return f"ImConversation({self.cid}, {self.name or '—'})"


class ImUserPreference(BaseModel):
    """Small IM preferences that should follow a user across devices."""

    user = models.OneToOneField(
        User, on_delete=models.CASCADE, related_name="im_preference"
    )
    recent_emojis = models.JSONField(_("recent emojis"), default=list, blank=True)

    class Meta:
        db_table = "meet_im_user_preference"

    def __str__(self):
        return f"ImUserPreference({self.user_id})"


class OrganizationEmoji(BaseModel):
    """Organization-managed emoji stored in the private chat image bucket."""

    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="custom_emojis"
    )
    name = models.CharField(_("name"), max_length=32)
    object_key = models.CharField(_("object key"), max_length=500, unique=True)
    content_type = models.CharField(_("content type"), max_length=32)
    byte_size = models.PositiveIntegerField(_("byte size"))
    width = models.PositiveSmallIntegerField(_("width"))
    height = models.PositiveSmallIntegerField(_("height"))
    is_animated = models.BooleanField(_("animated"), default=False)
    sort_order = models.PositiveIntegerField(_("sort order"), default=0)
    is_active = models.BooleanField(_("active"), default=True)
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        related_name="created_organization_emojis",
        null=True,
        blank=True,
    )

    class Meta:
        db_table = "meet_organization_emoji"
        ordering = ("sort_order", "created_at")
        constraints = [
            models.UniqueConstraint(
                models.functions.Lower("name"),
                "organization",
                name="organization_emoji_name_ci_unique",
            )
        ]

    def __str__(self):
        return f"OrganizationEmoji({self.organization_id}, {self.name})"


class ImBotInstallation(BaseModel):
    """A bot's presence in one conversation, plus its webhook credential and the
    three security settings 飞书 offers (signature / keywords / IP allowlist).

    Exists because P23 removes bots from the jusi roster: once
    ``GET /v1/conversations/{cid}/members`` no longer returns them, "which bots
    are in this group" can only be answered locally.
    """

    bot = models.ForeignKey(
        ImBot, on_delete=models.CASCADE, related_name="installations"
    )
    cid = models.CharField(_("conversation id"), max_length=64, db_index=True)
    #: The last path segment of the webhook URL, and the only credential needed
    #: to post. Stored in the clear because 飞书 lets an owner re-read the
    #: address at any time and we match that; the compensating controls are
    #: owner-only reads, an audit entry per read, and one-click rotation.
    #: Null for built-ins — they are pushed to from inside, not from outside.
    webhook_token = models.CharField(
        _("webhook token"),
        max_length=64,
        unique=True,
        blank=True,
        null=True,
        editable=False,
    )
    signing_secret = models.CharField(
        _("signing secret"), max_length=64, blank=True, default="", editable=False
    )
    sign_verify_enabled = models.BooleanField(_("verify signature"), default=False)
    keywords = models.JSONField(
        _("keywords"),
        default=list,
        blank=True,
        help_text=_(
            "Any one must appear in the message text. Empty = no keyword gate."
        ),
    )
    ip_allowlist = models.JSONField(
        _("IP allowlist"),
        default=list,
        blank=True,
        help_text=_("IPs or CIDRs allowed to post. Empty = no IP gate."),
    )
    is_active = models.BooleanField(_("active"), default=True)
    #: Set when we disable an installation ourselves, e.g. the group is gone.
    disabled_reason = models.CharField(
        _("disabled reason"), max_length=32, blank=True, default=""
    )
    last_used_at = models.DateTimeField(_("last used at"), null=True, blank=True)
    message_count = models.PositiveIntegerField(_("messages sent"), default=0)
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        related_name="created_im_bot_installations",
        null=True,
        blank=True,
    )

    # ---- 出站回调(二期 A3)----
    #
    # ⚠️ **回调地址长在安装上,不在按钮里。** 这是 SSRF 面最重要的一刀:按钮里
    # 带 URL = 任何拿到 webhook token 的人都能把我们的服务器变成任意 HTTP 代理。
    callback_url = models.URLField(
        _("callback url"), max_length=500, blank=True, default=""
    )
    #: 出站签名用的密钥。**与 signing_secret 是两把** —— 共用一把的话,任何能
    #: 看到入站密钥的人都能伪造我们的出站调用。也用来派生点击人的假名。
    callback_secret = models.CharField(
        _("callback secret"), max_length=64, blank=True, default=""
    )
    #: 把点击人的**姓名**发给外部服务。默认关:webhook 是群主配的,但点按钮的
    #: 是每个成员 —— 默认外发他们的姓名,是群主替别人做的决定。
    #: 关掉时仍发一个每安装独立的假名(见 services/bot_callback),外部服务照样
    #: 能做幂等和限流,只是跨安装不可关联。
    callback_include_identity = models.BooleanField(
        _("send clicker name"), default=False
    )
    #: 连续失败计数。到阈值自动停用回调 —— 与「群没了自动停用安装」同一套路,
    #: 自愈,不需要 cron。成功一次即清零。
    callback_failure_count = models.PositiveIntegerField(
        _("consecutive callback failures"), default=0
    )
    #: 自动停用的开关。刻意不清空 callback_url —— 群主要能看到「配过什么」
    #: 才知道该修什么。
    callback_enabled = models.BooleanField(_("callback enabled"), default=True)

    class Meta:
        db_table = "meet_im_bot_installation"
        ordering = ("created_at",)
        verbose_name = _("IM bot installation")
        verbose_name_plural = _("IM bot installations")
        constraints = [
            models.UniqueConstraint(
                fields=["bot", "cid"], name="one_installation_per_bot_conversation"
            ),
        ]
        indexes = [
            # M 端治理页的两种排序。目的是**排序**不是救火 —— `cid` 早就
            # db_index=True 了,这两条只为 ORDER BY 不去扫全表。
            #
            # `-last_used_at` 是默认视角(「按最后活跃排」)。nulls_last 不能省:
            # 不加的话 Postgres 把 NULL 排在 DESC 的最前面,治理页第一屏全是
            # 从没用过的机器人 —— 正好是最不需要看的那批。
            models.Index(
                models.F("last_used_at").desc(nulls_last=True),
                name="im_install_last_used_idx",
            ),
            models.Index(fields=["bot", "-created_at"], name="im_install_bot_idx"),
        ]

    def __str__(self):
        return f"ImBotInstallation({self.bot_id} in {self.cid})"


class ImCardMessage(BaseModel):
    """一条已投递的 ``rich-card`` —— **服务端这一侧的权威记录**(二期 A2)。

    jusi 改不了已发消息的 body(全仓唯一的 ``UPDATE messages`` 是撤回的
    ``SET recalled_at``),所以按钮状态走**叠加层**:结果单独记在这里、单独
    广播,客户端渲染时叠在卡片上。

    这张表存在的三个理由,每一个都不能少:

    1. **按钮定义的权威副本。** 点击接口按 ``mid`` 查这里拿 cid 和按钮定义
       —— **不信客户端传的 cid,也不信 mid 属于哪个 cid**。
    2. **顺带解决转发副本。** 转发产生新 mid、没有这张表的行 → 点击 404。
       客户端本地剥 actions 只是不让用户看到死按钮,这里才是真正的兜底。
    3. **``values`` 的家。** 发送方给按钮的私有载荷(可能是 pipeline token)
       只住在这里,**永远不进 body**。见 ``services/bot_cards`` 文件头。
    """

    #: jusi 的消息 id。全局唯一 —— 一条消息只会有一张卡。
    mid = models.BigIntegerField(_("jusi message id"), unique=True)
    cid = models.CharField(_("conversation id"), max_length=64, db_index=True)
    #: 发这张卡的安装。删掉机器人时卡片记录跟着走(消息本身留在 jusi 里,
    #: 按钮从此点不动 —— 这比留一堆指向不存在机器人的活按钮诚实)。
    installation = models.ForeignKey(
        ImBotInstallation,
        on_delete=models.CASCADE,
        related_name="card_messages",
        null=True,
        blank=True,
    )
    #: ``button_id`` → ``{text, style, action, block, resolve}``。从 body 派生,
    #: 但**存下来而不是每次重新解析**:body 在 jusi 那边,取一次要过网络。
    buttons = models.JSONField(_("button definitions"), default=dict, blank=True)
    #: ``button_id`` → 发送方给的 value。**永不下发**。
    values = models.JSONField(_("button values"), default=dict, blank=True)
    #: 过期后按钮置灰。一张六个月前的「同意上线」按钮是负债,不是功能。
    expires_at = models.DateTimeField(_("expires at"), db_index=True)

    class Meta:
        db_table = "meet_im_card_message"
        ordering = ("-created_at",)
        verbose_name = _("IM card message")
        verbose_name_plural = _("IM card messages")

    def __str__(self):
        return f"ImCardMessage(mid={self.mid})"


class ImCardAction(BaseModel):
    """一次卡片按钮点击(二期 A2)。

    ``resolves`` 区分两种 actions 块:

    * ``once`` —— 同意/驳回这类互斥选择。第一个人点完就定局,靠下面那条
      **部分唯一约束**保证:并发时第二个人拿 409,而不是两条结果都写进去。
      约束放在数据库而不是应用层,因为「先查再写」在两个 worker 之间必然漏。
    * ``each`` —— 重跑这类。谁都能点,不 resolve、**也不广播** ——
      一张卡被点 200 次不该在 jusi 里留 200 条控制消息。
    """

    card = models.ForeignKey(
        ImCardMessage, on_delete=models.CASCADE, related_name="actions"
    )
    #: 这个按钮属于哪个 actions 块。``once`` 的互斥范围是**块**不是整张卡 ——
    #: 一张卡可以有「同意/驳回」和「重跑」两块,各管各的。
    block = models.CharField(_("actions block"), max_length=16)
    button_id = models.CharField(_("button id"), max_length=32)
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="im_card_actions"
    )
    #: 是否是「定局」的那一次点击。见类注释。
    resolves = models.BooleanField(_("resolves the block"), default=False)
    #: 客户端幂等键。与入站 webhook 的 ``X-Request-Id`` 同一个幂等思路 ——
    #: 这个代码库里只该有一种幂等观念。
    click_id = models.CharField(
        _("client click id"), max_length=64, blank=True, default=""
    )
    #: 广播给群里的结果文案(A2 是本地生成的「谁 做了什么」;A3 起上游可覆盖)。
    result_text = models.CharField(
        _("result text"), max_length=200, blank=True, default=""
    )
    #: 出站回调的状态(A3)。空 = 这次点击不触发回调(没配地址,或 each 块)。
    #:
    #: ``pending`` 是**惰性判超时**的:读取时发现 pending 且超过 5 分钟就读作
    #: timeout。仓库里没有 beat schedule,不为这一件事引入一个 —— Celery 挂了
    #: 的时候,一个也挂了的清理任务并不能救场。
    callback_state = models.CharField(
        _("callback state"), max_length=16, blank=True, default=""
    )
    #: 失败**分类**(timeout / refused / unreachable / address / redirect …)。
    #: **绝不存上游响应原文** —— 那是 SSRF 的信息回传通道。
    callback_error = models.CharField(
        _("callback error category"), max_length=32, blank=True, default=""
    )

    class Meta:
        db_table = "meet_im_card_action"
        ordering = ("created_at",)
        verbose_name = _("IM card action")
        verbose_name_plural = _("IM card actions")
        constraints = [
            # once 块的互斥:一个块只允许一条定局记录。
            models.UniqueConstraint(
                fields=["card", "block"],
                condition=models.Q(resolves=True),
                name="one_resolution_per_actions_block",
            ),
            # 同一个人带同一个 click_id 只记一次 —— 重放返回上次的结果。
            models.UniqueConstraint(
                fields=["card", "user", "click_id"],
                condition=~models.Q(click_id=""),
                name="card_click_id_is_idempotent",
            ),
        ]
        indexes = [models.Index(fields=["card", "block"])]

    def __str__(self):
        return f"ImCardAction({self.button_id} by {self.user_id})"


class RoomInvitee(BaseModel):
    """One person on a room's「建议参会」(suggested-participants) list (P5).

    Records that ``user`` was invited to ``room`` outside the calendar path —
    either rung from a group-originated call (``source="group"``) or picked in
    the in-meeting invite panel (``source="manual"``). Calendar invitees are NOT
    written here: scheduling already mirrors them as ``ResourceAccess`` members,
    and the suggested-participants endpoint unions both tables at read time.

    Deliberately carries NO permission semantics (unlike ``ResourceAccess``):
    being listed grants nothing — it only feeds the suggestion list, so writes
    can stay open to any participant without widening the room's ACL, and the
    invitee's own room list is not polluted.
    """

    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name="invitees")
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="room_invites"
    )
    invited_by = models.ForeignKey(
        User,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )
    source = models.CharField(
        max_length=16,
        choices=[("group", "group"), ("manual", "manual")],
        default="manual",
    )

    class Meta:
        db_table = "meet_room_invitee"
        ordering = ("created_at",)
        verbose_name = _("Room invitee")
        verbose_name_plural = _("Room invitees")
        constraints = [
            models.UniqueConstraint(
                fields=["room", "user"],
                name="one_invite_per_room_user",
            ),
        ]

    def __str__(self):
        return f"Invitee({self.user_id} → room {self.room_id}, {self.source})"


# --- P9 会议室 (physical meeting rooms) ---
#
# 命名警告:上面的 ``Room`` 是 LiveKit *视频会议房间*。这一节全部是**实体
# 会议室**(飞书「会议室管理」对标),前缀一律 ``MeetingRoom*`` / 表名
# ``meet_meeting_room*`` / 路由 ``meeting-rooms``。两者没有任何关系。


class MeetingRoomBookingScope(models.TextChoices):
    """Who may book a meeting room (M2; M1 always behaves as ORG)."""

    ORG = "org", _("Whole organization")
    DEPARTMENTS = "departments", _("Selected departments")


class MeetingRoomBookingStatus(models.TextChoices):
    """Lifecycle of a room booking.

    ``CONFIRMED`` / ``PENDING`` hold the slot (they participate in the exclusion
    constraint); ``CONFLICT`` / ``CANCELLED`` do not.
    """

    CONFIRMED = "confirmed", _("Confirmed")
    PENDING = "pending", _("Pending approval")
    # 重复日程滚动物化时抢不到房间的场次:日程照常存在,只是没订上会议室。
    CONFLICT = "conflict", _("Conflicted")
    CANCELLED = "cancelled", _("Cancelled")


class MeetingRoomBookingSource(models.TextChoices):
    """What created the booking."""

    EVENT = "event", _("Calendar event")
    MANUAL = "manual", _("Manual")
    MAINTENANCE = "maintenance", _("Maintenance")


#: Booking states that actually hold the slot. Kept in sync with the literal
#: list inside ``MeetingRoomBooking``'s exclusion constraint condition (the
#: constraint must inline literals so migrations stay stable).
ACTIVE_BOOKING_STATUSES = (
    MeetingRoomBookingStatus.CONFIRMED,
    MeetingRoomBookingStatus.PENDING,
)


# Fixed product vocabulary layered on top of the existing zero-based ``depth``.
MEETING_ROOM_LEVEL_TYPES = (
    "country_region",
    "city",
    "campus",
    "building",
)
MEETING_ROOM_BUILDING_DEPTH = len(MEETING_ROOM_LEVEL_TYPES) - 1


class TsTzRange(models.Func):
    """``tstzrange(start, end, bounds)`` — used by the no-overlap constraint.

    Must live at module level: migrations serialize it as ``core.models.TsTzRange``.
    """

    function = "TSTZRANGE"
    output_field = DateTimeRangeField()


class MeetingRoomNode(BaseModel):
    """A node in the fixed meeting-room location hierarchy.

    Same shape as :class:`Department`: adjacency list (``parent``) plus a
    materialized ``path`` of ancestor ids, so a subtree is a single
    ``path__startswith`` lookup. Arbitrary depth — 飞书 allows 地区 → 建筑 →
    楼层 and deeper. Reparenting rewrites descendant paths and is handled by the
    admin API's ``move`` action, not here.

    ``timezone`` is optional: an empty value inherits from the nearest ancestor
    that has one, falling back to ``settings.TIME_ZONE``.
    """

    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="meeting_room_nodes"
    )
    parent = models.ForeignKey(
        "self",
        on_delete=models.CASCADE,
        related_name="children",
        null=True,
        blank=True,
    )
    name = models.CharField(_("name"), max_length=255)
    # Slash-joined ancestor ids INCLUDING self (e.g. "<root>/<child>/").
    path = models.CharField(
        _("path"), max_length=1024, blank=True, default="", db_index=True
    )
    depth = models.PositiveIntegerField(_("depth"), default=0)
    sort_order = models.PositiveIntegerField(_("sort order"), default=0)
    timezone = TimeZoneField(
        _("timezone"),
        choices_display="WITH_GMT_OFFSET",
        use_pytz=False,
        null=True,
        blank=True,
        help_text=_("Empty inherits from the nearest ancestor that sets one."),
    )
    is_active = models.BooleanField(_("active"), default=True)
    deleted_at = models.DateTimeField(_("deleted at"), null=True, blank=True)

    class Meta:
        db_table = "meet_meeting_room_node"
        ordering = ("path", "sort_order", "name")
        verbose_name = _("Meeting room node")
        verbose_name_plural = _("Meeting room nodes")
        indexes = [
            models.Index(fields=["organization", "path"], name="mrnode_org_path_idx"),
        ]

    def __str__(self):
        return self.name

    def save(self, *args, **kwargs):
        # Must run BEFORE super().save(): BaseModel.save() calls full_clean().
        self._refresh_tree_fields()
        super().save(*args, **kwargs)

    @property
    def level_number(self):
        """One-based product level, or ``None`` for retired legacy data."""
        if 0 <= self.depth < len(MEETING_ROOM_LEVEL_TYPES):
            return self.depth + 1
        return None

    @property
    def level_type(self):
        """Stable API name for this node's semantic level."""
        if self.level_number is None:
            return None
        return MEETING_ROOM_LEVEL_TYPES[self.depth]

    @property
    def is_building(self):
        return self.depth == MEETING_ROOM_BUILDING_DEPTH

    def clean(self):
        super().clean()
        errors = {}
        expected_depth = self.parent.depth + 1 if self.parent_id else 0

        if self.parent_id:
            if self.parent.organization_id != self.organization_id:
                errors["parent"] = _("Parent must be in the same organization.")
            elif self.parent.deleted_at is not None or not self.parent.is_active:
                errors["parent"] = _("Parent must be active.")

        if expected_depth > MEETING_ROOM_BUILDING_DEPTH:
            errors["parent"] = _("A building cannot contain another level.")

        # A reparent may change ancestry, never the node's semantic level.
        if not self._state.adding:
            original_depth = (
                type(self)
                .objects.filter(pk=self.pk)
                .values_list("depth", flat=True)
                .first()
            )
            if original_depth is not None and expected_depth != original_depth:
                errors["parent"] = _("Moving a node cannot change its level type.")

        if expected_depth == 1:
            if not self.timezone:
                errors["timezone"] = _("City timezone is required.")
        elif self.timezone:
            errors["timezone"] = _("Timezone can only be configured on a city.")

        if errors:
            raise ValidationError(errors)

    def _refresh_tree_fields(self):
        """Derive path / depth from this row's id and its parent (self only)."""
        if self.parent_id:
            self.path = f"{self.parent.path}{self.id.hex}/"
            self.depth = self.parent.depth + 1
        else:
            self.path = f"{self.id.hex}/"
            self.depth = 0

    def ancestor_ids(self):
        """Ancestor ids parsed out of ``path``, root first, excluding self."""
        hexes = [h for h in self.path.strip("/").split("/") if h][:-1]
        return [uuid.UUID(h) for h in hexes]

    def resolve_timezone(self):
        """This node's timezone, or the nearest ancestor's, or the site default."""
        if self.timezone:
            return self.timezone
        ids = self.ancestor_ids()
        if not ids:
            return ZoneInfo(settings.TIME_ZONE)
        ancestors = {
            node.id: node
            for node in MeetingRoomNode.objects.filter(id__in=ids).only(
                "id", "timezone"
            )
        }
        for node_id in reversed(ids):  # nearest ancestor first
            node = ancestors.get(node_id)
            if node is not None and node.timezone:
                return node.timezone
        return ZoneInfo(settings.TIME_ZONE)


class MeetingRoomFacility(BaseModel):
    """A bookable room's equipment type (TV, projector, whiteboard, ...).

    A dictionary table rather than a JSON tag array: 飞书 lets admins add their
    own facility types, and renaming / reordering / retiring one must not require
    rewriting every room row.
    """

    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="meeting_room_facilities"
    )
    name = models.CharField(_("name"), max_length=64)
    code = models.CharField(
        _("code"),
        max_length=32,
        blank=True,
        default="",
        help_text=_("Stable key the clients map to an icon (tv, projector, ...)."),
    )
    sort_order = models.PositiveIntegerField(_("sort order"), default=0)
    is_active = models.BooleanField(_("active"), default=True)

    class Meta:
        db_table = "meet_meeting_room_facility"
        ordering = ("sort_order", "name")
        verbose_name = _("Meeting room facility")
        verbose_name_plural = _("Meeting room facilities")
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "name"],
                name="mrfacility_uniq_org_name",
                violation_error_message=_("A facility with this name already exists."),
            ),
        ]

    def __str__(self):
        return self.name


class MeetingRoom(BaseModel):
    """A physical, bookable meeting room.

    Attached to a building :class:`MeetingRoomNode`; ``floor`` is a required
    room attribute rather than another location-tree level. Occupancy lives in
    :class:`MeetingRoomBooking`, never on this row.

    The ``booking_scope`` / ``requires_approval`` / ``max_booking_minutes`` /
    ``advance_booking_days`` fields are M2 policy knobs landed up front so
    enabling them later is a code change, not a migration. M1 only enforces
    ``is_active``.
    """

    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="meeting_rooms"
    )
    node = models.ForeignKey(
        MeetingRoomNode, on_delete=models.PROTECT, related_name="rooms"
    )
    name = models.CharField(_("name"), max_length=255, blank=True, default="")
    code = models.CharField(_("code"), max_length=64)
    floor = models.CharField(_("floor"), max_length=32)
    capacity = models.PositiveIntegerField(
        _("capacity"), default=0, help_text=_("0 means unspecified.")
    )
    description = models.TextField(_("description"), blank=True, default="")
    facilities = models.ManyToManyField(
        MeetingRoomFacility,
        blank=True,
        related_name="rooms",
        db_table="meet_meeting_room_facility_link",
    )
    sort_order = models.PositiveIntegerField(_("sort order"), default=0)

    is_active = models.BooleanField(_("active"), default=True)
    disabled_reason = models.CharField(
        _("disabled reason"), max_length=255, blank=True, default=""
    )

    # --- M2 policy knobs (fields only; no behaviour in M1) ---
    booking_scope = models.CharField(
        max_length=20,
        choices=MeetingRoomBookingScope.choices,
        default=MeetingRoomBookingScope.ORG,
    )
    bookable_departments = models.ManyToManyField(
        Department,
        blank=True,
        related_name="bookable_meeting_rooms",
        db_table="meet_meeting_room_department",
    )
    requires_approval = models.BooleanField(_("requires approval"), default=False)
    approval_template = models.ForeignKey(
        "ApprovalTemplate",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="meeting_rooms",
    )
    max_booking_minutes = models.PositiveIntegerField(null=True, blank=True)
    advance_booking_days = models.PositiveIntegerField(null=True, blank=True)

    deleted_at = models.DateTimeField(_("deleted at"), null=True, blank=True)

    class Meta:
        db_table = "meet_meeting_room"
        ordering = ("sort_order", "code", "name")
        verbose_name = _("Meeting room")
        verbose_name_plural = _("Meeting rooms")
        indexes = [
            models.Index(
                fields=["organization", "is_active"], name="mroom_org_active_idx"
            ),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["node", "code"],
                condition=models.Q(deleted_at__isnull=True),
                name="mroom_uniq_node_code",
                violation_error_message=_("A room with this code already exists."),
            ),
            models.CheckConstraint(
                condition=~models.Q(code=""),
                name="mroom_code_not_blank",
                violation_error_message=_("Room code is required."),
            ),
        ]

    def __str__(self):
        return f"{self.code} ({self.name})" if self.name else self.code

    def clean(self):
        super().clean()
        errors = {}
        self.name = (self.name or "").strip()
        self.code = (self.code or "").strip()
        self.floor = (self.floor or "").strip()
        if not self.code:
            errors["code"] = _("Room code is required.")
        if not self.floor:
            errors["floor"] = _("Floor is required.")
        if self.node_id:
            if self.node.organization_id != self.organization_id:
                errors["node"] = _(
                    "Meeting room building must be in the same organization."
                )
            elif self.node.deleted_at is not None or not self.node.is_active:
                errors["node"] = _("Meeting room building must be active.")
            elif not self.node.is_building:
                errors["node"] = _("Meeting rooms can only be added to a building.")
        if errors:
            raise ValidationError(errors)


class MeetingRoomBooking(BaseModel):
    """One room held for one time range.

    A row per *occurrence*: a weekly event books one row per materialized
    occurrence, so the database exclusion constraint below is what actually
    prevents double-booking — no application-level "check then insert" race.

    Deliberately a separate table rather than an FK on :class:`CalendarEvent`:
    M2 maintenance / manual holds are not events, and two tables could not share
    one exclusion constraint.

    **Write only through** ``core.services.meeting_room_booking`` — that module
    owns the savepoint + conflict-translation logic that keeps bookings in sync
    with their events.
    """

    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="meeting_room_bookings"
    )
    room = models.ForeignKey(
        MeetingRoom, on_delete=models.CASCADE, related_name="bookings"
    )
    event = models.ForeignKey(
        CalendarEvent,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="room_bookings",
        help_text=_("Null for a manual / maintenance hold (M2)."),
    )
    booked_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="meeting_room_bookings",
    )
    start_at = models.DateTimeField(_("start at"))
    end_at = models.DateTimeField(_("end at"))
    status = models.CharField(
        max_length=20,
        choices=MeetingRoomBookingStatus.choices,
        default=MeetingRoomBookingStatus.CONFIRMED,
    )
    source = models.CharField(
        max_length=20,
        choices=MeetingRoomBookingSource.choices,
        default=MeetingRoomBookingSource.EVENT,
    )
    title = models.CharField(
        _("title"),
        max_length=255,
        blank=True,
        default="",
        help_text=_(
            "Label for manual / maintenance holds; event holds read the event."
        ),
    )
    approval_instance = models.ForeignKey(
        "ApprovalInstance",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="meeting_room_bookings",
    )
    cancelled_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "meet_meeting_room_booking"
        ordering = ("start_at",)
        verbose_name = _("Meeting room booking")
        verbose_name_plural = _("Meeting room bookings")
        indexes = [
            models.Index(fields=["room", "start_at"], name="mrbooking_room_start_idx"),
            models.Index(
                fields=["organization", "start_at"], name="mrbooking_org_start_idx"
            ),
        ]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(end_at__gt=models.F("start_at")),
                name="mrbooking_end_after_start",
                violation_error_message=_("End must be after start."),
            ),
            # One live booking per (event, room) so a resync never fans out.
            models.UniqueConstraint(
                fields=["event", "room"],
                condition=models.Q(event__isnull=False) & ~models.Q(status="cancelled"),
                name="mrbooking_uniq_event_room",
            ),
            # The double-booking guard. Half-open [start, end) so 10-11 and
            # 11-12 are back-to-back, not a conflict — same rule as the
            # calendar freebusy endpoint. Status literals are inlined on
            # purpose: referencing a constant makes makemigrations churn.
            ExclusionConstraint(
                name="mrbooking_no_overlap",
                expressions=[
                    ("room", RangeOperators.EQUAL),
                    (
                        TsTzRange("start_at", "end_at", RangeBoundary()),
                        RangeOperators.OVERLAPS,
                    ),
                ],
                condition=models.Q(status__in=["confirmed", "pending"]),
                violation_error_message=_(
                    "This meeting room is already booked for that time."
                ),
            ),
        ]

    def __str__(self):
        return f"{self.room_id} [{self.start_at:%Y-%m-%d %H:%M} → {self.end_at:%H:%M}]"

    def save(self, *args, **kwargs):
        # Skip full_clean's constraint pre-check: the DB exclusion constraint is
        # the single arbiter. Without this the *same* conflict raises
        # ValidationError when uncontended and IntegrityError under concurrency,
        # and callers inevitably catch only one of them.
        self.full_clean(validate_constraints=False)
        super(BaseModel, self).save(*args, **kwargs)  # pylint: disable=bad-super-call
