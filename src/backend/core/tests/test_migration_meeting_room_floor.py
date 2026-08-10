"""Regression coverage for the meeting-room floor attribute migration."""

from django.db import connection
from django.db.migrations.executor import MigrationExecutor

import pytest


@pytest.mark.django_db(transaction=True)
def test_nonempty_legacy_hierarchy_migrates_to_required_floor_attribute():
    """The destructive reset must commit before PostgreSQL alters the table."""
    executor = MigrationExecutor(connection)
    executor.migrate([("core", "0088_retire_legacy_meeting_room_hierarchy")])
    old_apps = executor.loader.project_state(
        [("core", "0088_retire_legacy_meeting_room_hierarchy")]
    ).apps

    Organization = old_apps.get_model("core", "Organization")
    MeetingRoomNode = old_apps.get_model("core", "MeetingRoomNode")
    MeetingRoom = old_apps.get_model("core", "MeetingRoom")

    organization = Organization.objects.create(name="Legacy", slug="legacy")
    parent = None
    for depth, name in enumerate(("China", "Shenzhen", "Campus", "Tower", "12F")):
        node = MeetingRoomNode.objects.create(
            organization=organization,
            parent=parent,
            name=name,
            path="",
            depth=depth,
        )
        parent = node
    MeetingRoom.objects.create(
        organization=organization,
        node=parent,
        name="R1208",
    )

    executor = MigrationExecutor(connection)
    executor.migrate([("core", "0089_meeting_room_floor_attribute")])
    new_apps = executor.loader.project_state(
        [("core", "0089_meeting_room_floor_attribute")]
    ).apps

    NewMeetingRoomNode = new_apps.get_model("core", "MeetingRoomNode")
    NewMeetingRoom = new_apps.get_model("core", "MeetingRoom")
    assert not NewMeetingRoomNode.objects.exists()
    assert not NewMeetingRoom.objects.exists()

    building = NewMeetingRoomNode.objects.create(
        organization_id=organization.id,
        name="New tower",
        path="",
        depth=3,
    )
    created = NewMeetingRoom.objects.create(
        organization_id=organization.id,
        node=building,
        name="R1208",
        floor="12F",
    )
    assert created.floor == "12F"
