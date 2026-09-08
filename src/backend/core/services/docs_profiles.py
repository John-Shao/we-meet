"""Reconcile every existing Docs identity against the authoritative Meet directory."""

from django.conf import settings
from django.utils import timezone

import requests

from core import models
from core.services.docs_client import DocsServiceError


def sync_docs_profiles():
    """A complete sweep repairs missed events, bulk edits and historical stale names."""
    config = getattr(settings, "DOCS_CONFIGURATION", None) or {}
    if not config.get("api_url") or not config.get("server_to_server_token"):
        raise DocsServiceError("Docs synchronization is not configured")
    url = str(config["api_url"]).rstrip("/") + "/api/v1.0/users/directory-profiles/"
    headers = {"Authorization": f"Bearer {config['server_to_server_token']}"}
    timeout = float(config.get("request_timeout_seconds") or 10)
    total = {"updated": 0, "stale": 0, "missing": 0, "unmatched": 0}
    cursor = None
    seen_cursors = set()
    with requests.Session() as session:
        while True:
            try:
                response = session.get(
                    url,
                    params={"cursor": cursor} if cursor else {},
                    headers=headers,
                    timeout=timeout,
                )
                response.raise_for_status()
                page = response.json()
                if not isinstance(page, dict) or not isinstance(page.get("subs"), list):
                    raise ValueError("Invalid identity page")
                subs = page["subs"]
                if (
                    len(subs) > 100
                    or any(not isinstance(sub, str) or not sub for sub in subs)
                    or len(set(subs)) != len(subs)
                ):
                    raise ValueError("Invalid identities")
                # This is the snapshot's ordering token, captured BEFORE reading names.
                observed_at = timezone.now().isoformat()
                users = list(
                    models.User.objects.filter(sub__in=subs, is_device=False).values(
                        "sub", "full_name", "short_name"
                    )
                )
                total["unmatched"] += len(subs) - len(users)
                if users:
                    payload = {
                        "observed_at": observed_at,
                        "users": [
                            {
                                "sub": row["sub"],
                                "full_name": row["full_name"] or "",
                                "short_name": row["short_name"] or "",
                            }
                            for row in users
                        ],
                    }
                    response = session.post(
                        url, json=payload, headers=headers, timeout=timeout
                    )
                    response.raise_for_status()
                    body = response.json()
                    rows = body.get("results") if isinstance(body, dict) else None
                    if not isinstance(rows, list) or any(
                        not isinstance(row, dict)
                        or row.get("status") not in ("updated", "stale", "missing")
                        or not isinstance(row.get("sub"), str)
                        for row in rows
                    ):
                        raise ValueError("Invalid acknowledgement")
                    if len(rows) != len(users) or {row["sub"] for row in rows} != {
                        row["sub"] for row in users
                    }:
                        raise ValueError("Incomplete acknowledgement")
                    for row in rows:
                        total[row["status"]] += 1
                if "next_cursor" not in page:
                    raise ValueError("Missing pagination acknowledgement")
                cursor = page["next_cursor"]
                if cursor is None:
                    return total
                if not isinstance(cursor, str) or not cursor or cursor in seen_cursors:
                    raise ValueError("Invalid pagination cursor")
                seen_cursors.add(cursor)
            except (requests.RequestException, ValueError) as exc:
                raise DocsServiceError(
                    "Docs profile reconciliation failed; retry the sweep"
                ) from exc
