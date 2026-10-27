# Work R0a

Clean-slate R0a implementation. The legacy Work app, models, migrations, API,
tests, frontend and deployment assets were deleted on 2026-10-27; no legacy
data is migrated. The app is registered in `INSTALLED_APPS`.

## What is here

| Area | Files | Purpose |
|---|---|---|
| E1 data layer | `sql/`, `migrations/` | Roles, generated schema, RLS/grants, rollback, 148 smoke and 9 races |
| E2 API | `api/` | 33 operations at `/work/v1/`, Cookie+CSRF, idempotency, admin reads, downloads |
| E3 events | `api/views/run.py`, `jobs/outbox_relay.py` | SSE Last-Event-ID / 409 resync; outbox claim/deliver/dead-letter |
| E4 orchestration | `orchestration/` | RunWorkflow/activity contract, no-network Temporal mock and a local SQL activity slice |
| E4 background jobs | `jobs/contracts/` | Six non-Run job contracts (relay, shredder, directory, export, expiry, dead letter) |
| E5 runtime | `runtime/` | Work Adapter, model gateway, provider-context decryption, token-only usage reconciliation; faux gateway |
| E5 content | `content/` | Content Store contract and local filesystem mock |
| E6 frontend | `src/frontend/src/features/work/` | API/SSE/UI state contracts, a mock Work UI, a live React Query route (`VITE_WORK_API_MODE=live`), and an axe-core a11y test |
| E7 observability | `observability/`, `api/middleware.py`, `deploy/observability/` | Request metric/correlation middleware, metric allowlist, no-content logging/log-scan CLI, Prometheus/Grafana/OTel assets |
| E8 pilot | `scripts/onboarding/`, `scripts/golden-tasks/` | Guarded staging onboarding and golden-task runner |

`apps.py` carries no models: every write goes through the `SECURITY DEFINER`
domain functions in `r0a_schema.sql`.

## Migrations

Migrations must run in order. `0002` executes `CREATE SCHEMA ... AUTHORIZATION
work_owner` and grants to the six other roles, so all seven roles must exist
first. `0001` creates missing roles only when the connection may `CREATEROLE`;
otherwise it fails with the role list and points at the DBA script. The
migration identity must be a member of `work_owner` to run `0002`.

```bash
python manage.py migrate work
python manage.py showmigrations work
python manage.py migrate work zero   # drops the schema, keeps the roles
```

`sql/check_schema_sync.py` proves the migration SQL body still matches the
reviewed design asset.

## API and jobs

- API routes are mounted at `/work/v1/` from `meet/urls.py`; the contract is
  `docs/plan/assets/work-r0a-design-2026-10-25/r0a-openapi-v1.yaml`.
- Requests use the Workspace session cookie and `X-CSRF-Token`; `bootstrap`
  returns the token. Errors follow `error-codes.json` and always carry a
  correlation id.
- `python manage.py work_directory_sync` projects core org/member rows into
  `work.org`/`work.member` as `work_directory`.
- `python manage.py work_export_worker` claims queued audit exports and writes
  the CSV/JSON to the Content Store mock.
- `python manage.py work_outbox_relay` delivers pending outbox events.
- `python manage.py work_expiry_sweep` expires inputs/audit exports and queues content shreds per org.
- `scripts/golden-tasks/run-golden-tasks.mjs --dry-run` validates the six E8 golden tasks without an API.
- `scripts/onboarding/assign-seats.sh` projects a core membership role into `work.member`; local smoke verified.
- `python manage.py ops_cancel_run --org-id ... --run-id ... --ticket OPS-1024
  --reason ...` is the D-07 A on-call cancellation; it is not a public API.

## Local verification

```bash
docker run -d --name work-r0a-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=work_r0a -p 55433:5432 postgres:16
bash src/backend/work/sql/verify_local.sh
```

Work pytest gates need `psql` (the smoke script uses `\gset`) and Redis for the
CSRF session. Install `postgresql-client` or point `WORK_PSQL` at a container,
for example `WORK_PSQL="docker exec -i work-r0a-pg psql -U postgres"`. CI
installs both and treats a missing psql as a failure.

```bash
cd src/backend
pytest work/tests -v
```

## Boundaries

- Production role provisioning and Secret delivery are D-04:
  `deploy/aliyun/work-roles.sql` (NOLOGIN roles) plus the migration login's
  `GRANT work_owner`. All seven roles stay NOLOGIN; workloads SET ROLE from a
  platform login identity (D1 6.1, still open with the platform IAM).
- The Content Store, model gateway and Temporal implementation are local mocks
  until E4/E5 platform work; provider calls, Qwen, and the pilot deployment are
  not proven here.
- E6 has contracts only (no Work UI yet); E7 assets are not deployed; E8 scripts
  are staging/pilot entry points, not production evidence.
- `r0a_schema.sql` is generated from
  `docs/plan/assets/work-r0a-design-2026-10-25/r0a-schema-draft.sql`; the
  destructive header (`DROP SCHEMA`, `DROP ROLE`, `BEGIN/COMMIT`) is removed.
- No legacy Work data is migrated. `deploy/aliyun/drop-legacy-work.sql` is the
  one-off destructive cleanup for environments that still have the old tables;
  run it only after backups and a change window.
