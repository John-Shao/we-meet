"""Provider-neutral Google Calendar and Microsoft Graph synchronization."""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from datetime import timezone as dt_timezone
from urllib.parse import quote, urlencode

from django.conf import settings
from django.core.cache import cache
from django.db import transaction
from django.utils import timezone

import requests
from dateutil.parser import isoparse

from core import models
from core.services import calendar_crypto

STATE_PREFIX = "external-calendar-oauth:"
STATE_TTL = 600


class ProviderError(Exception):
    pass


class ProviderConflict(ProviderError):
    pass


@dataclass(frozen=True)
class RemoteCalendar:
    id: str
    name: str
    primary: bool = False


def _config(provider: str) -> dict:
    cfg = getattr(settings, "EXTERNAL_CALENDAR_CONFIGURATION", None) or {}
    # Deployment settings are intentionally flat so every secret can be
    # supplied by an independent environment variable.  Keep nested values as
    # an override for tests/private deployments.
    provider_cfg = {
        "client_id": cfg.get(f"{provider}_client_id"),
        "client_secret": cfg.get(f"{provider}_client_secret"),
        "request_timeout_seconds": cfg.get("request_timeout_seconds"),
        **(cfg.get(provider) or {}),
    }
    if not provider_cfg.get("client_id") or not provider_cfg.get("client_secret"):
        raise ProviderError(f"{provider} OAuth is not configured")
    return provider_cfg


def _pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


class Provider:
    name = ""
    scopes: tuple[str, ...] = ()
    authorize_endpoint = ""
    token_endpoint = ""

    def __init__(self):
        self.cfg = _config(self.name)
        self.timeout = float(self.cfg.get("request_timeout_seconds") or 10)

    def authorization_url(self, user_id: str, redirect_uri: str) -> str:
        state = secrets.token_urlsafe(40)
        verifier, challenge = _pkce()
        cache.set(
            STATE_PREFIX + state,
            {"user_id": user_id, "verifier": verifier, "redirect_uri": redirect_uri},
            STATE_TTL,
        )
        params = {
            "client_id": self.cfg["client_id"],
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(self.scopes),
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            **self.authorization_extra(),
        }
        return self.authorize_endpoint + "?" + urlencode(params)

    def authorization_extra(self):
        return {}

    def exchange(self, code: str, state: str) -> tuple[dict, dict]:
        state_data = cache.get(STATE_PREFIX + state)
        if not state_data:
            raise ProviderError("OAuth state is invalid or expired")
        cache.delete(STATE_PREFIX + state)
        response = requests.post(
            self.token_endpoint,
            data={
                "client_id": self.cfg["client_id"],
                "client_secret": self.cfg["client_secret"],
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": state_data["redirect_uri"],
                "code_verifier": state_data["verifier"],
            },
            timeout=self.timeout,
        )
        if not response.ok:
            raise ProviderError(f"token exchange returned {response.status_code}")
        return response.json(), state_data

    def refresh(self, account):
        response = requests.post(
            self.token_endpoint,
            data={
                "client_id": self.cfg["client_id"],
                "client_secret": self.cfg["client_secret"],
                "grant_type": "refresh_token",
                "refresh_token": calendar_crypto.decrypt(
                    account.refresh_token_encrypted
                ),
                **self.refresh_extra(),
            },
            timeout=self.timeout,
        )
        if not response.ok:
            account.status = models.ExternalCalendarAccountStatusChoices.REAUTH_REQUIRED
            account.error_code = "refresh_failed"
            account.save(update_fields=["status", "error_code", "updated_at"])
            raise ProviderError("provider token refresh failed")
        payload = response.json()
        account.access_token_encrypted = calendar_crypto.encrypt(payload["access_token"])
        if payload.get("refresh_token"):
            account.refresh_token_encrypted = calendar_crypto.encrypt(
                payload["refresh_token"]
            )
        account.token_expires_at = timezone.now() + timedelta(
            seconds=max(0, int(payload.get("expires_in") or 3600) - 60)
        )
        account.status = models.ExternalCalendarAccountStatusChoices.ACTIVE
        account.error_code = ""
        account.save()

    def refresh_extra(self):
        return {}

    def token(self, account) -> str:
        if account.token_expires_at and account.token_expires_at <= timezone.now():
            self.refresh(account)
        return calendar_crypto.decrypt(account.access_token_encrypted)

    def get(self, account, url, params=None):
        response = requests.get(
            url,
            params=params,
            headers={"Authorization": f"Bearer {self.token(account)}"},
            timeout=self.timeout,
        )
        if not response.ok:
            raise ProviderError(f"provider GET returned {response.status_code}")
        return response.json()

    def identity(self, access_token: str) -> dict:
        raise NotImplementedError

    def calendars(self, account) -> list[RemoteCalendar]:
        raise NotImplementedError

    def changes(self, binding) -> tuple[list[dict], str]:
        raise NotImplementedError

    def write_event(self, entry):
        raise NotImplementedError

    def renew_webhook(self, binding, callback_url: str):
        return None


class GoogleProvider(Provider):
    name = "google"
    scopes = (
        "openid",
        "email",
        "https://www.googleapis.com/auth/calendar",
    )
    authorize_endpoint = "https://accounts.google.com/o/oauth2/v2/auth"
    token_endpoint = "https://oauth2.googleapis.com/token"  # noqa: S105
    api = "https://www.googleapis.com/calendar/v3"

    def authorization_extra(self):
        return {"access_type": "offline", "prompt": "consent"}

    def identity(self, access_token):
        response = requests.get(
            "https://www.googleapis.com/oauth2/v2/userinfo",
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=self.timeout,
        )
        if not response.ok:
            raise ProviderError("could not resolve Google account")
        return response.json()

    def calendars(self, account):
        payload = self.get(account, f"{self.api}/users/me/calendarList")
        return [
            RemoteCalendar(
                id=item["id"], name=item.get("summary") or item["id"], primary=bool(item.get("primary"))
            )
            for item in payload.get("items", [])
            if item.get("accessRole") in ("owner", "writer")
        ]

    def changes(self, binding):
        url = f"{self.api}/calendars/{quote(binding.remote_calendar_id, safe='')}/events"
        params = {"singleEvents": "true", "showDeleted": "true", "maxResults": 2500}
        if binding.sync_cursor:
            params["syncToken"] = binding.sync_cursor
        else:
            params["timeMin"] = datetime.combine(
                binding.sync_window_start, datetime.min.time(), tzinfo=dt_timezone.utc
            ).isoformat()
            params["timeMax"] = datetime.combine(
                binding.sync_window_end, datetime.max.time(), tzinfo=dt_timezone.utc
            ).isoformat()
        items = []
        while url:
            response = requests.get(
                url,
                params=params,
                headers={"Authorization": f"Bearer {self.token(binding.account)}"},
                timeout=self.timeout,
            )
            if response.status_code == 410:
                binding.sync_cursor = ""
                binding.save(update_fields=["sync_cursor", "updated_at"])
                return self.changes(binding)
            if not response.ok:
                raise ProviderError(f"Google events returned {response.status_code}")
            payload = response.json()
            items.extend(payload.get("items", []))
            page = payload.get("nextPageToken")
            if page:
                params = {"pageToken": page, "syncToken": binding.sync_cursor} if binding.sync_cursor else {**params, "pageToken": page}
            else:
                return items, payload.get("nextSyncToken") or binding.sync_cursor

    def write_event(self, entry):
        binding, event = entry.binding, entry.event
        base = f"{self.api}/calendars/{quote(binding.remote_calendar_id, safe='')}/events"
        mirror = getattr(event, "external_mirror", None) if event else None
        url = base if entry.operation == "create" else f"{base}/{quote(mirror.remote_event_id, safe='')}"
        headers = {"Authorization": f"Bearer {self.token(binding.account)}", "Content-Type": "application/json"}
        if entry.expected_revision:
            headers["If-Match"] = entry.expected_revision
        method = requests.post if entry.operation == "create" else requests.patch
        if entry.operation == "delete":
            response = requests.delete(url, headers=headers, timeout=self.timeout)
        else:
            response = method(url, headers=headers, json=entry.payload, timeout=self.timeout)
        if response.status_code == 412:
            raise ProviderConflict()
        if not response.ok:
            raise ProviderError(f"Google write returned {response.status_code}")
        return response.json() if response.content else {}

    def renew_webhook(self, binding, callback_url):
        channel_id = str(uuid.uuid4())
        secret = secrets.token_urlsafe(32)
        url = f"{self.api}/calendars/{quote(binding.remote_calendar_id, safe='')}/events/watch"
        response = requests.post(
            url,
            headers={"Authorization": f"Bearer {self.token(binding.account)}"},
            json={
                "id": channel_id,
                "type": "web_hook",
                "address": callback_url.rstrip("/") + "/google/",
                "token": secret,
            },
            timeout=self.timeout,
        )
        if not response.ok:
            raise ProviderError(f"Google watch returned {response.status_code}")
        payload = response.json()
        binding.webhook_id = channel_id
        binding.webhook_secret = secret
        expiration = payload.get("expiration")
        binding.webhook_expires_at = (
            datetime.fromtimestamp(int(expiration) / 1000, tz=dt_timezone.utc)
            if expiration
            else timezone.now() + timedelta(days=1)
        )
        binding.save()


class MicrosoftProvider(Provider):
    name = "microsoft"
    scopes = ("openid", "email", "offline_access", "Calendars.ReadWrite", "User.Read")
    authorize_endpoint = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
    token_endpoint = "https://login.microsoftonline.com/common/oauth2/v2.0/token"  # noqa: S105
    api = "https://graph.microsoft.com/v1.0"

    def refresh_extra(self):
        return {"scope": " ".join(self.scopes)}

    def identity(self, access_token):
        response = requests.get(
            f"{self.api}/me",
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=self.timeout,
        )
        if not response.ok:
            raise ProviderError("could not resolve Microsoft account")
        return response.json()

    def calendars(self, account):
        payload = self.get(account, f"{self.api}/me/calendars")
        return [
            RemoteCalendar(
                id=item["id"],
                name=item.get("name") or item["id"],
                primary=bool(item.get("isDefaultCalendar")),
            )
            for item in payload.get("value", [])
            if item.get("canEdit", True)
        ]

    def changes(self, binding):
        url = binding.sync_cursor or (
            f"{self.api}/me/calendars/{quote(binding.remote_calendar_id, safe='')}/calendarView/delta?"
            + urlencode(
                {
                    "startDateTime": datetime.combine(binding.sync_window_start, datetime.min.time(), tzinfo=dt_timezone.utc).isoformat(),
                    "endDateTime": datetime.combine(binding.sync_window_end, datetime.max.time(), tzinfo=dt_timezone.utc).isoformat(),
                }
            )
        )
        items = []
        while url:
            payload = self.get(binding.account, url)
            items.extend(payload.get("value", []))
            next_url = payload.get("@odata.nextLink")
            if next_url:
                url = next_url
            else:
                return items, payload.get("@odata.deltaLink") or binding.sync_cursor

    def write_event(self, entry):
        binding, event = entry.binding, entry.event
        base = f"{self.api}/me/calendars/{quote(binding.remote_calendar_id, safe='')}/events"
        mirror = getattr(event, "external_mirror", None) if event else None
        url = base if entry.operation == "create" else f"{base}/{quote(mirror.remote_event_id, safe='')}"
        headers = {"Authorization": f"Bearer {self.token(binding.account)}", "Content-Type": "application/json"}
        if entry.expected_revision:
            headers["If-Match"] = entry.expected_revision
        if entry.operation == "delete":
            response = requests.delete(url, headers=headers, timeout=self.timeout)
        else:
            method = requests.post if entry.operation == "create" else requests.patch
            response = method(url, headers=headers, json=entry.payload, timeout=self.timeout)
        if response.status_code in (409, 412):
            raise ProviderConflict()
        if not response.ok:
            raise ProviderError(f"Microsoft write returned {response.status_code}")
        return response.json() if response.content else {}

    def renew_webhook(self, binding, callback_url):
        secret = secrets.token_urlsafe(32)
        expiration = timezone.now() + timedelta(days=2)
        response = requests.post(
            f"{self.api}/subscriptions",
            headers={
                "Authorization": f"Bearer {self.token(binding.account)}",
                "Content-Type": "application/json",
            },
            json={
                "changeType": "created,updated,deleted",
                "notificationUrl": callback_url.rstrip("/") + "/microsoft/",
                "resource": f"me/calendars/{binding.remote_calendar_id}/events",
                "expirationDateTime": expiration.isoformat(),
                "clientState": secret,
            },
            timeout=self.timeout,
        )
        if not response.ok:
            raise ProviderError(f"Microsoft subscription returned {response.status_code}")
        payload = response.json()
        binding.webhook_id = str(payload["id"])
        binding.webhook_secret = secret
        binding.webhook_expires_at = isoparse(payload["expirationDateTime"])
        binding.save()


def provider(name: str) -> Provider:
    if name == models.ExternalCalendarProviderChoices.GOOGLE:
        return GoogleProvider()
    if name == models.ExternalCalendarProviderChoices.MICROSOFT:
        return MicrosoftProvider()
    raise ProviderError("unsupported provider")


def store_account(user, organization, provider_name, token_payload, identity):
    account_id = identity.get("id") or identity.get("sub") or identity.get("mail") or identity.get("userPrincipalName")
    email = identity.get("email") or identity.get("mail") or identity.get("userPrincipalName") or ""
    if not account_id:
        raise ProviderError("provider identity has no stable id")
    account, _ = models.ExternalCalendarAccount.objects.update_or_create(
        owner=user,
        provider=provider_name,
        provider_account_id=str(account_id),
        defaults={
            "organization": organization,
            "email": email,
            "access_token_encrypted": calendar_crypto.encrypt(token_payload["access_token"]),
            "refresh_token_encrypted": calendar_crypto.encrypt(token_payload.get("refresh_token") or ""),
            "token_expires_at": timezone.now() + timedelta(seconds=max(0, int(token_payload.get("expires_in") or 3600) - 60)),
            "scopes": str(token_payload.get("scope") or "").split(),
            "status": models.ExternalCalendarAccountStatusChoices.ACTIVE,
            "error_code": "",
        },
    )
    return account


def create_bindings(account, selected_ids):
    remote = {item.id: item for item in provider(account.provider).calendars(account)}
    selected = set(selected_ids)
    if not selected.issubset(remote):
        raise ProviderError("one or more provider calendars are unavailable")
    today = timezone.now().date()
    bindings = []
    with transaction.atomic():
        # Calendar selection is authoritative.  Removing a binding only removes
        # the local mirror; providers are never mutated by disconnect/select.
        account.bindings.exclude(remote_calendar_id__in=selected).delete()
        for remote_id in selected:
            item = remote[remote_id]
            binding = account.bindings.filter(remote_calendar_id=remote_id).first()
            if binding is None:
                calendar = models.Calendar.objects.create(
                    organization=account.organization,
                    owner=account.owner,
                    kind=models.CalendarKindChoices.EXTERNAL,
                    name=item.name,
                    organization_default_access=models.CalendarAccessChoices.NONE,
                )
                models.CalendarSubscription.objects.create(
                    calendar=calendar,
                    subscriber=account.owner,
                    enabled=True,
                    color="#3370ff",
                )
                binding = models.ExternalCalendarBinding.objects.create(
                    account=account,
                    remote_calendar_id=remote_id,
                    calendar=calendar,
                    sync_window_start=today - timedelta(days=365),
                    sync_window_end=today + timedelta(days=730),
                )
            binding.remote_name = item.name
            binding.is_primary = item.primary
            binding.sync_status = "pending"
            binding.calendar.name = item.name
            binding.calendar.save(update_fields=["name", "updated_at"])
            binding.save(
                update_fields=["remote_name", "is_primary", "sync_status", "updated_at"]
            )
            bindings.append(binding)
    return bindings


def _parse_remote(binding, payload):
    if binding.account.provider == models.ExternalCalendarProviderChoices.GOOGLE:
        cancelled = payload.get("status") == "cancelled"
        start_value = payload.get("start") or {}
        end_value = payload.get("end") or {}
        all_day = bool(start_value.get("date"))
        start = start_value.get("date") or start_value.get("dateTime")
        end = end_value.get("date") or end_value.get("dateTime")
        title = payload.get("summary") or "(无主题)"
        revision = payload.get("etag") or ""
        remote_id = payload.get("id")
        updated = payload.get("updated")
        location = payload.get("location") or ""
        description = payload.get("description") or ""
        attendees = payload.get("attendees") or []
        private = payload.get("visibility") == "private"
    else:
        cancelled = bool(payload.get("@removed")) or payload.get("isCancelled", False)
        start_value = payload.get("start") or {}
        end_value = payload.get("end") or {}
        all_day = bool(payload.get("isAllDay"))
        start = start_value.get("dateTime")
        end = end_value.get("dateTime")
        title = payload.get("subject") or "(无主题)"
        revision = payload.get("changeKey") or payload.get("@odata.etag") or ""
        remote_id = payload.get("id")
        updated = payload.get("lastModifiedDateTime")
        location = (payload.get("location") or {}).get("displayName") or ""
        body = payload.get("body") or {}
        description = body.get("content") or ""
        attendees = [item.get("emailAddress") or {} for item in payload.get("attendees") or []]
        private = payload.get("sensitivity") in ("private", "confidential")
    return {
        "cancelled": cancelled,
        "remote_id": str(remote_id or ""),
        "revision": revision,
        "updated": isoparse(updated) if updated else None,
        "all_day": all_day,
        "start": start,
        "end": end,
        "title": title,
        "description": description,
        "location": location,
        "attendees": attendees,
        "private": private,
    }


def _apply_remote(binding, payload):  # noqa: PLR0912
    parsed = _parse_remote(binding, payload)
    if not parsed["remote_id"]:
        return
    mirror = models.ExternalEventMirror.objects.filter(
        binding=binding, remote_event_id=parsed["remote_id"]
    ).select_related("event").first()
    if parsed["cancelled"]:
        if mirror:
            mirror.event.delete()
        return
    if not parsed["start"] or not parsed["end"]:
        return
    if parsed["all_day"]:
        start_date = date.fromisoformat(parsed["start"][:10])
        end_date = date.fromisoformat(parsed["end"][:10])
        start_at = datetime.combine(start_date, datetime.min.time(), tzinfo=dt_timezone.utc)
        end_at = datetime.combine(end_date, datetime.min.time(), tzinfo=dt_timezone.utc)
    else:
        start_at = isoparse(parsed["start"])
        end_at = isoparse(parsed["end"])
        if start_at.tzinfo is None:
            start_at = start_at.replace(tzinfo=dt_timezone.utc)
        if end_at.tzinfo is None:
            end_at = end_at.replace(tzinfo=dt_timezone.utc)
        start_date = end_date = None
    defaults = {
        "organization": binding.account.organization,
        "organizer": binding.account.owner,
        "source_calendar": binding.calendar,
        "title": parsed["title"],
        "description": parsed["description"],
        "location": parsed["location"],
        "start_at": start_at,
        "end_at": end_at,
        "start_date": start_date,
        "end_date": end_date,
        "all_day": parsed["all_day"],
        "timezone": str(binding.account.owner.timezone or settings.TIME_ZONE),
        "visibility": "private" if parsed["private"] else "default",
        "sync_status": "synced",
    }
    with transaction.atomic():
        if mirror:
            for key, value in defaults.items():
                setattr(mirror.event, key, value)
            mirror.event.save()
            event = mirror.event
        else:
            event = models.CalendarEvent.objects.create(**defaults)
            mirror = models.ExternalEventMirror.objects.create(
                binding=binding, event=event, remote_event_id=parsed["remote_id"]
            )
        mirror.remote_revision = parsed["revision"]
        mirror.remote_updated_at = parsed["updated"]
        mirror.remote_payload = payload
        mirror.conflict_payload = {}
        mirror.save()
        event.attendees.all().delete()
        models.EventAttendee.objects.create(
            event=event,
            user=binding.account.owner,
            role=models.EventAttendeeRoleChoices.ORGANIZER,
            rsvp=models.EventRSVPChoices.ACCEPTED,
        )
        for remote_attendee in parsed["attendees"]:
            email = str(remote_attendee.get("email") or remote_attendee.get("address") or "").strip()
            if (
                not email
                or email.casefold() == binding.account.email.casefold()
                or email.casefold() == binding.account.owner.email.casefold()
            ):
                continue
            user = models.User.objects.filter(email__iexact=email, is_active=True).first()
            if user and user.pk == binding.account.owner_id:
                continue
            models.EventAttendee.objects.create(
                event=event,
                user=user,
                email="" if user else email,
                role=models.EventAttendeeRoleChoices.REQUIRED,
            )


def sync_binding(binding_id):
    binding = models.ExternalCalendarBinding.objects.select_related(
        "account", "calendar", "account__owner", "account__organization"
    ).get(pk=binding_id)
    binding.sync_status = "syncing"
    binding.save(update_fields=["sync_status", "updated_at"])
    try:
        changes, cursor = provider(binding.account.provider).changes(binding)
        for payload in changes:
            _apply_remote(binding, payload)
        binding.sync_cursor = cursor
        binding.sync_status = "synced"
        binding.error_code = ""
        binding.last_synced_at = timezone.now()
        binding.save()
    except Exception as exc:
        binding.sync_status = "error"
        binding.error_code = type(exc).__name__[:64]
        binding.save(update_fields=["sync_status", "error_code", "updated_at"])
        raise


def event_payload(event, provider_name):
    if provider_name == models.ExternalCalendarProviderChoices.GOOGLE:
        if event.all_day:
            start, end = {"date": event.start_date.isoformat()}, {"date": event.end_date.isoformat()}
        else:
            start, end = {"dateTime": event.start_at.isoformat()}, {"dateTime": event.end_at.isoformat()}
        return {
            "summary": event.title,
            "description": event.description,
            "location": event.location,
            "start": start,
            "end": end,
            "visibility": "private" if event.visibility == "private" else "default",
            "attendees": [{"email": row.user.email if row.user_id else row.email} for row in event.attendees.all() if row.role != "organizer"],
        }
    return {
        "subject": event.title,
        "body": {"contentType": "text", "content": event.description},
        "location": {"displayName": event.location},
        "start": {"dateTime": event.start_at.astimezone(dt_timezone.utc).replace(tzinfo=None).isoformat(), "timeZone": "UTC"},
        "end": {"dateTime": event.end_at.astimezone(dt_timezone.utc).replace(tzinfo=None).isoformat(), "timeZone": "UTC"},
        "isAllDay": event.all_day,
        "sensitivity": "private" if event.visibility == "private" else "normal",
        "attendees": [{"emailAddress": {"address": row.user.email if row.user_id else row.email}, "type": "required"} for row in event.attendees.all() if row.role != "organizer"],
    }


def queue_local_change(event, operation):
    if not event.source_calendar_id or event.source_calendar.kind != models.CalendarKindChoices.EXTERNAL:
        return None
    binding = event.source_calendar.external_binding
    mirror = getattr(event, "external_mirror", None)
    entry = models.CalendarSyncOutbox.objects.create(
        binding=binding,
        event=event,
        operation=operation,
        payload={} if operation == "delete" else event_payload(event, binding.account.provider),
        expected_revision=mirror.remote_revision if mirror else "",
    )
    event.sync_status = "pending"
    event.save(update_fields=["sync_status", "updated_at"])
    return entry


def flush_outbox(entry_id):
    entry = models.CalendarSyncOutbox.objects.select_related(
        "binding", "binding__account", "event", "event__source_calendar"
    ).get(pk=entry_id)
    if entry.status not in ("pending", "failed"):
        return
    entry.status = "running"
    entry.attempts += 1
    entry.save(update_fields=["status", "attempts", "updated_at"])
    try:
        result = provider(entry.binding.account.provider).write_event(entry)
        if entry.operation == "create" and entry.event:
            remote_id = result.get("id")
            if not remote_id:
                raise ProviderError("provider create response has no event id")
            revision = result.get("etag") or result.get("changeKey") or result.get("@odata.etag") or ""
            models.ExternalEventMirror.objects.update_or_create(
                binding=entry.binding,
                event=entry.event,
                defaults={"remote_event_id": remote_id, "remote_revision": revision, "remote_payload": result},
            )
        if entry.operation == "delete" and entry.event:
            event = entry.event
            entry.status = "succeeded"
            entry.event = None
            entry.save(update_fields=["status", "event", "updated_at"])
            event.delete()
            return
        if entry.event:
            entry.event.sync_status = "synced"
            entry.event.save(update_fields=["sync_status", "updated_at"])
        entry.status = "succeeded"
        entry.save(update_fields=["status", "updated_at"])
    except ProviderConflict:
        if entry.event:
            entry.event.sync_status = "conflict"
            entry.event.save(update_fields=["sync_status", "updated_at"])
            mirror = getattr(entry.event, "external_mirror", None)
            if mirror:
                mirror.conflict_payload = entry.payload
                mirror.save(update_fields=["conflict_payload", "updated_at"])
        entry.status = "conflict"
        entry.save(update_fields=["status", "updated_at"])
        sync_binding(str(entry.binding_id))
    except Exception as exc:
        entry.status = "failed"
        entry.last_error = str(exc)[:2000]
        entry.next_attempt_at = timezone.now() + timedelta(minutes=min(60, 2 ** min(entry.attempts, 6)))
        entry.save()
        raise
