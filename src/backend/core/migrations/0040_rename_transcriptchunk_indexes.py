# Mechanical rename to match Django's auto-naming for indexes on TranscriptChunk.
# Original named indexes (`tchunk_room_chunk_idx`, `tchunk_summary_idx`) were
# defined explicitly on the model but later removed without a follow-up migration;
# Django re-derives names from a hash of the columns. Splitting this away from
# the P5 MeetingConversation migration keeps that schema change focused.

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0039_meetingconversation_and_more'),
    ]

    operations = [
        migrations.RenameIndex(
            model_name='transcriptchunk',
            new_name='core_transc_room_id_22c8b7_idx',
            old_name='tchunk_room_chunk_idx',
        ),
        migrations.RenameIndex(
            model_name='transcriptchunk',
            new_name='core_transc_summary_bd5059_idx',
            old_name='tchunk_summary_idx',
        ),
    ]
