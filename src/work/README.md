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

`cmd/work-api` serves the Phase 2 task surface:

- `GET /work/v1/bootstrap` — frozen bootstrap body plus a Go-issued HMAC
  `work_csrf` cookie.
- `GET /work/v1/tasks` / `GET /work/v1/runs/{runId}` — owner-scoped reads with
  keyset pagination.
- `GET /work/v1/tasks/{taskId}` — detail with goal/background decrypted from
  the Content Store, template and capability snapshot.
- `PATCH /work/v1/tasks/{taskId}` — optimistic-concurrency title edit.
- `POST /work/v1/tasks/{taskId}/acceptances` — accept a published artifact
  version or complete by reason.
- `GET /work/v1/artifacts/{artifactId}/versions/{versionNo}` and
  `GET .../content?disposition=inline|attachment` — owner-scoped published
  version metadata and body. Content is hash-checked, `no-store`, and an
  attachment export writes `artifact.exported` audit metadata without the body.
- `GET /work/v1/tasks/{taskId}/events` — owner-scoped SSE; `Last-Event-ID`
  replays after a known event, unknown/foreign cursors return 409
  `resync_required` with `X-Work-Event-Cursor`, and quiet streams get a
  heartbeat every 15 seconds.
- `POST /work/v1/inputs`, `POST /work/v1/task-previews`, `POST /work/v1/tasks`
  — encrypted input creation, signed preview, idempotent submit.
- `POST /work/v1/runs/{runId}/cancel` — cancel request (does not claim the
  process stopped).

Every route reads the browser `sessionid` cookie, verifies it through the Host
mTLS endpoint, and opens a `work_api` RLS transaction. Mutations also require
the `work_csrf` double-submit token.

Required environment: `WORK_DATABASE_URL` (Work API login),
`WORK_HOST_BASE_URL`, `WORK_HOST_CLIENT_CERT`, `WORK_HOST_CLIENT_KEY`,
`WORK_HOST_CA`, `WORK_CSRF_SECRET` (32+ bytes), `WORK_CONTENT_MASTER_KEY`
(32-byte hex or RawStd base64), optional `WORK_CONTENT_DIR`
(`/var/lib/work/content` by default) and `WORK_LISTEN_ADDR`. The Host endpoint
is reached through the ingress that terminates mTLS; this binary does not
terminate client TLS itself.

```bash
go run ./cmd/work-api
```

## work-relay

`cmd/work-relay` is the only process that consumes `work.outbox`:

- `start_workflow` / `cancel_signal` → Temporal `work-r0a-run` queue,
  workflow type `RunWorkflow`; the workflow receives `{run_id, org_id}` and
  reads the rest from PostgreSQL.
- `content_shred` → deletes encrypted objects from the local Content Store.
- `task_event` → acknowledged without an external bus; the API SSE stream
  reads `work.task_event` directly.

It connects to PostgreSQL as `work_worker_login` (member of `work_worker`) and
to Temporal with mTLS. Required environment: `WORK_DATABASE_URL`,
`WORK_CONTENT_MASTER_KEY`, `WORK_TEMPORAL_ADDRESS`,
`WORK_TEMPORAL_CERT`/`WORK_TEMPORAL_KEY`/`WORK_TEMPORAL_CA`, and optional
namespace/task-queue/workflow-type/server-name/relay-id settings.

## work-worker

`cmd/work-worker` registers `RunWorkflow` on the same task queue and consumes
workflows started by `work-relay`. The pilot activities:

- `PrepareRun` reads the run/task/input/snapshot and decrypts the input.
- `AcquireRun` executes `work.acquire_run`.
- `CheckRun` observes the authoritative DB cancel state between steps.
- `ExecuteStep` creates/authorizes an operation, reserves its share of the run
  cap, checks cancellation, claims dispatch, calls the configured runtime,
  stores a Content Store checkpoint, finishes the operation, and settles quota.
  Only the final step publishes the artifact. A post-dispatch unknown outcome
  marks the operation `unknown` instead of retrying.
- `WaitRun` moves an unknown Run to `waiting(reconcile)`; the workflow waits for
  a `resume` or `cancel` signal without re-sending the provider request.
- `FinishRun` / `AbortRun` close or clean up the run.

Runtime selection: `WORK_RUNTIME_MODE=reference` (deterministic non-model
text for lifecycle drills) or `WORK_RUNTIME_MODE=openai_compatible` with
`WORK_MODEL_BASE_URL`, `WORK_MODEL_API_KEY`, `WORK_MODEL_NAME` and
`WORK_MODEL_PROVIDER` (`aliyun`, `volcengine` or `deepseek`). The placeholder
environment file is `deploy/ecs/work-worker.env.example`; real keys stay only
in `/etc/work/work-worker.env` (root:work-control 640). `WORK_MODEL_STEPS`
selects 1-3 model steps per Run (default 2); intermediate bodies are Content
Store checkpoints and only the final step publishes the artifact. New
organizations are auto-provisioned with an `org_policy` row and a soft
1,000,000-token monthly account by migration 0006; the worker calls
`work.ensure_quota_account` for later periods.

## work-reconcile

`cmd/work-reconcile` is the operator path for an `unknown` operation. It calls
`work.reconcile_operation` only (never re-sends the provider request), and
optionally signals `resume` to the waiting workflow:

```bash
work-reconcile -org <org> -operation <uuid> -resolution not_sent \
  -evidence-ref ticket:<id> -resume
```

`sent_succeeded` also needs `-settled-tokens`; `unresolved` cannot resume.
The database URL and Temporal mTLS settings come from the worker environment.

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
