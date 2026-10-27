# Work R0a — E1 schema draft

The legacy Work app, models, migrations, API, tests, frontend and deployment
assets were deleted on 2026-10-27. This directory is the clean-slate E1 draft;
it is **not registered in `INSTALLED_APPS`** and no legacy data is migrated.

## What is here

| File | Purpose |
|---|---|
| `sql/r0a_roles.sql` | Local-only role bootstrap (D-04 owns production role provisioning) |
| `sql/r0a_schema.sql` | R0a schema, functions, RLS and grants, generated from the D1 design asset |
| `sql/verify_local.sh` | Applies roles + schema to a disposable PostgreSQL 16 and runs the 143 smoke assertions |
| `apps.py` | App config placeholder; registration waits for D-04 |

## Local verification

```bash
docker run -d --name work-r0a-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=work_r0a -p 55433:5432 postgres:16
bash src/backend/work/sql/verify_local.sh
```

`r0a_schema.sql` is generated from
`docs/plan/assets/work-r0a-design-2026-10-25/r0a-schema-draft.sql`:
the destructive header (`DROP SCHEMA`, `DROP ROLE`, `BEGIN/COMMIT`) is removed,
and the file starts with `CREATE SCHEMA IF NOT EXISTS work`.

## Boundaries

- **D-04 is unsigned**: do not merge this schema into shared environments or
  wire it into the migration graph yet. The local script uses a disposable DB.
- Production roles and Secret delivery are D-04; this draft assumes
  `work_owner`, `work_api`, `work_worker`, `work_ledger`, `work_migrator`,
  `work_ops`, `work_directory` exist.
- No legacy Work data is migrated. `deploy/aliyun/drop-legacy-work.sql` is the
  one-off destructive cleanup for environments that still have the old tables;
  run it only after backups and a change window.
