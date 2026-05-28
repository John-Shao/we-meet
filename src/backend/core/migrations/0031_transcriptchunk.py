# Sprint 2.4: TranscriptChunk — RAG retrieval units with embeddings.
# Path D (numpy + JSONField), no pgvector dependency. See
# docs/features/personal_ai_rag.md §11.1 for the future pgvector path.
import uuid

import django.contrib.postgres.fields
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0030_summary_actionitem"),
    ]

    operations = [
        migrations.CreateModel(
            name="TranscriptChunk",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        help_text="primary key for the record as UUID",
                        primary_key=True,
                        serialize=False,
                        verbose_name="id",
                    ),
                ),
                (
                    "created_at",
                    models.DateTimeField(
                        auto_now_add=True,
                        help_text="date and time at which a record was created",
                        verbose_name="created on",
                    ),
                ),
                (
                    "updated_at",
                    models.DateTimeField(
                        auto_now=True,
                        help_text="date and time at which a record was last updated",
                        verbose_name="updated on",
                    ),
                ),
                (
                    "chunk_index",
                    models.PositiveIntegerField(
                        help_text="0-based ordinal within the room, stable across re-embeds.",
                        verbose_name="chunk index",
                    ),
                ),
                (
                    "speaker_identity",
                    models.CharField(
                        blank=True, default="", max_length=128, verbose_name="speaker identity"
                    ),
                ),
                (
                    "speaker_name",
                    models.CharField(
                        blank=True, default="", max_length=128, verbose_name="speaker name"
                    ),
                ),
                ("text", models.TextField(verbose_name="text")),
                (
                    "started_at",
                    models.DateTimeField(verbose_name="speech started at"),
                ),
                (
                    "ended_at",
                    models.DateTimeField(
                        blank=True, null=True, verbose_name="speech ended at"
                    ),
                ),
                (
                    "source_transcript_ids",
                    django.contrib.postgres.fields.ArrayField(
                        base_field=models.UUIDField(),
                        blank=True,
                        default=list,
                        help_text=(
                            "UUIDs of the Transcript rows aggregated into this chunk. "
                            "Audit trail for citation rendering; not enforced FKs so a "
                            "deleted Transcript doesn't kill its chunk."
                        ),
                        size=None,
                        verbose_name="source transcript ids",
                    ),
                ),
                (
                    "embedding",
                    models.JSONField(
                        default=list,
                        help_text=(
                            "Dense vector as a list of floats. Length depends on the "
                            "embedding model (Doubao text-embedding-large = 1024). "
                            "Stored as JSON to avoid the pgvector dependency; the "
                            "service layer pulls these into numpy at query time."
                        ),
                        verbose_name="embedding",
                    ),
                ),
                (
                    "embedding_model",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text=(
                            "Doubao embedding endpoint id (ep-...) used at write time. "
                            "Lets us spot mixed-model chunks during a model migration."
                        ),
                        max_length=64,
                        verbose_name="embedding model",
                    ),
                ),
                (
                    "room",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="chunks",
                        to="core.room",
                        verbose_name="room",
                    ),
                ),
                (
                    "summary",
                    models.ForeignKey(
                        blank=True,
                        help_text=(
                            "Summary generation this chunk-set belongs to. Null only "
                            "for chunks produced by direct backfill before Summary v2."
                        ),
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="chunks",
                        to="core.summary",
                        verbose_name="summary",
                    ),
                ),
            ],
            options={
                "verbose_name": "transcript chunk",
                "verbose_name_plural": "transcript chunks",
                "ordering": ("room", "chunk_index"),
                # Django requires explicit ``name`` for indexes passed via
                # CreateModel.options (runtime ``Meta.indexes`` auto-names,
                # but the migration ModelState code path does not). Keep
                # names short (<30 char Postgres identifier limit) and
                # prefixed with ``tchunk_`` for visual grep.
                "indexes": [
                    models.Index(
                        fields=["room", "chunk_index"],
                        name="tchunk_room_chunk_idx",
                    ),
                    models.Index(
                        fields=["summary"],
                        name="tchunk_summary_idx",
                    ),
                ],
            },
        ),
    ]
