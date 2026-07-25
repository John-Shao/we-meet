"""
Declare and configure the models for the Meet core application
# pylint: disable=too-many-lines
"""
# pylint: disable=too-many-lines

import secrets
import uuid
from datetime import datetime, time as dt_time, timedelta
from logging import getLogger
from os.path import splitext
from typing import List, Optional
from zoneinfo import ZoneInfo

from django.conf import settings
from django.contrib.auth import models as auth_models
from django.contrib.auth.base_user import AbstractBaseUser
from django.contrib.postgres.constraints import ExclusionConstraint
from django.contrib.postgres.fields import ArrayField, DateTimeRangeField, RangeBoundary, RangeOperators
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

        Returns the ``team_key`` of each *direct*, active department membership.
        Subtree expansion is intentionally NOT applied (a manager of a parent
        department does not implicitly gain access to child-department
        resources) — that stays an explicit, opt-in grant per roadmap P1.

        Memoized on the instance: ``BaseAccessManager.filter_user`` and the
        viewset querysets call this once per request on ``request.user``, so the
        cache turns N access-row checks into a single query without needing a
        cross-request cache.
        """
        if not hasattr(self, "_teams_cache"):
            self._teams_cache = list(
                Membership.objects.filter(
                    user=self,
                    status=MembershipStatusChoices.ACTIVE,
                    department__isnull=False,
                    department__is_active=True,
                    department__deleted_at__isnull=True,
                ).values_list("department__team_key", flat=True)
            )
        return self._teams_cache


def get_resource_roles(resource: models.Model, user: User) -> List[str]:
    """
    Get all roles assigned to a user for a specific resource, including team-based roles.

    Args:
        resource: The resource to check permissions for
        user: The user to get roles for

    Returns:
        List of role strings assigned to the user
    """
    if not user.is_authenticated:
        return []

    # Use pre-annotated roles if available from viewset optimization
    if hasattr(resource, "user_roles"):
        return resource.user_roles or []

    try:
        return list(
            resource.accesses.filter_user(user)
            .values_list("role", flat=True)
            .distinct()
        )
    except (IndexError, models.ObjectDoesNotExist):
        return []


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
    team = models.CharField(max_length=100, blank=True)
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
        return str(
            uuid.uuid5(uuid.NAMESPACE_OID, f"jusi-light-im:room:{room_id}")
        )

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
    is_active = models.BooleanField(_("active"), default=True)
    deleted_at = models.DateTimeField(_("deleted at"), null=True, blank=True)

    class Meta:
        db_table = "meet_department"
        ordering = ("path", "sort_order", "name")
        verbose_name = _("Department")
        verbose_name_plural = _("Departments")

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
            self.team_key = f"dept:{self.id.hex}"
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
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="memberships"
    )
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
        ]

    def __str__(self):
        dept = self.department.name if self.department_id else "<org-level>"
        return f"{self.user} @ {dept} ({self.get_org_role_display()})"


# --- P2 日历 / 日程 ---


class EventStatusChoices(models.TextChoices):
    """Lifecycle of a calendar event."""

    CONFIRMED = "confirmed", _("Confirmed")
    CANCELLED = "cancelled", _("Cancelled")


class EventVisibilityChoices(models.TextChoices):
    """Who may see an event's details (MVP: org-scoped + organizer/attendee)."""

    DEFAULT = "default", _("Default")
    PRIVATE = "private", _("Private")


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
    the event. MVP is single-occurrence; ``recurrence`` / ``recurrence_parent``
    are present but not yet expanded.
    """

    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="calendar_events"
    )
    organizer = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="organized_events"
    )
    title = models.CharField(_("title"), max_length=255)
    description = models.TextField(_("description"), blank=True, default="")
    start_at = models.DateTimeField(_("start at"))
    end_at = models.DateTimeField(_("end at"))
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
        help_text=_("The video room to join (created with the event); SET_NULL "
                    "so the room + IM group outlive the event."),
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
        help_text=_("Idempotency guard: set once the IM reminder has been sent."),
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
    # P8:从 IM 会话日历抽屉创建时记录来源会话 cid;改时间/增删参会人/取消时
    # 由 calendar_im_notify 向该会话推变更卡片。空 = 非会话来源,不推送。
    # 刻意不校验有效性(建日程不依赖 jusi 可达);物化子场次不复制该字段。
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
            # P2-M1 物化幂等:同一主事件的同一发生时刻只允许一行子事件。
            models.UniqueConstraint(
                fields=["recurrence_parent", "start_at"],
                condition=models.Q(recurrence_parent__isnull=False),
                name="calevent_parent_start_uniq",
            ),
        ]

    def __str__(self):
        return f"{self.title} @ {self.start_at:%Y-%m-%d %H:%M}"


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
    MEMBER_DEPARTMENT_CHANGE = "member.department_change", _("Member department changed")
    MEMBER_SUSPEND = "member.suspend", _("Member suspended")
    MEMBER_RESTORE = "member.restore", _("Member restored")
    MEMBER_REMOVE = "member.remove", _("Member removed")
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

    Matched by email when the invitee logs in (OIDC claim hook), which then
    creates their Membership with the invited department / role / title instead
    of the plain org-level default. Deliberately email-only — the login claim
    carries an email but no phone, so phone-OTP-only accounts can't be matched
    (they fall back to the default membership).
    """

    organization = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="invitations"
    )
    email = models.EmailField(_("email"))
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
                condition=models.Q(status="pending"),
                name="one_pending_invite_per_email_org",
                violation_error_message=_(
                    "A pending invitation already exists for this email."
                ),
            ),
        ]

    def __str__(self):
        return f"{self.email} → {self.organization_id} ({self.status})"


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

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="push_tokens"
    )
    provider = models.CharField(
        _("provider"),
        max_length=16,
        choices=Provider.choices,
        default=Provider.GETUI,
    )
    cid = models.CharField(_("push client id"), max_length=128)
    device_id = models.CharField(
        _("device id"), max_length=128, blank=True, default=""
    )
    platform = models.CharField(
        _("platform"), max_length=16, blank=True, default=""
    )
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

    class Meta:
        db_table = "meet_push_preference"
        verbose_name = _("push preference")
        verbose_name_plural = _("push preferences")

    def __str__(self):
        state = "on" if self.quiet_enabled else "off"
        return f"PushPreference({self.user_id}, quiet={state} {self.quiet_start}-{self.quiet_end})"


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

    room = models.ForeignKey(
        Room, on_delete=models.CASCADE, related_name="invitees"
    )
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


class TsTzRange(models.Func):
    """``tstzrange(start, end, bounds)`` — used by the no-overlap constraint.

    Must live at module level: migrations serialize it as ``core.models.TsTzRange``.
    """

    function = "TSTZRANGE"
    output_field = DateTimeRangeField()


class MeetingRoomNode(BaseModel):
    """A node in the meeting-room hierarchy (region / building / floor / ...).

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

    Attached to a :class:`MeetingRoomNode` (its floor / building). Occupancy
    lives in :class:`MeetingRoomBooking`, never on this row.

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
    name = models.CharField(_("name"), max_length=255)
    code = models.CharField(_("code"), max_length=64, blank=True, default="")
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
        ordering = ("sort_order", "name")
        verbose_name = _("Meeting room")
        verbose_name_plural = _("Meeting rooms")
        indexes = [
            models.Index(
                fields=["organization", "is_active"], name="mroom_org_active_idx"
            ),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "code"],
                condition=models.Q(deleted_at__isnull=True) & ~models.Q(code=""),
                name="mroom_uniq_org_code",
                violation_error_message=_("A room with this code already exists."),
            ),
        ]

    def __str__(self):
        return self.name


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
        help_text=_("Label for manual / maintenance holds; event holds read the event."),
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
