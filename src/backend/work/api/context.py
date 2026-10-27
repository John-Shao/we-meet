"""Resolve the Host session into a Work tenant context and set DB identity."""

from contextlib import contextmanager
from dataclasses import dataclass

from django.db import DatabaseError, connection, transaction

from core.api.directory import get_caller_organization

from work.api.errors import WorkAPIError


@dataclass(frozen=True)
class WorkContext:
    org_id: str
    subject_id: str
    role: str
    work_seat: bool
    org_name: str | None
    org_status: str
    execution_enabled: bool
    org_revision: int


def _set_work_gucs(cursor, org_id: str, subject_id: str | None, role: str) -> None:
    cursor.execute("SELECT set_config('role', %s, true)", [role])
    cursor.execute("SELECT set_config('app.org_id', %s, true)", [org_id])
    if subject_id is not None:
        cursor.execute("SELECT set_config('app.subject_id', %s, true)", [subject_id])


def _reset_work_gucs(cursor) -> None:
    # SET LOCAL survives inner savepoints, so reset before the outer transaction
    # commits; otherwise a later core ORM query runs as work_api.
    cursor.execute("RESET ROLE")
    cursor.execute("SELECT set_config('app.org_id', '', true)")
    cursor.execute("SELECT set_config('app.subject_id', '', true)")


def resolve_context(request) -> WorkContext:
    user = getattr(request, "user", None)
    if user is None or not user.is_authenticated:
        raise WorkAPIError("unauthorized")
    subject_id = getattr(user, "sub", None) or str(user.id)
    organization = get_caller_organization(user)
    if organization is None:
        raise WorkAPIError("work_seat_required")
    org_id = str(organization.id)

    with transaction.atomic():
        with connection.cursor() as cursor:
            _set_work_gucs(cursor, org_id, subject_id, "work_api")
            try:
                cursor.execute(
                    "SELECT role, work_seat, status FROM work.member "
                    "WHERE org_id = %s AND subject_id = %s",
                    [org_id, subject_id],
                )
                member = cursor.fetchone()
                cursor.execute(
                    "SELECT name, status, execution_enabled, operator_suspended, "
                    "revision FROM work.org WHERE id = %s",
                    [org_id],
                )
                org = cursor.fetchone()
            finally:
                try:
                    _reset_work_gucs(cursor)
                except DatabaseError:
                    pass

    if member is None or member[2] != "active" or not member[1]:
        raise WorkAPIError("work_seat_required")
    if org is None:
        raise WorkAPIError("work_seat_required")
    return WorkContext(
        org_id=org_id,
        subject_id=subject_id,
        role=member[0],
        work_seat=bool(member[1]),
        org_name=org[0],
        org_status=org[1],
        execution_enabled=bool(org[2]) and not bool(org[3]) and org[1] == "active",
        org_revision=int(org[4]),
    )


def fetch_all(cursor) -> list[dict]:
    names = [column.name for column in cursor.description]
    return [dict(zip(names, row, strict=True)) for row in cursor.fetchall()]


def fetch_one(cursor) -> dict | None:
    names = [column.name for column in cursor.description]
    row = cursor.fetchone()
    return dict(zip(names, row, strict=True)) if row is not None else None


@contextmanager
def role_cursor(org_id: str, role: str, subject_id: str | None = None):
    with transaction.atomic():
        with connection.cursor() as cursor:
            _set_work_gucs(cursor, org_id, subject_id, role)
            try:
                yield cursor
            finally:
                try:
                    _reset_work_gucs(cursor)
                except DatabaseError:
                    pass


@contextmanager
def work_cursor(context: WorkContext, role: str = "work_api"):
    with role_cursor(context.org_id, role, context.subject_id) as cursor:
        yield cursor


def require_admin(context: WorkContext) -> None:
    if context.role not in ("owner", "admin"):
        raise WorkAPIError("admin_access_denied")


def require_owner(context: WorkContext) -> None:
    if context.role != "owner":
        raise WorkAPIError("admin_access_denied")
