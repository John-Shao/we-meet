"""Create the seven Work R0a roles before the schema migration (D-04)."""

from django.db import migrations

WORK_ROLES = (
    "work_owner",
    "work_api",
    "work_worker",
    "work_ledger",
    "work_migrator",
    "work_ops",
    "work_directory",
)

ROLE_SQL = """
DO $$
DECLARE
  r text;
  missing text[] := '{}';
  roles text[] := ARRAY[
    'work_owner', 'work_api', 'work_worker', 'work_ledger',
    'work_migrator', 'work_ops', 'work_directory'
  ];
BEGIN
  -- Roles are cluster-wide: serialize concurrent migrations and CI shards.
  PERFORM pg_advisory_xact_lock(hashtext('work_r0a_roles'));
  FOREACH r IN ARRAY roles LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      missing := missing || r;
    END IF;
  END LOOP;
  IF cardinality(missing) > 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_roles
      WHERE rolname = current_user AND (rolsuper OR rolcreaterole)
    ) THEN
      RAISE EXCEPTION
        'Work roles missing (%); ask the DBA to run deploy/aliyun/work-roles.sql '
        'or the local sql/r0a_roles.sql (D-04)',
        array_to_string(missing, ', ');
    END IF;
    FOREACH r IN ARRAY missing LOOP
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END LOOP;
  END IF;
  FOREACH r IN ARRAY roles LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r AND rolcanlogin) THEN
      RAISE EXCEPTION 'Work role % must be NOLOGIN (D1 4.1)', r;
    END IF;
  END LOOP;
END $$;
"""


class Migration(migrations.Migration):
    dependencies = []

    operations = [
        migrations.RunSQL(sql=ROLE_SQL, reverse_sql=migrations.RunSQL.noop),
    ]
