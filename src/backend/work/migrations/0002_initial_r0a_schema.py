"""Apply the generated Work R0a schema, functions, RLS and grants."""

from pathlib import Path

from django.db import migrations

SCHEMA_FILE = Path(__file__).resolve().parents[1] / "sql" / "r0a_schema.sql"

PRECHECK_SQL = """
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'work_owner', 'MEMBER') THEN
    RAISE EXCEPTION
      'migration user % cannot SET ROLE work_owner; grant work_owner to the '
      'migration role (D-04)',
      current_user;
  END IF;
END $$;
"""


def load_schema() -> str:
    if not SCHEMA_FILE.is_file():
        raise RuntimeError(f"Work schema file missing: {SCHEMA_FILE}")
    return SCHEMA_FILE.read_text(encoding="utf-8")


class Migration(migrations.Migration):
    initial = True

    atomic = True

    dependencies = [
        ("work", "0001_create_work_roles"),
    ]

    operations = [
        migrations.RunSQL(
            sql=PRECHECK_SQL,
            reverse_sql=migrations.RunSQL.noop,
        ),
        migrations.RunSQL(
            sql=load_schema(),
            reverse_sql="DROP SCHEMA IF EXISTS work CASCADE",
        ),
    ]
