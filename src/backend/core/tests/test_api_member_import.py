"""Bulk member import/export (P10 M2).

The cases that matter are the ones where a plausible implementation quietly does
the wrong thing:

- a row for someone who has never signed in must become an *invitation*, not a
  Membership (there is no ``sub`` to attach one to);
- a row matching a departed person must **rehire**, not create a second row;
- a manager listed *below* their report in the file must still resolve;
- blank cells must mean "leave alone", not "clear";
- an unknown column must fail the file rather than be ignored.
"""

import io

import pytest
from rest_framework.test import APIClient

from core import factories, models
from core.services import member_import

pytestmark = pytest.mark.django_db

ACTIVE = models.MembershipStatusChoices.ACTIVE
LEFT = models.MembershipStatusChoices.LEFT


def _org_with_admin():
    organization = factories.OrganizationFactory()
    admin = factories.UserFactory()
    models.Membership.objects.create(
        organization=organization,
        user=admin,
        org_role=models.OrgRoleChoices.ADMIN,
        is_primary=True,
    )
    return organization, admin


def _member(organization, email, **kwargs):
    user = factories.UserFactory(email=email)
    return models.Membership.objects.create(
        organization=organization, user=user, is_primary=True, **kwargs
    )


def _client(user):
    client = APIClient()
    client.force_login(user)
    return client


def _csv(*lines: str) -> str:
    return "\n".join(lines) + "\n"


def _upload(client, source: str, **extra):
    payload = io.BytesIO(source.encode("utf-8-sig"))
    payload.name = "members.csv"
    return client.post(
        "/api/v1.0/admin/import-jobs/",
        {"file": payload, **extra},
        format="multipart",
    )


# --- parsing ---------------------------------------------------------------


def test_unknown_column_fails_the_file_rather_than_being_ignored():
    """Silently ignoring a typo'd header is how 300 people import with no department."""
    with pytest.raises(member_import.ImportError_):
        member_import.parse_csv(_csv("email,departmant", "a@x.com,Eng"))


def test_missing_email_column_is_rejected():
    with pytest.raises(member_import.ImportError_):
        member_import.parse_csv(_csv("full_name", "张三"))


def test_bom_is_stripped_so_the_first_column_still_parses():
    headers, rows = member_import.parse_csv("﻿" + _csv("email", "a@x.com"))
    assert headers == ["email"]
    assert rows[0]["email"] == "a@x.com"


# --- preflight -------------------------------------------------------------


def test_unknown_person_becomes_an_invitation_not_a_membership():
    """No OIDC login yet means no `sub` — there is nothing to attach a Membership to."""
    organization, _admin = _org_with_admin()
    _headers, rows = member_import.parse_csv(_csv("email", "new@x.com"))
    results = member_import.preflight(organization, rows, False)

    assert results[0].action == member_import.ACTION_INVITE


def test_existing_active_member_is_an_update():
    organization, _admin = _org_with_admin()
    _member(organization, "old@x.com")
    _headers, rows = member_import.parse_csv(
        _csv("email,title", "old@x.com,工程师")
    )
    results = member_import.preflight(organization, rows, False)

    assert results[0].action == member_import.ACTION_UPDATE


def test_departed_person_is_a_rehire_not_a_create():
    """A second Membership would collide on unique(user, organization) and split history."""
    organization, _admin = _org_with_admin()
    _member(organization, "back@x.com", status=LEFT)
    _headers, rows = member_import.parse_csv(_csv("email", "back@x.com"))
    results = member_import.preflight(organization, rows, False)

    assert results[0].action == member_import.ACTION_REHIRE


def test_employee_no_wins_over_email_when_matching():
    """An employee number survives an address change; the email may not."""
    organization, _admin = _org_with_admin()
    membership = _member(organization, "old-address@x.com", employee_no="E1")
    _headers, rows = member_import.parse_csv(
        _csv("email,employee_no", "new-address@x.com,E1")
    )
    results = member_import.preflight(organization, rows, False)

    assert results[0].action == member_import.ACTION_UPDATE
    assert results[0].data["membership_id"] == str(membership.id)


def test_duplicate_email_in_one_file_is_an_error():
    organization, _admin = _org_with_admin()
    _headers, rows = member_import.parse_csv(
        _csv("email", "dup@x.com", "dup@x.com")
    )
    results = member_import.preflight(organization, rows, False)

    assert results[0].action != member_import.ACTION_ERROR
    assert results[1].action == member_import.ACTION_ERROR


def test_unknown_department_is_an_error_by_default():
    organization, _admin = _org_with_admin()
    _headers, rows = member_import.parse_csv(
        _csv("email,department", "a@x.com,Nope")
    )
    results = member_import.preflight(organization, rows, False)

    assert results[0].action == member_import.ACTION_ERROR


def test_unknown_department_downgrades_to_a_warning_when_opted_in():
    organization, _admin = _org_with_admin()
    _headers, rows = member_import.parse_csv(
        _csv("email,department", "a@x.com,新部门")
    )
    results = member_import.preflight(organization, rows, True)

    assert results[0].action == member_import.ACTION_INVITE
    assert results[0].warnings


def test_department_resolves_by_code_and_by_full_path():
    organization, _admin = _org_with_admin()
    root = models.Department.objects.create(
        organization=organization, name="研发", code="RD"
    )
    models.Department.objects.create(
        organization=organization, name="后端组", parent=root
    )
    _headers, rows = member_import.parse_csv(
        _csv("email,department", "a@x.com,RD", "b@x.com,研发/后端组")
    )
    results = member_import.preflight(organization, rows, False)

    assert [r.action for r in results] == [
        member_import.ACTION_INVITE,
        member_import.ACTION_INVITE,
    ]
    assert results[0].data["department"].name == "研发"
    assert results[1].data["department"].name == "后端组"


def test_manager_listed_below_their_report_still_resolves():
    """Row order must not decide whether the hierarchy imports."""
    organization, _admin = _org_with_admin()
    _member(organization, "boss@x.com")
    _member(organization, "staff@x.com")
    _headers, rows = member_import.parse_csv(
        _csv("email,manager", "staff@x.com,boss@x.com", "boss@x.com,")
    )
    results = member_import.preflight(organization, rows, False)

    assert results[0].warnings == []
    assert results[0].data["manager"] == "boss@x.com"


def test_unknown_manager_warns_but_still_imports_the_row():
    organization, _admin = _org_with_admin()
    _member(organization, "staff@x.com")
    _headers, rows = member_import.parse_csv(
        _csv("email,manager", "staff@x.com,ghost@x.com")
    )
    results = member_import.preflight(organization, rows, False)

    assert results[0].action == member_import.ACTION_UPDATE
    assert results[0].warnings
    assert results[0].data["manager"] == ""


def test_bad_date_is_a_row_error_not_a_crash():
    organization, _admin = _org_with_admin()
    _member(organization, "a@x.com")
    _headers, rows = member_import.parse_csv(
        _csv("email,hire_date", "a@x.com,15/01/2026")
    )
    results = member_import.preflight(organization, rows, False)

    assert results[0].action == member_import.ACTION_ERROR


# --- apply -----------------------------------------------------------------


def test_apply_updates_members_and_creates_invitations():
    organization, admin = _org_with_admin()
    _member(organization, "old@x.com")
    job = models.ImportJob.objects.create(
        organization=organization,
        created_by=admin,
        source=_csv("email,title", "old@x.com,工程师", "new@x.com,设计师"),
    )
    member_import.run_apply(job.id, actor_id=admin.id)
    job.refresh_from_db()

    assert job.status == models.ImportJobStatusChoices.DONE
    assert models.Membership.objects.get(user__email="old@x.com").title == "工程师"
    invite = models.OrgInvitation.objects.get(email="new@x.com")
    assert invite.title == "设计师"
    # The roster copy is dropped once it is no longer needed.
    assert job.source == ""


def test_blank_cells_leave_existing_values_alone():
    """A CSV that fills two columns must not wipe the other ten."""
    organization, admin = _org_with_admin()
    _member(organization, "a@x.com", title="工程师", work_city="深圳")
    job = models.ImportJob.objects.create(
        organization=organization,
        created_by=admin,
        source=_csv("email,title,work_city", "a@x.com,高级工程师,"),
    )
    member_import.run_apply(job.id, actor_id=admin.id)

    membership = models.Membership.objects.get(user__email="a@x.com")
    assert membership.title == "高级工程师"
    assert membership.work_city == "深圳"


def test_apply_rehires_a_departed_member_in_place():
    organization, admin = _org_with_admin()
    departed = _member(organization, "back@x.com", status=LEFT)
    job = models.ImportJob.objects.create(
        organization=organization,
        created_by=admin,
        source=_csv("email,title", "back@x.com,回归"),
    )
    member_import.run_apply(job.id, actor_id=admin.id)

    assert models.Membership.objects.filter(user__email="back@x.com").count() == 1
    departed.refresh_from_db()
    assert departed.status == ACTIVE
    assert departed.title == "回归"


def test_apply_wires_managers_after_everyone_exists():
    organization, admin = _org_with_admin()
    _member(organization, "boss@x.com")
    _member(organization, "staff@x.com")
    job = models.ImportJob.objects.create(
        organization=organization,
        created_by=admin,
        source=_csv("email,manager", "staff@x.com,boss@x.com", "boss@x.com,"),
    )
    member_import.run_apply(job.id, actor_id=admin.id)

    staff = models.Membership.objects.get(user__email="staff@x.com")
    assert staff.manager is not None
    assert staff.manager.user.email == "boss@x.com"


def test_apply_refuses_a_manager_cycle():
    """A file where A reports to B and B to A must not be able to write one."""
    organization, admin = _org_with_admin()
    _member(organization, "a@x.com")
    _member(organization, "b@x.com")
    job = models.ImportJob.objects.create(
        organization=organization,
        created_by=admin,
        source=_csv("email,manager", "a@x.com,b@x.com", "b@x.com,a@x.com"),
    )
    member_import.run_apply(job.id, actor_id=admin.id)

    a = models.Membership.objects.get(user__email="a@x.com")
    b = models.Membership.objects.get(user__email="b@x.com")
    # At most one direction survives — never both.
    assert not (a.manager_id == b.pk and b.manager_id == a.pk)


def test_a_bad_row_does_not_roll_back_the_good_ones():
    organization, admin = _org_with_admin()
    _member(organization, "ok@x.com")
    job = models.ImportJob.objects.create(
        organization=organization,
        created_by=admin,
        source=_csv("email,hire_date", "ok@x.com,2026-01-15", "bad@x.com,nonsense"),
    )
    member_import.run_apply(job.id, actor_id=admin.id)
    job.refresh_from_db()

    assert job.status == models.ImportJobStatusChoices.PARTIAL
    assert models.Membership.objects.get(user__email="ok@x.com").hire_date is not None


def test_apply_creates_missing_departments_when_opted_in():
    organization, admin = _org_with_admin()
    _member(organization, "a@x.com")
    job = models.ImportJob.objects.create(
        organization=organization,
        created_by=admin,
        create_missing_departments=True,
        source=_csv("email,department", "a@x.com,研发/后端组"),
    )
    member_import.run_apply(job.id, actor_id=admin.id)

    leaf = models.Department.objects.get(organization=organization, name="后端组")
    assert leaf.parent.name == "研发"
    assert leaf.source == models.SourceChoices.IMPORT
    assert models.Membership.objects.get(user__email="a@x.com").department_id == leaf.id


# --- the API ---------------------------------------------------------------


def test_upload_runs_preflight_and_returns_a_preview():
    organization, admin = _org_with_admin()
    _member(organization, "old@x.com")

    response = _upload(_client(admin), _csv("email", "old@x.com", "new@x.com"))
    assert response.status_code == 201, response.data
    assert response.data["status"] == models.ImportJobStatusChoices.PREVIEWED
    assert response.data["summary"]["total"] == 2
    assert response.data["summary"][member_import.ACTION_UPDATE] == 1
    assert response.data["summary"][member_import.ACTION_INVITE] == 1


def test_apply_requires_a_previewed_job():
    organization, admin = _org_with_admin()
    job = models.ImportJob.objects.create(
        organization=organization, created_by=admin, source=_csv("email", "a@x.com")
    )
    response = _client(admin).post(f"/api/v1.0/admin/import-jobs/{job.id}/apply/")
    assert response.status_code == 400


def test_apply_refuses_when_the_preview_on_screen_is_stale():
    organization, admin = _org_with_admin()
    upload = _upload(_client(admin), _csv("email", "a@x.com", "b@x.com"))
    job_id = upload.data["id"]

    response = _client(admin).post(
        f"/api/v1.0/admin/import-jobs/{job_id}/apply/",
        {"expected_total": 99},
        format="json",
    )
    assert response.status_code == 400


def test_apply_writes_one_audit_row_not_one_per_line():
    organization, admin = _org_with_admin()
    upload = _upload(
        _client(admin), _csv("email", "a@x.com", "b@x.com", "c@x.com")
    )
    _client(admin).post(f"/api/v1.0/admin/import-jobs/{upload.data['id']}/apply/")

    assert (
        models.AuditLog.objects.filter(
            action=models.AuditActionChoices.MEMBER_IMPORT
        ).count()
        == 1
    )


def test_non_utf8_upload_is_refused_with_a_usable_message():
    """Excel on a Chinese Windows saves GBK; the mojibake would land as people's names."""
    organization, admin = _org_with_admin()
    payload = io.BytesIO("email,full_name\na@x.com,张三\n".encode("gbk"))
    payload.name = "members.csv"

    response = _client(admin).post(
        "/api/v1.0/admin/import-jobs/", {"file": payload}, format="multipart"
    )
    assert response.status_code == 400
    assert "file" in response.data


def test_import_requires_the_import_permission():
    organization, _admin = _org_with_admin()
    plain = _member(organization, "plain@x.com")

    response = _upload(_client(plain.user), _csv("email", "a@x.com"))
    assert response.status_code == 403


def test_template_download_has_a_bom_and_the_expected_columns():
    _organization, admin = _org_with_admin()
    response = _client(admin).get("/api/v1.0/admin/import-jobs/template/")
    assert response.status_code == 200
    body = b"".join(response.streaming_content).decode("utf-8")
    assert body.startswith("﻿")  # Excel needs it to open the file as UTF-8
    header = body.lstrip("﻿").splitlines()[0]
    assert header.split(",") == member_import.TEMPLATE_COLUMNS


def test_export_round_trips_into_the_import_columns():
    organization, admin = _org_with_admin()
    department = models.Department.objects.create(
        organization=organization, name="研发"
    )
    _member(organization, "a@x.com", department=department, title="工程师")

    response = _client(admin).get("/api/v1.0/admin/member-export/")
    assert response.status_code == 200
    body = b"".join(response.streaming_content).decode("utf-8")
    lines = body.lstrip("﻿").splitlines()
    assert lines[0].split(",") == member_import.TEMPLATE_COLUMNS
    assert any("a@x.com" in line and "工程师" in line for line in lines[1:])


def test_export_excludes_departed_members():
    organization, admin = _org_with_admin()
    _member(organization, "here@x.com")
    _member(organization, "gone@x.com", status=LEFT)

    response = _client(admin).get("/api/v1.0/admin/member-export/")
    body = b"".join(response.streaming_content).decode("utf-8")
    assert "here@x.com" in body
    assert "gone@x.com" not in body


def test_export_is_scoped_for_a_department_scoped_admin():
    """Otherwise export is a hole straight through the scope."""
    organization, _admin = _org_with_admin()
    eng = models.Department.objects.create(organization=organization, name="Eng")
    sales = models.Department.objects.create(organization=organization, name="Sales")
    _member(organization, "in@x.com", department=eng)
    _member(organization, "out@x.com", department=sales)

    scoped = _member(organization, "scoped@x.com", department=eng)
    role = models.AdminRole.objects.create(
        organization=organization,
        code="hr",
        name="HR",
        permissions=["org.import.write"],
    )
    assignment = models.AdminRoleAssignment.objects.create(
        role=role,
        membership=scoped,
        scope_type=models.AdminScopeChoices.DEPARTMENTS,
    )
    models.AdminRoleScopeDepartment.objects.create(
        assignment=assignment, department=eng
    )

    response = _client(scoped.user).get("/api/v1.0/admin/member-export/")
    assert response.status_code == 200
    body = b"".join(response.streaming_content).decode("utf-8")
    assert "in@x.com" in body
    assert "out@x.com" not in body


# --- phone as a first-class key (P10 M2-g) ---------------------------------


def test_a_row_with_only_a_phone_number_imports():
    """The common case now: an admin exports from HR, which has numbers not mailboxes."""
    organization, admin = _org_with_admin()
    source = _csv("phone,full_name,department", "138 0000 0001,张三,")

    upload = _upload(_client(admin), source)
    assert upload.status_code == 201, upload.data
    rows = upload.data["rows"]
    assert [r["action"] for r in rows] == ["invite"]

    apply_response = _client(admin).post(
        f"/api/v1.0/admin/import-jobs/{upload.data['id']}/apply/",
        {"expected_total": 1},
        format="json",
    )
    assert apply_response.status_code == 200, apply_response.data

    invitation = models.OrgInvitation.objects.get(organization=organization)
    assert invitation.phone == "13800000001"  # normalized, not as typed
    assert invitation.email == ""
    assert invitation.full_name == "张三"


def test_two_phone_only_rows_do_not_collide():
    """Both would key on ``email=""`` if the invite lookup ignored phone."""
    organization, admin = _org_with_admin()
    source = _csv("phone,full_name", "13800000001,张三", "13900000002,李四")

    upload = _upload(_client(admin), source)
    _client(admin).post(
        f"/api/v1.0/admin/import-jobs/{upload.data['id']}/apply/", {}, format="json"
    )
    assert models.OrgInvitation.objects.filter(organization=organization).count() == 2


def test_a_row_with_neither_key_is_an_error():
    """The columns are there; this row just filled in neither of them."""
    organization, admin = _org_with_admin()
    upload = _upload(_client(admin), _csv("email,phone,full_name", ",,无名氏"))
    assert upload.data["rows"][0]["action"] == "error"


def test_a_file_with_no_identifying_column_at_all_is_rejected_outright():
    organization, admin = _org_with_admin()
    upload = _upload(_client(admin), _csv("full_name,title", "无名氏,工程师"))
    assert upload.data["status"] == "failed"
    assert "phone" in upload.data["error"]


def test_a_malformed_number_fails_its_row_rather_than_importing_unmatched():
    """Importing it anyway produces someone who can never match their sign-in."""
    organization, admin = _org_with_admin()
    upload = _upload(_client(admin), _csv("phone,full_name", "1380000,张三"))
    row = upload.data["rows"][0]
    assert row["action"] == "error"
    assert any("mobile" in e or "手机" in e for e in row["errors"]), row["errors"]


def test_a_duplicate_number_in_the_file_is_caught():
    organization, admin = _org_with_admin()
    upload = _upload(
        _client(admin),
        _csv("phone,full_name", "13800000001,张三", "+8613800000001,张三again"),
    )
    assert [r["action"] for r in upload.data["rows"]] == ["invite", "error"]


def test_phone_matches_an_existing_member_and_updates_them():
    """Match priority's third tier — and the one an HR export actually carries."""
    organization, admin = _org_with_admin()
    existing = _member(organization, "zhangsan@x.com", title="工程师")
    existing.user.phone = "+8613800000001"
    existing.user.save(update_fields=["phone"])

    upload = _upload(
        _client(admin), _csv("phone,title", "13800000001,高级工程师")
    )
    assert [r["action"] for r in upload.data["rows"]] == ["update"]

    _client(admin).post(
        f"/api/v1.0/admin/import-jobs/{upload.data['id']}/apply/", {}, format="json"
    )
    existing.refresh_from_db()
    assert existing.title == "高级工程师"
    assert models.OrgInvitation.objects.count() == 0


def test_email_still_beats_phone_when_both_are_present():
    """Two people, one file, crossed keys — the address wins by documented rule."""
    organization, admin = _org_with_admin()
    by_email = _member(organization, "a@x.com", title="A")
    by_phone = _member(organization, "b@x.com", title="B")
    by_phone.user.phone = "13800000001"
    by_phone.user.save(update_fields=["phone"])

    upload = _upload(
        _client(admin), _csv("email,phone,title", "a@x.com,13800000001,改了")
    )
    assert upload.data["rows"][0]["action"] == "update"
    _client(admin).post(
        f"/api/v1.0/admin/import-jobs/{upload.data['id']}/apply/", {}, format="json"
    )
    by_email.refresh_from_db()
    by_phone.refresh_from_db()
    assert by_email.title == "改了"
    assert by_phone.title == "B"


def test_a_manager_can_be_named_by_phone_number():
    organization, admin = _org_with_admin()
    boss = _member(organization, "boss@x.com")
    boss.user.phone = "13900000009"
    boss.user.save(update_fields=["phone"])
    report = _member(organization, "report@x.com")

    upload = _upload(
        _client(admin), _csv("email,manager", "report@x.com,13900000009")
    )
    assert upload.data["rows"][0]["warnings"] == []
    _client(admin).post(
        f"/api/v1.0/admin/import-jobs/{upload.data['id']}/apply/", {}, format="json"
    )
    report.refresh_from_db()
    assert report.manager_id == boss.id


def test_the_template_and_the_export_agree_on_the_phone_column():
    """They are positional lists; an insert in one and not the other shifts everything."""
    organization, admin = _org_with_admin()
    member = _member(organization, "zhangsan@x.com")
    member.user.phone = "13800000001"
    member.user.save(update_fields=["phone"])

    # The template carries a BOM so Excel opens it as UTF-8.
    template = member_import.build_template().lstrip("﻿")
    assert template.splitlines()[0].split(",")[:2] == ["email", "phone"]

    response = _client(admin).get("/api/v1.0/admin/member-export/")
    body = b"".join(response.streaming_content).decode("utf-8").lstrip("﻿")
    lines = body.splitlines()
    header = lines[0].split(",")
    # Not lines[1]: the export is ordered by name and the acting admin is in it too.
    row = next(l.split(",") for l in lines[1:] if "13800000001" in l)
    assert row[header.index("phone")] == "13800000001"
    assert row[header.index("email")] == "zhangsan@x.com"
