"""Host directory absence reconciliation (HW-03)."""

from pathlib import Path

from django.db import migrations

SQL_FILE = Path(__file__).resolve().parents[1] / "sql" / "directory_absence.sql"

REVERSE_SQL = """
DROP FUNCTION IF EXISTS work.mark_members_absent(text, text[], boolean);
DROP FUNCTION IF EXISTS work.mark_members_absent(text, text[], bigint);
DROP FUNCTION IF EXISTS work.directory_watermark(text);
"""


class Migration(migrations.Migration):
    dependencies = [
        ("work", "0002_initial_r0a_schema"),
    ]

    atomic = True

    operations = [
        migrations.RunSQL(
            sql=SQL_FILE.read_text(encoding="utf-8"),
            reverse_sql=REVERSE_SQL,
        ),
    ]
