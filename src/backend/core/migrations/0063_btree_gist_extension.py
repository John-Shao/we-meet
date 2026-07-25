"""Enable btree_gist, required by the meeting-room no-overlap constraint.

``MeetingRoomBooking`` excludes overlapping ``tstzrange``s *per room*, which
means a GiST index has to hold a plain equality operator on the ``room_id``
uuid column — that operator class ships in btree_gist.

Kept in its own migration on purpose: creating an extension and then building a
GiST index that depends on it inside the same transaction fails on some managed
PostgreSQL setups. Same deployment requirement as the existing pg_trgm
migration (0002), so no new DB privileges are needed.
"""

from django.contrib.postgres.operations import BtreeGistExtension
from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0062_calendarevent_source_conversation_id"),
    ]

    operations = [
        BtreeGistExtension(),
    ]
