"""Bulk member import: parse, preflight, apply (P10 M2).

**What "importing a member" actually means here.** we-meet identities come from
OIDC — a person has no ``sub`` until they sign in for the first time. So a row
for somebody who has never logged in cannot create a Membership; it creates an
``OrgInvitation`` that is redeemed at first login by
``invitation_provisioning.claim_pending_invitations``. The template and the UI
say so out loud, because the alternative is a support ticket that reads
"imported 300 people, the directory is still empty".

**Two phases, not one.** Preflight parses and resolves every row and reports
what *would* happen; apply re-parses the stored source and does it. An importer
that reports what it did after the fact is how a 400-person directory gets
silently reshaped by one mis-mapped column.

**Two passes inside each phase.** Pass 1 creates/updates every row without
touching ``manager``; pass 2 resolves the manager column. A manager may appear
*below* their report in the same file, so a single pass would report half the
hierarchy as "unknown manager" purely because of row order.
"""

import csv
import io
from dataclasses import dataclass, field

from django.db import transaction
from django.utils import timezone
from django.utils.translation import gettext as _

from core import models
from core.services.phone import normalize_cn_phone, phone_variants

#: Column headers accepted in the CSV, mapped to what they set. Deliberately a
#: closed set: a typo'd header must be reported, not silently ignored — silently
#: ignoring it is how you import 300 people with no department.
COLUMNS = {
    "email": "email",
    "phone": "phone",
    "employee_no": "employee_no",
    "full_name": "full_name",
    "department": "department",
    "title": "title",
    "org_role": "org_role",
    "employee_type": "employee_type",
    "job_level": "job_level",
    "job_sequence": "job_sequence",
    "hire_date": "hire_date",
    "work_country": "work_country",
    "work_city": "work_city",
    "alias": "alias",
    "work_station": "work_station",
    "extension": "extension",
    "manager": "manager",
}

#: Order used by the downloadable template and the export.
TEMPLATE_COLUMNS = list(COLUMNS)

ACTION_CREATE = "create"
ACTION_UPDATE = "update"
ACTION_REHIRE = "rehire"
ACTION_INVITE = "invite"
ACTION_ERROR = "error"


@dataclass
class RowResult:
    """One source line and what the importer intends to do with it."""

    line: int
    action: str = ACTION_ERROR
    #: Human-readable subject, for the preview table.
    label: str = ""
    errors: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    #: Cleaned values, carried from preflight into apply.
    data: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "line": self.line,
            "action": self.action,
            "label": self.label,
            "errors": self.errors,
            "warnings": self.warnings,
        }


class ImportError_(Exception):
    """The file itself is unusable — not a per-row problem."""


def parse_csv(source: str) -> tuple[list[str], list[dict]]:
    """Return (headers, rows). Raises :class:`ImportError_` on a broken file."""
    # utf-8-sig: Excel writes a BOM, and without stripping it the first header
    # becomes "﻿email" and every row loses its email column.
    text = source.lstrip("﻿")
    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None:
        raise ImportError_(_("The file is empty."))
    headers = [(h or "").strip() for h in reader.fieldnames]
    unknown = [h for h in headers if h and h not in COLUMNS]
    if unknown:
        raise ImportError_(
            _("Unknown column(s): %(cols)s") % {"cols": ", ".join(unknown)}
        )
    if "email" not in headers and "phone" not in headers:
        # Either identifies a person; requiring the address specifically would
        # reject the file an HR system actually exports.
        raise ImportError_(_("The file needs an 'email' or a 'phone' column."))
    rows = []
    for raw in reader:
        rows.append({(k or "").strip(): (v or "").strip() for k, v in raw.items()})
    return headers, rows


class _Resolver:
    """Caches the lookups every row needs, so a 1000-row file is not 4000 queries."""

    def __init__(self, organization, create_missing_departments: bool):
        self.organization = organization
        self.create_missing_departments = create_missing_departments
        self._departments_by_code = {}
        self._departments_by_path = {}
        self._dict_items = {}
        self._load()

    def _load(self):
        for dept in models.Department.objects.filter(
            organization=self.organization, deleted_at__isnull=True
        ).select_related("parent"):
            if dept.code:
                self._departments_by_code[dept.code.lower()] = dept
            self._departments_by_path[self._name_path(dept).lower()] = dept
        for item in models.OrgDictItem.objects.filter(
            organization=self.organization, is_active=True
        ):
            self._dict_items[(item.scope, item.code.lower())] = item
            self._dict_items[(item.scope, item.label.lower())] = item

    @staticmethod
    def _name_path(dept) -> str:
        names = [dept.name]
        cursor = dept.parent
        # The tree is depth-limited (path is CharField(1024)); the guard is for
        # dirty data with a cycle, not for legitimately deep trees.
        hops = 0
        while cursor is not None and hops < 16:
            names.append(cursor.name)
            cursor = cursor.parent
            hops += 1
        return "/".join(reversed(names))

    def department(self, raw: str, result: RowResult):
        """Resolve by code first, then by full name path (``研发/后端组``)."""
        if not raw:
            return None
        key = raw.strip().lower()
        found = self._departments_by_code.get(key) or self._departments_by_path.get(key)
        if found is not None:
            return found
        if not self.create_missing_departments:
            result.errors.append(
                _("Unknown department '%(name)s'.") % {"name": raw}
            )
            return None
        result.warnings.append(
            _("Department '%(name)s' will be created.") % {"name": raw}
        )
        return _MissingDepartment(raw)

    def dict_item(self, scope: str, raw: str, result: RowResult):
        if not raw:
            return None
        found = self._dict_items.get((scope, raw.strip().lower()))
        if found is None:
            result.errors.append(
                _("Unknown %(scope)s '%(value)s'.") % {"scope": scope, "value": raw}
            )
        return found

    def create_department(self, name_path: str):
        """Create the missing branch of a ``a/b/c`` path and return the leaf."""
        parent = None
        walked = []
        for part in [p.strip() for p in name_path.split("/") if p.strip()]:
            walked.append(part)
            key = "/".join(walked).lower()
            existing = self._departments_by_path.get(key)
            if existing is None:
                existing = models.Department.objects.create(
                    organization=self.organization,
                    name=part,
                    parent=parent,
                    source=models.SourceChoices.IMPORT,
                )
                self._departments_by_path[key] = existing
            parent = existing
        return parent


@dataclass
class _MissingDepartment:
    """Placeholder for a department the apply phase will create."""

    name_path: str


def _parse_date(raw: str, result: RowResult):
    if not raw:
        return None
    for fmt in ("%Y-%m-%d", "%Y/%m/%d"):
        try:
            from datetime import datetime

            return datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    result.errors.append(_("Invalid date '%(value)s' (use YYYY-MM-DD).") % {"value": raw})
    return None


def preflight(organization, rows: list[dict], create_missing_departments: bool):
    """Resolve every row and decide what would happen. No writes."""
    resolver = _Resolver(organization, create_missing_departments)
    results: list[RowResult] = []

    # Existing people, by every key the file may match on.
    memberships = list(
        models.Membership.objects.filter(organization=organization).select_related(
            "user"
        )
    )
    by_email = {}
    by_phone = {}
    by_employee_no = {}
    for membership in memberships:
        if membership.user.email:
            by_email.setdefault(membership.user.email.lower(), membership)
        number = normalize_cn_phone(membership.user.phone)
        if number:
            by_phone.setdefault(number, membership)
        if membership.employee_no:
            by_employee_no.setdefault(membership.employee_no.lower(), membership)
    pending_invites = set()
    pending_invite_phones = set()
    for invite in models.OrgInvitation.objects.filter(
        organization=organization,
        status=models.InvitationStatusChoices.PENDING,
    ):
        if invite.email:
            pending_invites.add(invite.email.lower())
        if invite.phone:
            pending_invite_phones.add(invite.phone)

    seen_emails: set[str] = set()
    seen_phones: set[str] = set()

    for index, raw in enumerate(rows, start=2):  # line 1 is the header
        result = RowResult(line=index)
        email = raw.get("email", "").strip().lower()
        phone_raw = raw.get("phone", "").strip()
        phone = normalize_cn_phone(phone_raw)
        employee_no = raw.get("employee_no", "").strip()
        result.label = raw.get("full_name") or email or phone or f"line {index}"

        if phone_raw and not phone:
            # Told, not silently dropped: a mistyped number that imports anyway
            # produces a person who can never be matched to their sign-in.
            result.errors.append(
                _("'%(value)s' is not a valid mainland-China mobile number.")
                % {"value": phone_raw}
            )
        if not email and not phone_raw:
            result.errors.append(_("Email or phone is required."))
        if email and email in seen_emails:
            # Two rows for one person is always a mistake, and applying both
            # means the second silently wins.
            result.errors.append(_("Duplicate email in this file."))
        if phone and phone in seen_phones:
            result.errors.append(_("Duplicate phone number in this file."))
        if result.errors:
            results.append(result)
            continue
        seen_emails.add(email)
        if phone:
            seen_phones.add(phone)

        # Match priority: employee_no beats email beats phone — an employee
        # number is assigned by the customer and survives both an address and a
        # handset change; an address is likelier than a number to be re-used
        # (shared inbox, alias) but is also the one an org controls.
        membership = None
        if employee_no:
            membership = by_employee_no.get(employee_no.lower())
        if membership is None and email:
            membership = by_email.get(email)
        if membership is None and phone:
            membership = by_phone.get(phone)

        department = resolver.department(raw.get("department", ""), result)
        employee_type = resolver.dict_item(
            models.DictScopeChoices.EMPLOYEE_TYPE, raw.get("employee_type", ""), result
        )
        job_level = resolver.dict_item(
            models.DictScopeChoices.JOB_LEVEL, raw.get("job_level", ""), result
        )
        job_sequence = resolver.dict_item(
            models.DictScopeChoices.JOB_SEQUENCE, raw.get("job_sequence", ""), result
        )
        hire_date = _parse_date(raw.get("hire_date", ""), result)

        org_role = raw.get("org_role", "").strip()
        if org_role and org_role not in models.OrgRoleChoices.values:
            result.errors.append(_("Unknown role '%(value)s'.") % {"value": org_role})

        result.data = {
            "email": email,
            "phone": phone,
            "full_name": raw.get("full_name", "").strip(),
            "employee_no": employee_no,
            "membership_id": str(membership.id) if membership else None,
            "department": department,
            "employee_type_id": employee_type.id if employee_type else None,
            "job_level_id": job_level.id if job_level else None,
            "job_sequence_id": job_sequence.id if job_sequence else None,
            "hire_date": hire_date.isoformat() if hire_date else None,
            "manager": raw.get("manager", "").strip(),
            **{
                key: raw.get(key, "").strip()
                for key in (
                    "title",
                    "org_role",
                    "work_country",
                    "work_city",
                    "alias",
                    "work_station",
                    "extension",
                )
            },
        }

        if result.errors:
            result.action = ACTION_ERROR
        elif membership is None:
            # No membership: this becomes an invitation, redeemed at first login.
            result.action = ACTION_INVITE
            if (email and email in pending_invites) or (
                phone and phone in pending_invite_phones
            ):
                result.warnings.append(_("An invitation is already pending; it will be updated."))
        elif membership.status == models.MembershipStatusChoices.LEFT:
            # Rehire, never create: a second Membership for the same person would
            # hit unique(user, organization) and, worse, split their history.
            result.action = ACTION_REHIRE
        else:
            result.action = ACTION_UPDATE
        results.append(result)

    # --- pass 2: managers -------------------------------------------------
    # Runs after every row is known, because a manager may appear *below* their
    # report in the file. A single pass would flag half the hierarchy unknown
    # purely because of row order.
    known_keys = set()
    for r in results:
        if r.action == ACTION_ERROR:
            continue
        known_keys.update(k for k in (r.data.get("email"), r.data.get("phone")) if k)
    for result in results:
        manager = result.data.get("manager")
        if not manager or result.action == ACTION_ERROR:
            continue
        key = manager.lower()
        # A manager may be named by any key their own row could be matched on.
        if (
            key in known_keys
            or key in by_email
            or key in by_employee_no
            or normalize_cn_phone(manager) in by_phone
        ):
            continue
        # Not fatal: the row still imports, the reporting line just stays unset.
        result.warnings.append(
            _("Manager '%(value)s' not found; the row will import without one.")
            % {"value": manager}
        )
        result.data["manager"] = ""

    return results


def summarize(results: list[RowResult]) -> dict:
    counts = {
        ACTION_CREATE: 0,
        ACTION_UPDATE: 0,
        ACTION_REHIRE: 0,
        ACTION_INVITE: 0,
        ACTION_ERROR: 0,
    }
    warnings = 0
    for result in results:
        counts[result.action] = counts.get(result.action, 0) + 1
        warnings += len(result.warnings)
    return {"total": len(results), "warnings": warnings, **counts}


def apply_rows(job, results: list[RowResult], actor) -> dict:
    """Execute the previewed rows. Each row is its own transaction."""
    organization = job.organization
    resolver = _Resolver(organization, job.create_missing_departments)
    applied = {ACTION_UPDATE: 0, ACTION_REHIRE: 0, ACTION_INVITE: 0, ACTION_ERROR: 0}

    membership_by_key: dict[str, object] = {}

    for result in results:
        if result.action == ACTION_ERROR:
            applied[ACTION_ERROR] += 1
            continue
        try:
            # Per-row atomicity: one bad row must not roll back the 800 good
            # ones an admin already saw succeed in the preview.
            with transaction.atomic():
                membership = _apply_one(organization, resolver, result, actor)
            if membership is not None:
                membership_by_key[_row_key(result.data)] = membership
            applied[result.action] = applied.get(result.action, 0) + 1
        except Exception as exc:  # noqa: BLE001 — report, never abort the run
            result.action = ACTION_ERROR
            result.errors.append(str(exc)[:200])
            applied[ACTION_ERROR] += 1

    _apply_managers(organization, results, membership_by_key)

    return applied


def _row_key(data) -> str:
    """The identifier a row is addressed by — email when present, else phone.

    Rows used to be keyed by email alone. With phone-only rows that collapses
    every one of them onto ``""``: the manager pass would then wire the whole
    file's reporting lines to whichever phone-only row happened to be written
    last.
    """
    return data.get("email") or data.get("phone") or ""


def _apply_one(organization, resolver, result, actor):
    data = result.data
    department = data.get("department")
    if isinstance(department, _MissingDepartment):
        department = resolver.create_department(department.name_path)

    fields = {
        "title": data.get("title", ""),
        "employee_no": data.get("employee_no", ""),
        "work_country": data.get("work_country", ""),
        "work_city": data.get("work_city", ""),
        "alias": data.get("alias", ""),
        "work_station": data.get("work_station", ""),
        "extension": data.get("extension", ""),
        "employee_type_id": data.get("employee_type_id"),
        "job_level_id": data.get("job_level_id"),
        "job_sequence_id": data.get("job_sequence_id"),
        "hire_date": data.get("hire_date"),
    }
    # Blank cells mean "leave alone", not "clear". A CSV round-trip that only
    # fills two columns must not wipe the other ten.
    fields = {k: v for k, v in fields.items() if v not in ("", None)}
    if data.get("org_role"):
        fields["org_role"] = data["org_role"]

    if result.action == ACTION_INVITE:
        # Key on whichever identifier the row actually carried. Keying on email
        # alone would make every phone-only row collide on ``email=""`` and
        # overwrite one another — the partial unique constraints on the model
        # would turn the second row of a phone-only file into a 500.
        lookup = {"organization": organization, "status": models.InvitationStatusChoices.PENDING}
        if data.get("email"):
            lookup["email"] = data["email"]
        else:
            lookup["phone"] = data["phone"]
        models.OrgInvitation.objects.update_or_create(
            **lookup,
            defaults={
                "email": data.get("email", ""),
                "phone": data.get("phone", ""),
                "full_name": data.get("full_name", ""),
                "department": department,
                "org_role": data.get("org_role") or models.OrgRoleChoices.MEMBER,
                "title": data.get("title", ""),
                "invited_by": actor,
            },
        )
        return None

    membership = models.Membership.objects.get(id=data["membership_id"])
    if result.action == ACTION_REHIRE:
        from core.services import offboarding

        offboarding.rehire_membership(membership, actor=actor)
        membership.refresh_from_db()
    if department is not None:
        membership.department = department
    for key, value in fields.items():
        setattr(membership, key, value)
    membership.source = models.SourceChoices.IMPORT
    membership.save()
    return membership


def _apply_managers(organization, results, membership_by_key):
    """Second pass: wire reporting lines once everyone exists."""
    wanted = {
        _row_key(r.data): r.data["manager"]
        for r in results
        if r.action in (ACTION_UPDATE, ACTION_REHIRE) and r.data.get("manager")
    }
    if not wanted:
        return
    lookup = dict(membership_by_key)
    missing = [e for e in {*wanted, *wanted.values()} if e not in lookup]
    if missing:
        for membership in models.Membership.objects.filter(
            organization=organization, user__email__in=missing
        ).select_related("user"):
            lookup.setdefault(membership.user.email.lower(), membership)
        for membership in models.Membership.objects.filter(
            organization=organization, employee_no__in=missing
        ):
            lookup.setdefault(membership.employee_no.lower(), membership)
        # Managers named by phone number resolve through the same table.
        numbers = [n for e in missing for n in phone_variants(e)]
        if numbers:
            for membership in models.Membership.objects.filter(
                organization=organization, user__phone__in=numbers
            ).select_related("user"):
                lookup.setdefault(
                    normalize_cn_phone(membership.user.phone), membership
                )

    for row_key, manager_key in wanted.items():
        subordinate = lookup.get(row_key)
        manager = lookup.get(manager_key.lower()) or lookup.get(
            normalize_cn_phone(manager_key)
        )
        if subordinate is None or manager is None or manager.pk == subordinate.pk:
            continue
        subordinate.manager = manager
        try:
            # full_clean() runs Membership.clean(), which walks the manager chain
            # and rejects cycles — a file where A reports to B and B to A must
            # not be able to write one.
            subordinate.save()
        except Exception:  # noqa: BLE001 — a cycle leaves the line unset
            subordinate.manager = None


def build_template() -> str:
    """The downloadable CSV template, with a BOM so Excel opens it correctly."""
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(TEMPLATE_COLUMNS)
    writer.writerow(
        [
            "zhangsan@example.com",
            "13800000001",
            "E1001",
            "张三",
            "研发/后端组",
            "后端工程师",
            "member",
            "正式",
            "",
            "",
            "2026-01-15",
            "CN",
            "深圳",
            "",
            "",
            "",
            "lisi@example.com",
        ]
    )
    return "﻿" + buffer.getvalue()


def run_preflight(job_id):
    """Parse + preflight a job. Safe to call synchronously (dev has no broker)."""
    job = models.ImportJob.objects.get(id=job_id)
    job.status = models.ImportJobStatusChoices.PREVIEWING
    job.save(update_fields=["status", "updated_at"])
    try:
        _headers, rows = parse_csv(job.source)
        results = preflight(job.organization, rows, job.create_missing_departments)
    except ImportError_ as exc:
        job.status = models.ImportJobStatusChoices.FAILED
        job.error = str(exc)[:500]
        job.save(update_fields=["status", "error", "updated_at"])
        return job
    job.rows = [r.as_dict() for r in results]
    job.summary = summarize(results)
    job.status = models.ImportJobStatusChoices.PREVIEWED
    job.save(update_fields=["rows", "summary", "status", "updated_at"])
    return job


def run_apply(job_id, actor_id=None):
    """Apply a previewed job by re-parsing its stored source."""
    job = models.ImportJob.objects.get(id=job_id)
    actor = None
    if actor_id:
        actor = models.User.objects.filter(id=actor_id).first()
    job.status = models.ImportJobStatusChoices.APPLYING
    job.save(update_fields=["status", "updated_at"])
    try:
        # Re-parse rather than trusting the stored preview: the preview is a
        # report, and reconstructing intent from it would mean two code paths
        # that must agree forever.
        _headers, rows = parse_csv(job.source)
        results = preflight(job.organization, rows, job.create_missing_departments)
        applied = apply_rows(job, results, actor)
    except ImportError_ as exc:
        job.status = models.ImportJobStatusChoices.FAILED
        job.error = str(exc)[:500]
        job.save(update_fields=["status", "error", "updated_at"])
        return job

    job.rows = [r.as_dict() for r in results]
    job.summary = {**summarize(results), "applied": applied}
    job.status = (
        models.ImportJobStatusChoices.PARTIAL
        if applied.get(ACTION_ERROR)
        else models.ImportJobStatusChoices.DONE
    )
    job.applied_at = timezone.now()
    # Source is no longer needed once applied, and it is a copy of the customer's
    # roster sitting in a text column. Drop it.
    job.source = ""
    job.save(
        update_fields=[
            "rows",
            "summary",
            "status",
            "applied_at",
            "source",
            "updated_at",
        ]
    )
    return job
