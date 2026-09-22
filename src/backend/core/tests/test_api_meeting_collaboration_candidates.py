"""Candidates endpoint: cursor pagination and the picker's row shape.

Written as direct handler calls with a fake queryset on purpose — the pagination
arithmetic and the id/name/avatar contract are what the shared picker depends on,
and those need no schema, so this stays runnable without a PostgreSQL instance.
"""

from types import SimpleNamespace
from unittest.mock import patch

from core.api.meeting_collaboration import (
    CANDIDATES_PAGE,
    CollaborationCandidatesView,
)


class Page(list):
    """Fake queryset: slicing an already-materialized list is enough here."""

    def filter(self, **_kwargs):
        return self

    def order_by(self, *_fields):
        return self


def request(*, query="", cursor=None, kind="users"):
    params = {"q": query, "kind": kind}
    if cursor is not None:
        params["cursor"] = cursor
    return SimpleNamespace(query_params=params, user=SimpleNamespace(pk="actor"))


def call(view_request, scope="record"):
    view = CollaborationCandidatesView()
    with (
        patch.object(view, "record") as resolve,
        patch("core.api.meeting_collaboration.service.can_manage", return_value=True),
    ):
        resolve.return_value = SimpleNamespace(organization_id="org")
        return view.get(view_request, "record-id", scope)


def people(count):
    return Page(
        SimpleNamespace(
            pk=f"person-{index:03d}",
            full_name=f"Person {index:03d}",
            avatar_key="",
        )
        for index in range(count)
    )


def test_people_are_cursored_and_carry_the_picker_fields():
    with patch(
        "core.api.meeting_collaboration.eligible_users",
        return_value=people(CANDIDATES_PAGE + 1),
    ):
        first = call(request()).data
        second = call(request(cursor=first["next_cursor"])).data
    assert len(first["results"]) == CANDIDATES_PAGE
    assert first["results"][0] == {
        "id": "person-000",
        "name": "Person 000",
        "avatar_url": "",
    }
    # Exactly one page's worth means "no more", not "one more empty page".
    assert second["next_cursor"] is None
    assert second["results"][0]["id"] == f"person-{CANDIDATES_PAGE:03d}"


def test_a_short_page_ends_paging():
    with patch(
        "core.api.meeting_collaboration.eligible_users",
        return_value=people(3),
    ):
        page = call(request()).data
    assert len(page["results"]) == 3
    assert page["next_cursor"] is None


def test_groups_stay_out_of_the_record_scope():
    # Mirrors the write path: a record can be granted to people and departments,
    # never to a user group.
    assert call(request(kind="groups"), scope="record").data == {
        "results": [],
        "next_cursor": None,
    }
