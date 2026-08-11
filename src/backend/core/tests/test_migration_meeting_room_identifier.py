"""Pure regression tests for the meeting-room identifier data migration."""

import importlib
from types import SimpleNamespace


class _FakeQuery(list):
    def order_by(self, *_fields):
        return self

    def update(self, **values):
        for room in self:
            for field, value in values.items():
                setattr(room, field, value)


class _FakeManager:
    def __init__(self, rooms):
        self.rooms = rooms

    def filter(self, **filters):
        if "deleted_at__isnull" in filters:
            is_null = filters["deleted_at__isnull"]
            return _FakeQuery(
                room for room in self.rooms if (room.deleted_at is None) == is_null
            )
        return _FakeQuery(room for room in self.rooms if room.id == filters["pk"])


def test_room_code_migration_normalizes_and_deduplicates_identifiers():
    migration = importlib.import_module(
        "core.migrations.0090_meeting_room_optional_name_required_code"
    )

    assert migration.unique_room_code(" R1208 ", "Alias", "ignored", set()) == ("R1208")
    assert migration.unique_room_code("", " Tide ", "ignored", set()) == "Tide"
    assert migration.unique_room_code("", "", "abcdef12-rest", set()) == (
        "ROOM-ABCDEF12"
    )
    assert (
        migration.unique_room_code("R1208", "", "ignored", {"R1208", "R1208-2"})
        == "R1208-3"
    )
    long_code = "A" * 64
    deduplicated = migration.unique_room_code(long_code, "", "ignored", {long_code})
    assert len(deduplicated) == 64
    assert deduplicated.endswith("-2")


def test_room_code_migration_preserves_active_code_before_deleted_duplicate():
    migration = importlib.import_module(
        "core.migrations.0090_meeting_room_optional_name_required_code"
    )
    deleted = SimpleNamespace(
        id="deleted",
        pk="deleted",
        node_id="building",
        code="R1208",
        name="",
        deleted_at=object(),
    )
    active = SimpleNamespace(
        id="active",
        pk="active",
        node_id="building",
        code="R1208",
        name="",
        deleted_at=None,
    )
    model = SimpleNamespace(objects=_FakeManager([deleted, active]))
    apps = SimpleNamespace(get_model=lambda *_args: model)

    migration.fill_missing_room_codes(apps, None)

    assert active.code == "R1208"
    assert deleted.code == "R1208-2"
