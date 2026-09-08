"""Reconciliation repairs all existing Docs names, not only the inviting user."""

from unittest import mock

import pytest
import requests

from core import factories
from core.services.docs_client import DocsServiceError
from core.services.docs_profiles import sync_docs_profiles

pytestmark = pytest.mark.django_db


def response(body):
    result = mock.Mock()
    result.json.return_value = body
    return result


@pytest.fixture
def session(settings):
    settings.DOCS_CONFIGURATION = {
        "api_url": "http://docs/api-test/..",
        "server_to_server_token": "test",
    }
    with mock.patch("core.services.docs_profiles.requests.Session") as factory:
        yield factory.return_value.__enter__.return_value


def test_all_pages_and_current_directory_names(session):
    john = factories.UserFactory(full_name="John", short_name="J", email=None)
    other = factories.UserFactory(full_name="Other", short_name=None)
    session.get.side_effect = [
        response({"subs": [john.sub, "standalone-user"], "next_cursor": "page-two"}),
        response({"subs": [other.sub], "next_cursor": None}),
    ]
    session.post.side_effect = [
        response({"results": [{"sub": john.sub, "status": "updated"}]}),
        response({"results": [{"sub": other.sub, "status": "updated"}]}),
    ]
    result = sync_docs_profiles()
    assert result == {"updated": 2, "stale": 0, "missing": 0, "unmatched": 1}
    payload = session.post.call_args_list[0].kwargs["json"]
    assert payload["users"] == [
        {"sub": john.sub, "full_name": "John", "short_name": "J"}
    ]
    assert "observed_at" in payload
    assert session.get.call_args_list[1].kwargs["params"] == {"cursor": "page-two"}


def test_failed_sweep_can_be_retried_from_current_data(session):
    user = factories.UserFactory(full_name="1000")
    session.get.return_value = response({"subs": [user.sub], "next_cursor": None})
    session.post.side_effect = requests.Timeout()
    with pytest.raises(DocsServiceError):
        sync_docs_profiles()
    # A bulk edit does not emit save signals; the next scan still repairs it.
    type(user).objects.filter(pk=user.pk).update(full_name="John")
    session.post.side_effect = None
    session.post.return_value = response(
        {"results": [{"sub": user.sub, "status": "updated"}]}
    )
    assert sync_docs_profiles()["updated"] == 1
    assert session.post.call_args.kwargs["json"]["users"][0]["full_name"] == "John"


def test_incomplete_acknowledgement_is_a_failure(session):
    user = factories.UserFactory()
    session.get.return_value = response({"subs": [user.sub], "next_cursor": None})
    session.post.return_value = response({"results": []})
    with pytest.raises(DocsServiceError):
        sync_docs_profiles()


def test_repeated_cursor_fails_instead_of_looping(session):
    session.get.return_value = response({"subs": [], "next_cursor": "same"})
    with pytest.raises(DocsServiceError):
        sync_docs_profiles()
    assert session.get.call_count == 2
