# Work control plane (R0a rebuild)

This subtree is the Go/Node Work implementation described by
[the R0a rebuild plan](../../docs/plan/work-r0a-architecture-rebuild-plan-2026-10-28.md).
It must not import `src/backend/work` (the legacy Django implementation) or
`src/backend/core`; the only Host integration is the versioned HTTP contract.

## work-migrate

`cmd/work-migrate` owns schema migration. It compiles the baseline SQL, manifest,
and catalog checkpoint into the binary, so a published migration body cannot be
edited without changing its pinned checksum.

```bash
go run ./cmd/work-migrate status -url "$WORK_DATABASE_URL"
go run ./cmd/work-migrate plan   -url "$WORK_DATABASE_URL"
go run ./cmd/work-migrate apply  -url "$WORK_DATABASE_URL" -legacy-migrator-disabled
go run ./cmd/work-migrate snapshot -url "$WORK_DATABASE_URL" -output migrations/baseline/catalog.json
```

`apply` refuses to run without `-legacy-migrator-disabled`. The runner:

- requires the seven Work roles to exist and stay `NOLOGIN`;
- requires the migration login to be a member of `work_owner`;
- serializes writers with a session advisory lock; a second runner waits and
  becomes a no-op;
- initializes an empty database, or verifies `django_migrations` plus the
  catalog snapshot before adopting an existing database;
- rejects any catalog drift with a diff and never stamps a drifted database;
- records versions and checksums in `work.schema_migration`; increments and
  ledger rows commit in the same transaction;
- has no `DROP SCHEMA` or `migrate zero` path.

## work-api

`cmd/work-api` serves the frozen bootstrap slice at `GET /work/v1/bootstrap`.
It reads the browser `sessionid` cookie, verifies it through the Host mTLS
endpoint, opens a `work_api` RLS transaction, reads `work.member`/`work.org`/
`work.org_policy`, and returns the `work-bootstrap-v1` body plus a Go-issued
HMAC `work_csrf` cookie.

Required environment: `WORK_DATABASE_URL` (Work API login),
`WORK_HOST_BASE_URL`, `WORK_HOST_CLIENT_CERT`, `WORK_HOST_CLIENT_KEY`,
`WORK_HOST_CA`, `WORK_CSRF_SECRET` (32+ bytes), optional `WORK_LISTEN_ADDR`.
The Host endpoint is reached through the ingress that terminates mTLS; this
binary does not terminate client TLS itself.

```bash
go run ./cmd/work-api
```

## Tests

Integration tests need an isolated PostgreSQL 16 instance. They create and drop
their own databases and ensure the test login roles; do not point this at a
shared or production cluster.

```bash
WORK_TEST_PG_URL="postgres://postgres:postgres@localhost:55435/postgres?sslmode=disable" \
  go test ./... -p 1 -count=1
```

`-p 1` serializes packages because both the migration and RLS tests provision
cluster-wide test roles.

Unit tests and the baseline-vs-legacy source guard run without a database:

```bash
go test ./...
```

## ECS helper

`scripts/ecs-migrate.sh` runs the binary on the Work ECS as root, sources
`/root/work-secrets.env`, and builds `WORK_DATABASE_URL` without printing the
password. It expects the deployed binary at `/home/johnshao/work-migrate` and
the migration login `work_migrator_login`; both are overridable with
`WORK_MIGRATE_BIN` and `WORK_DB_MIGRATOR_USER`.

```bash
sudo bash scripts/ecs-migrate.sh status
sudo bash scripts/ecs-migrate.sh apply -legacy-migrator-disabled
```
