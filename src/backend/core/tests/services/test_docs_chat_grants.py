"""Explicit grants must not silently succeed against an older Docs server."""

from unittest import mock

import pytest

from core.services.docs_client import DocsBadResponseError, DocsClient


@pytest.mark.parametrize(
    "reply",
    [
        {"granted": 1},
        {"role": "reader", "complete": True},
        {"role": "editor", "complete": False},
        {"role": "editor", "complete": "true"},
    ],
)
def test_explicit_grant_requires_matching_acknowledgement(reply):
    """Missing, mismatched, and partial acknowledgements remain retryable."""
    client = DocsClient("https://docs.example.test", "test-token")
    with mock.patch("core.services.docs_client.requests.post") as post:
        post.return_value = mock.Mock(status_code=200, json=lambda: reply)
        with pytest.raises(DocsBadResponseError):
            client.grant_access_for_users(
                doc_id="d1",
                users=[{"sub": "recipient"}],
                role="editor",
                actor_sub="owner",
            )


def test_explicit_grant_accepts_idempotent_completion():
    """Zero new grants is successful when all recipients already have access."""
    client = DocsClient("https://docs.example.test", "test-token")
    with mock.patch("core.services.docs_client.requests.post") as post:
        post.return_value = mock.Mock(
            status_code=200,
            json=lambda: {"granted": 0, "role": "editor", "complete": True},
        )
        assert (
            client.grant_access_for_users(
                doc_id="d1",
                users=[{"sub": "recipient"}],
                role="editor",
                actor_sub="owner",
            )
            == 0
        )
        assert post.call_args.kwargs["json"]["actor_sub"] == "owner"
