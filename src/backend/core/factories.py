"""
Core application factories
"""

from datetime import timedelta
from io import BytesIO

from django.conf import settings
from django.contrib.auth.hashers import make_password
from django.core.files.storage import default_storage
from django.utils import timezone as django_timezone
from django.utils.text import slugify

import factory.fuzzy
from faker import Faker

from core import models, utils

fake = Faker()


class UserFactory(factory.django.DjangoModelFactory):
    """A factory to random users for testing purposes."""

    class Meta:
        model = models.User

    sub = factory.Sequence(lambda n: f"user{n!s}")
    email = factory.Faker("email")
    full_name = factory.Faker("name")
    short_name = factory.Faker("first_name")
    language = factory.fuzzy.FuzzyChoice([lang[0] for lang in settings.LANGUAGES])
    password = make_password("password")


class OrganizationFactory(factory.django.DjangoModelFactory):
    """Create fake organizations for testing."""

    class Meta:
        model = models.Organization

    name = factory.Faker("company")
    slug = factory.Sequence(lambda n: f"org-{n!s}")


class DepartmentFactory(factory.django.DjangoModelFactory):
    """Create fake departments for testing."""

    class Meta:
        model = models.Department

    organization = factory.SubFactory(OrganizationFactory)
    name = factory.Sequence(lambda n: f"Department {n!s}")


class MembershipFactory(factory.django.DjangoModelFactory):
    """Create fake memberships for testing.

    ``department`` shares the membership's organization so the row is always
    internally consistent.
    """

    class Meta:
        model = models.Membership

    organization = factory.SubFactory(OrganizationFactory)
    user = factory.SubFactory(UserFactory)
    department = factory.SubFactory(
        DepartmentFactory, organization=factory.SelfAttribute("..organization")
    )


class TaskListGroupFactory(factory.django.DjangoModelFactory):
    """Create a fake organization task-list group."""

    class Meta:
        model = models.TaskListGroup

    organization = factory.SubFactory(OrganizationFactory)
    creator = factory.SubFactory(UserFactory)
    name = factory.Sequence(lambda n: f"Task list group {n!s}")


class TaskListFactory(factory.django.DjangoModelFactory):
    """Create a fake organization task list."""

    class Meta:
        model = models.TaskList

    organization = factory.SubFactory(OrganizationFactory)
    creator = factory.SubFactory(UserFactory)
    name = factory.Sequence(lambda n: f"Task list {n!s}")


class TaskGroupFactory(factory.django.DjangoModelFactory):
    """Create a fake ordered group within a task list."""

    class Meta:
        model = models.TaskGroup

    task_list = factory.SubFactory(TaskListFactory)
    name = factory.Sequence(lambda n: f"Task group {n!s}")


class ResourceFactory(factory.django.DjangoModelFactory):
    """Create fake resources for testing."""

    class Meta:
        model = models.Resource
        skip_postgeneration_save = True

    @factory.post_generation
    def users(self, create, extracted, **kwargs):
        """Add users to resource from a given list of users."""
        if create and extracted:
            for item in extracted:
                if isinstance(item, models.User):
                    UserResourceAccessFactory(resource=self, user=item)
                else:
                    UserResourceAccessFactory(resource=self, user=item[0], role=item[1])

        self.save()


class UserResourceAccessFactory(factory.django.DjangoModelFactory):
    """Create fake resource user accesses for testing."""

    class Meta:
        model = models.ResourceAccess

    resource = factory.SubFactory(ResourceFactory)
    user = factory.SubFactory(UserFactory)
    role = factory.fuzzy.FuzzyChoice(models.RoleChoices.values)


class RoomFactory(ResourceFactory):
    """Create fake rooms for testing."""

    class Meta:
        model = models.Room

    name = factory.Faker("catch_phrase")
    slug = factory.LazyAttribute(lambda o: slugify(o.name))
    access_level = factory.fuzzy.FuzzyChoice(models.RoomAccessLevel)


class MeetingSessionFactory(factory.django.DjangoModelFactory):
    """Create a concrete meeting session for tests."""

    class Meta:
        model = models.MeetingSession

    room = factory.SubFactory(RoomFactory)
    livekit_room_sid = factory.Sequence(lambda n: f"RM_test_{n}")
    status = models.MeetingSession.Status.ACTIVE
    started_at = factory.LazyFunction(django_timezone.now)
    start_source = models.MeetingSession.StartSource.LIVEKIT_ROOM


class MeetingParticipationFactory(factory.django.DjangoModelFactory):
    """Create one participant connection interval for tests."""

    class Meta:
        model = models.MeetingParticipation

    session = factory.SubFactory(MeetingSessionFactory)
    livekit_participant_sid = factory.Sequence(lambda n: f"PA_test_{n}")
    identity = factory.Sequence(lambda n: f"participant-{n}")
    display_name = factory.Faker("name")
    kind = "standard"
    joined_at = factory.LazyFunction(django_timezone.now)


class RecordingFactory(factory.django.DjangoModelFactory):
    """Create fake recording for testing."""

    class Meta:
        model = models.Recording
        skip_postgeneration_save = True

    room = factory.SubFactory(RoomFactory)
    status = models.RecordingStatusChoices.INITIATED
    mode = models.RecordingModeChoices.SCREEN_RECORDING
    worker_id = None

    @factory.post_generation
    def users(self, create, extracted, **kwargs):
        """Add users to recording from a given list of users with or without roles."""
        if create and extracted:
            for item in extracted:
                if isinstance(item, models.User):
                    UserRecordingAccessFactory(recording=self, user=item)
                else:
                    UserRecordingAccessFactory(
                        recording=self, user=item[0], role=item[1]
                    )

            self.save()


class UserRecordingAccessFactory(factory.django.DjangoModelFactory):
    """Create fake recording user accesses for testing."""

    class Meta:
        model = models.RecordingAccess

    recording = factory.SubFactory(RecordingFactory)
    user = factory.SubFactory(UserFactory)
    role = factory.fuzzy.FuzzyChoice(models.RoleChoices.values)


class TeamRecordingAccessFactory(factory.django.DjangoModelFactory):
    """Create fake recording team accesses for testing."""

    class Meta:
        model = models.RecordingAccess

    recording = factory.SubFactory(RecordingFactory)
    team = factory.Sequence(lambda n: f"team{n}")
    role = factory.fuzzy.FuzzyChoice(models.RoleChoices.values)


class ApplicationFactory(factory.django.DjangoModelFactory):
    """Create fake applications for testing."""

    class Meta:
        model = models.Application

    name = factory.Faker("company")
    is_active = True
    client_id = factory.LazyFunction(utils.generate_client_id)
    client_secret = factory.LazyFunction(utils.generate_client_secret)
    scopes = []

    class Params:
        """Factory traits for common application configurations."""

        with_all_scopes = factory.Trait(
            scopes=[
                models.ApplicationScope.ROOMS_LIST,
                models.ApplicationScope.ROOMS_RETRIEVE,
                models.ApplicationScope.ROOMS_CREATE,
                models.ApplicationScope.ROOMS_UPDATE,
                models.ApplicationScope.ROOMS_DELETE,
            ]
        )


class ApplicationDomainFactory(factory.django.DjangoModelFactory):
    """Create fake application domains for testing."""

    class Meta:
        model = models.ApplicationDomain

    domain = factory.Faker("domain_name")
    application = factory.SubFactory(ApplicationFactory)


class FileFactory(factory.django.DjangoModelFactory):
    """A factory to create files"""

    class Meta:
        model = models.File
        skip_postgeneration_save = True

    title = factory.Sequence(lambda n: f"file{n}")
    creator = factory.SubFactory(UserFactory)
    deleted_at = None
    type = factory.fuzzy.FuzzyChoice([t[0] for t in models.FileTypeChoices.choices])
    filename = factory.lazy_attribute(lambda o: fake.file_name())
    upload_state = None
    size = None

    @factory.post_generation
    def update_upload_state(self, create, extracted, **kwargs):
        """Change the upload state of a file."""
        if create and extracted:
            self.upload_state = extracted
            self.save()

    @factory.post_generation
    def upload_bytes(self, create, extracted, **kwargs):
        """Save content of the file into the storage"""
        if create and extracted is not None:
            content = (
                extracted
                if isinstance(extracted, bytes)
                else str(extracted).encode("utf-8")
            )

            self.filename = kwargs.get("filename", self.filename or "content.txt")
            self.size = len(content)
            self.save()

            default_storage.save(self.file_key, BytesIO(content))


# --- P9 会议室 (physical meeting rooms) ---


class MeetingRoomNodeFactory(factory.django.DjangoModelFactory):
    """Create fake meeting-room hierarchy nodes for testing."""

    class Meta:
        model = models.MeetingRoomNode

    organization = factory.SubFactory(OrganizationFactory)
    name = factory.Sequence(lambda n: f"Level {n!s}")
    parent = None
    # Cities own the timezone; all other levels inherit it.
    timezone = factory.LazyAttribute(
        lambda node: (
            "UTC" if node.parent is not None and node.parent.depth == 0 else None
        )
    )


class MeetingRoomFacilityFactory(factory.django.DjangoModelFactory):
    """Create fake meeting-room facilities for testing."""

    class Meta:
        model = models.MeetingRoomFacility

    organization = factory.SubFactory(OrganizationFactory)
    name = factory.Sequence(lambda n: f"Facility {n!s}")
    code = factory.Sequence(lambda n: f"facility-{n!s}")


def MeetingRoomBuildingFactory(organization=None, city_timezone="UTC", **kwargs):
    """Create one complete country -> city -> campus -> building path."""
    organization = organization or OrganizationFactory()
    country = MeetingRoomNodeFactory(organization=organization)
    city = MeetingRoomNodeFactory(
        organization=organization,
        parent=country,
        timezone=city_timezone,
    )
    campus = MeetingRoomNodeFactory(organization=organization, parent=city)
    return MeetingRoomNodeFactory(organization=organization, parent=campus, **kwargs)


class MeetingRoomFactory(factory.django.DjangoModelFactory):
    """Create fake meeting rooms for testing.

    The node defaults to one in the *same* organization as the room, so a bare
    ``MeetingRoomFactory()`` never produces a cross-org row.
    """

    class Meta:
        model = models.MeetingRoom

    organization = factory.SubFactory(OrganizationFactory)

    @factory.lazy_attribute
    def node(self):
        return MeetingRoomBuildingFactory(organization=self.organization)

    name = factory.Sequence(lambda n: f"Meeting room {n!s}")
    code = factory.Sequence(lambda n: f"R{n + 1:04d}")
    floor = "6F"
    capacity = 10


class CalendarEventFactory(factory.django.DjangoModelFactory):
    """Create fake calendar events for testing."""

    class Meta:
        model = models.CalendarEvent

    organization = factory.SubFactory(OrganizationFactory)
    organizer = factory.SubFactory(UserFactory)
    title = factory.Sequence(lambda n: f"Event {n!s}")
    start_at = factory.LazyFunction(lambda: django_timezone.now() + timedelta(days=1))
    end_at = factory.LazyAttribute(lambda o: o.start_at + timedelta(hours=1))
