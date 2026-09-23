"""Real database/storage tests for private material lifecycle and recovery."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import close_old_connections
from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core.factories import MembershipFactory, OrganizationFactory, UserFactory

from work import services
from work.models import WorkMaterial
from work.storage import PrivateMaterialStorage, material_storage

pytestmark = pytest.mark.django_db
ROOT = "/api/v1.0/work/materials/"


@pytest.fixture(autouse=True)
def work_settings(settings, tmp_path):
    settings.WORK_ENABLED = True
    settings.WORK_MATERIALS_ENABLED = True
    settings.WORK_STORAGE = {
        "BACKEND": "django.core.files.storage.FileSystemStorage",
        "OPTIONS": {"location": str(tmp_path / "private")},
    }
    settings.CACHES = {
        "default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}
    }
    settings.ALLOWED_HOSTS = ["testserver", "localhost"]
    settings.OIDC_OP_JWKS_ENDPOINT = "http://localhost/unused-test-jwks"


@pytest.fixture
def client():
    user = UserFactory()
    api = APIClient()
    api.force_authenticate(user=user)
    api.work_user = user
    return api


def upload(
    client, *, data=b"Background\r\nReview plan\n", name="notes.md", key=None, **extra
):
    return client.post(
        ROOT,
        {"file": SimpleUploadedFile(name, data), **extra},
        format="multipart",
        HTTP_IDEMPOTENCY_KEY=str(key or uuid.uuid4()),
    )


def material_id(client):
    response = upload(client)
    assert response.status_code == 201, response.data
    return response.data["id"]


def test_upload_parse_refresh_and_line_preview(client):
    item_id = material_id(client)
    assert client.get(ROOT).data["results"][0]["status"] == "uploaded"
    assert client.get(f"{ROOT}{item_id}/preview/").status_code == 409
    assert services.process_materials() == 1
    detail = client.get(f"{ROOT}{item_id}/")
    assert detail.data["status"] == "ready"
    assert detail.data["line_count"] == 2
    assert "storage_key" not in detail.data and "text" not in detail.data
    preview = client.get(f"{ROOT}{item_id}/preview/")
    assert preview.data["lines"][1] == {
        "number": 2,
        "text": "Review plan",
        "truncated": False,
    }
    assert preview["Cache-Control"] == "no-store"
    assert services.process_materials() == 0


def test_upload_key_deduplicates_and_rejects_changed_content(client):
    key = uuid.uuid4()
    first = upload(client, key=key)
    again = upload(client, key=key)
    assert again.status_code == 200 and first.data["id"] == again.data["id"]
    assert upload(client, key=key, data=b"different").status_code == 409
    assert upload(client, key=key, name="renamed.md").status_code == 409
    assert WorkMaterial.objects.count() == 1


@pytest.mark.parametrize("suffix", ["", "preview/", "retry/"])
def test_other_account_cannot_read_or_retry(client, suffix):
    item_id = material_id(client)
    services.process_materials()
    client.force_authenticate(user=UserFactory())
    assert client.get(ROOT).data["count"] == 0
    if suffix == "retry/":
        response = client.post(
            f"{ROOT}{item_id}/{suffix}",
            {},
            format="json",
            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        )
    else:
        response = client.get(f"{ROOT}{item_id}/{suffix}")
    assert response.status_code == 404
    assert client.delete(f"{ROOT}{item_id}/").status_code == 404


def test_organization_is_server_owned_and_revocation_blocks_reads(client):
    org = OrganizationFactory()
    membership = MembershipFactory(
        user=client.work_user, organization=org, is_primary=True
    )
    assert upload(client, organization=str(uuid.uuid4())).status_code == 400
    item_id = material_id(client)
    item = services.claim_material()
    assert item.organization_id == org.id
    membership.delete()
    services.parse_material(item)
    item.refresh_from_db()
    assert item.error_code == "access_revoked" and not item.text
    assert client.get(f"{ROOT}{item_id}/").status_code == 404


@pytest.mark.parametrize(
    "changes", [{"sub": None}, {"is_device": True}, {"is_active": False}]
)
def test_only_real_active_accounts(changes):
    api = APIClient()
    api.force_authenticate(user=UserFactory(**changes))
    assert api.get(ROOT).status_code == 403
    assert upload(api).status_code == 403


def test_anonymous_rejected():
    assert APIClient().get(ROOT).status_code in {401, 403}


@pytest.mark.parametrize(
    "name,data,code",
    [
        ("report.pdf", b"%PDF-1.4", "unsupported_format"),
        ("notes.txt", b"", "empty_file"),
        ("fake.md", b"PK\x03\x04blob", "not_text"),
        ("fake.txt", b"hello\x00there", "not_text"),
    ],
)
def test_invalid_uploads_are_not_stored(client, name, data, code):
    response = upload(client, name=name, data=data)
    assert response.status_code == 400
    assert response.data["code"] == code
    assert not WorkMaterial.objects.exists()


def test_size_quota_and_required_key(client):
    with patch.object(services, "MAX_FILE_BYTES", 4):
        assert upload(client, data=b"12345").status_code == 413
    with patch.object(services, "MAX_OWNER_BYTES", 3):
        assert upload(client, data=b"1234").status_code == 413
    response = client.post(
        ROOT, {"file": SimpleUploadedFile("a.txt", b"text")}, format="multipart"
    )
    assert response.status_code == 400
    assert not WorkMaterial.objects.exists()


def test_failed_parse_retry_is_fenced_and_idempotent(client):
    item_id = material_id(client)
    with patch(
        "work.services.material_storage", side_effect=OSError("private-path-secret")
    ):
        services.process_materials()
    item = WorkMaterial.objects.get(pk=item_id)
    assert item.status == "failed" and item.error_code == "parse_unavailable"
    retry_key = str(uuid.uuid4())
    for _ in range(2):
        response = client.post(
            f"{ROOT}{item_id}/retry/",
            {"generation": item.generation},
            format="json",
            HTTP_IDEMPOTENCY_KEY=retry_key,
        )
        assert response.status_code in {200, 202}
    assert services.process_materials() == 1
    assert client.get(f"{ROOT}{item_id}/").data["status"] == "ready"
    response = client.post(
        f"{ROOT}{item_id}/retry/",
        {"generation": item.generation},
        format="json",
        HTTP_IDEMPOTENCY_KEY=retry_key,
    )
    assert response.status_code == 200
    assert services.process_materials() == 0


def test_worker_restart_and_late_generation(client):
    item_id = material_id(client)
    first = services.claim_material()
    assert services.claim_material() is None
    WorkMaterial.objects.filter(pk=item_id).update(
        lease_until=timezone.now() - timedelta(seconds=1)
    )
    second = services.claim_material()
    assert second.generation == first.generation + 1
    assert services.finish_material(first, text="stale") is False
    services.parse_material(second)
    assert (
        client.get(f"{ROOT}{item_id}/preview/").data["lines"][0]["text"] == "Background"
    )


def test_delete_blocks_late_result_and_cleanup_retries(client):
    key = uuid.uuid4()
    item_id = upload(client, key=key).data["id"]
    claimed = services.claim_material()
    assert client.delete(f"{ROOT}{item_id}/").status_code == 204
    assert services.finish_material(claimed, text="late") is False
    assert client.get(f"{ROOT}{item_id}/").status_code == 404
    assert upload(client, key=key).status_code == 410
    with patch("work.services.material_storage", side_effect=OSError("offline")):
        services.cleanup_deleted()
    assert WorkMaterial.objects.get(pk=item_id).purged_at is None
    services.cleanup_deleted()
    assert WorkMaterial.objects.get(pk=item_id).purged_at is not None
    assert not material_storage().exists(claimed.storage_key)


def test_disabled_stops_writes_not_private_history(client, settings):
    item_id = material_id(client)
    services.process_materials()
    settings.WORK_ENABLED = False
    assert upload(client).status_code == 404
    assert services.process_materials() == 0
    assert client.get(f"{ROOT}{item_id}/preview/").status_code == 200
    assert client.delete(f"{ROOT}{item_id}/").status_code == 204


@pytest.mark.parametrize(
    "data,code",
    [
        (b"\xffbad", "unsupported_encoding"),
        (b" \n\t", "empty_text"),
        (b"text\x01", "not_text"),
        (b"x" * 200001, "text_limit_exceeded"),
    ],
    ids=["encoding", "empty", "binary", "length"],
)
def test_parser_errors_are_explicit(client, data, code):
    item_id = upload(client, data=data).data["id"]
    services.process_materials()
    assert client.get(f"{ROOT}{item_id}/").data["error_code"] == code


def test_preview_pagination_and_plaintext_markup(client):
    data = ("<script>alert(1)</script>\n" + "line\n" * 101).encode()
    item_id = upload(client, data=data).data["id"]
    services.process_materials()
    first = client.get(f"{ROOT}{item_id}/preview/").data
    assert first["lines"][0]["text"] == "<script>alert(1)</script>"
    assert first["next_start"] == 101
    assert len(client.get(f"{ROOT}{item_id}/preview/?start=101").data["lines"]) == 2
    assert client.get(f"{ROOT}{item_id}/preview/?start=-1").status_code == 400


def test_storage_upload_failure_leaves_no_job(client):
    with patch(
        "work.services.material_storage", side_effect=OSError("credential-secret")
    ):
        response = upload(client)
    assert response.status_code == 503
    assert "secret" not in str(response.data)
    assert not WorkMaterial.objects.exists()


def test_session_upload_requires_csrf(client, settings):
    settings.SESSION_ENGINE = "django.contrib.sessions.backends.db"
    api = APIClient(enforce_csrf_checks=True)
    api.force_login(
        client.work_user, backend="django.contrib.auth.backends.ModelBackend"
    )
    assert upload(api).status_code == 403
    api.cookies["csrftoken"] = "a" * 32
    response = api.post(
        ROOT,
        {"file": SimpleUploadedFile("csrf.txt", b"text")},
        format="multipart",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        HTTP_X_CSRFTOKEN="a" * 32,
    )
    assert response.status_code == 201


def test_multipart_multiple_files_rejected_before_storage(client):
    response = client.post(
        ROOT,
        {
            "file": [
                SimpleUploadedFile("a.txt", b"a"),
                SimpleUploadedFile("b.txt", b"b"),
            ]
        },
        format="multipart",
        HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
    )
    assert response.status_code == 400
    assert not WorkMaterial.objects.exists()


def test_preview_long_line_is_explicitly_truncated(client):
    item_id = upload(client, data=b"a" * 2001).data["id"]
    services.process_materials()
    line = client.get(f"{ROOT}{item_id}/preview/").data["lines"][0]
    assert len(line["text"]) == 2000 and line["truncated"] is True
    assert len(WorkMaterial.objects.get(pk=item_id).text) == 2001


@pytest.mark.django_db(transaction=True)
def test_concurrent_uploads_share_one_material():
    user = UserFactory()
    key = uuid.uuid4()

    def create_one():
        try:
            material, _ = services.create_material(
                user, SimpleUploadedFile("parallel.txt", b"same input"), key
            )
            return material.pk
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        ids = list(pool.map(lambda _: create_one(), range(2)))
    assert ids[0] == ids[1]
    assert WorkMaterial.objects.count() == 1


def test_s3_parameters_do_not_inherit_public_object_acl():
    storage = PrivateMaterialStorage(
        access_key="local-test",
        secret_key="local-test",
        object_parameters={"ACL": "public-read", "CacheControl": "max-age=3600"},
    )
    assert storage.get_object_parameters("fixture")["ACL"] == "private"
    assert (
        storage.get_object_parameters("fixture")["CacheControl"] == "private, no-store"
    )
    with pytest.raises(NotImplementedError):
        storage.url("fixture")
