"""Private reusable ASR hints, explicit writes and concurrent edit protection."""

from concurrent.futures import ThreadPoolExecutor

from django.db import close_old_connections

import pytest
from rest_framework.test import APIClient

from core import models
from core.factories import UserFactory
from core.tests.services.test_meeting_records import client_for

pytestmark = pytest.mark.django_db
URL = "/api/v1.0/recording-hotwords/"


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True


def save(user, text, revision=0, **extra):
    return client_for(user).put(
        URL, {"text": text, "expected_revision": revision, **extra}, format="json"
    )


def test_read_does_not_create_and_normalized_words_sync_across_clients():
    user = UserFactory()
    assert client_for(user).get(URL).data == {"words": [], "revision": 0}
    assert not models.PersonalHotwords.objects.exists()
    response = save(user, " 妙记 \r\nQwen\n妙记\n\nqwen ")
    assert response.status_code == 200
    assert response.data == {"words": ["妙记", "Qwen", "qwen"], "revision": 1}
    assert client_for(user).get(URL).data == response.data
    assert response["Cache-Control"] == "private, no-store"


def test_lost_response_replay_and_noop_do_not_advance_revision():
    user = UserFactory()
    first = save(user, "term")
    assert save(user, "term").data == first.data
    assert save(user, "term", 1).data == first.data
    assert models.PersonalHotwords.objects.count() == 1


def test_stale_edit_and_old_request_cannot_overwrite_newer_words():
    user = UserFactory()
    save(user, "term")
    assert save(user, "other", 0).status_code == 409
    assert save(user, "new", 1).status_code == 200
    assert save(user, "term", 0).status_code == 409
    assert client_for(user).get(URL).data == {"words": ["new"], "revision": 2}


def test_clear_retains_revision_so_old_requests_cannot_restore_deleted_words():
    user = UserFactory()
    assert save(user, "").data == {"words": [], "revision": 0}
    save(user, "term")
    assert save(user, "", 1).data == {"words": [], "revision": 2}
    assert save(user, "term", 0).status_code == 409
    assert save(user, "", 1).data == {"words": [], "revision": 2}


def test_accounts_are_isolated_and_owner_cannot_be_selected_by_request():
    owner, other = UserFactory.create_batch(2)
    save(owner, "private")
    assert client_for(other).get(URL + f"?user={owner.pk}").data == {
        "words": [],
        "revision": 0,
    }
    assert save(other, "overwrite", user_id=str(owner.pk)).status_code == 400
    assert client_for(other).get(URL + str(owner.pk) + "/").status_code == 404
    save(other, "own")
    assert client_for(owner).get(URL).data["words"] == ["private"]


@pytest.mark.parametrize(
    "body",
    [
        {"text": "x" * 41, "expected_revision": 0},
        {"text": "\n".join(str(n) for n in range(101)), "expected_revision": 0},
        {"text": "x" * 4001, "expected_revision": 0},
        {"text": "x", "expected_revision": -1},
        {"text": ["x"], "expected_revision": 0},
        {"text": "x"},
    ],
)
def test_invalid_vocabulary_does_not_write(body):
    response = client_for(UserFactory()).put(URL, body, format="json")
    assert response.status_code == 400
    assert not models.PersonalHotwords.objects.exists()


def test_disabled_and_anonymous_requests_are_rejected(settings):
    assert APIClient().get(URL).status_code == 401
    settings.MEETING_RECORDS_ENABLED = False
    assert client_for(UserFactory()).get(URL).status_code == 404


@pytest.mark.django_db(transaction=True)
def test_concurrent_first_writes_are_serialized():
    user = UserFactory()

    def write(text):
        close_old_connections()
        try:
            return save(user, text).status_code
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(write, ["first", "second"]))
    assert sorted(statuses) == [200, 409]
    assert models.PersonalHotwords.objects.count() == 1
    assert models.PersonalHotwords.objects.get().revision == 1
