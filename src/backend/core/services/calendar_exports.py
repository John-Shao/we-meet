"""Static calendar report generation (native Docs table plus UTF-8 CSV)."""

from __future__ import annotations

import csv
import html
import io
import secrets
from datetime import datetime, time, timedelta
from datetime import timezone as dt_timezone

from django.conf import settings
from django.core.files.base import ContentFile
from django.db.models import Q
from django.utils import timezone
from django.utils.html import strip_tags

from core import models
from core.services import (
    calendar_access,
    calendar_im_notify,
    calendar_time,
    external_calendars,
    im_cards,
)
from core.services.docs_client import DocsClient

MAX_EXPORT_ROWS = 10_000
CSV_TTL = timedelta(days=90)

COLUMNS = [
    "日历名称",
    "日程主题",
    "日程开始时间",
    "日程结束时间",
    "是否重复性日程",
    "组织者",
    "参与者",
    "会议室",
    "地点",
    "是否需要签到",
    "签到时间",
    "描述",
    "附件（仅显示文件名称）",
]


class ExportTooLarge(Exception):
    pass


def _plain(value) -> str:
    return html.unescape(strip_tags(str(value or ""))).strip()


def _safe_cell(value) -> str:
    value = _plain(value)
    if value.startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def _display_time(event, field: str, zone) -> str:
    if event.all_day:
        value = event.start_date if field == "start" else event.end_date
        return value.isoformat() if value else ""
    value = event.start_at if field == "start" else event.end_at
    return value.astimezone(zone).strftime("%Y/%m/%d %H:%M")


def _event_rows(job):
    zone = calendar_time.parse_zone(str(job.timezone))
    range_start_at = timezone.make_aware(
        datetime.combine(job.range_start, time.min), timezone=zone
    ).astimezone(dt_timezone.utc)
    range_end_at = timezone.make_aware(
        datetime.combine(job.range_end + timedelta(days=1), time.min), timezone=zone
    ).astimezone(dt_timezone.utc)
    events = list(
        calendar_access.events_for_calendar(job.calendar)
        .filter(
            Q(all_day=False, start_at__lt=range_end_at, end_at__gt=range_start_at)
            | Q(
                all_day=True,
                start_date__lte=job.range_end,
                end_date__gt=job.range_start,
            )
        )
        .select_related("organizer", "source_calendar")
        .prefetch_related("attendees__user", "room_bookings__room")
        .order_by("start_at")[: MAX_EXPORT_ROWS + 1]
    )
    if len(events) > MAX_EXPORT_ROWS:
        raise ExportTooLarge("The export contains more than 10,000 rows.")

    rows = []
    for event in events:
        access = calendar_access.event_access_for_calendar_permission(
            event,
            job.requester,
            calendar_access.calendar_permission(job.calendar, job.requester),
        )
        redacted = access != calendar_access.EventAccess.DETAILS
        booking = next(
            (
                item
                for item in event.room_bookings.all()
                if item.status in ("confirmed", "pending")
            ),
            None,
        )
        attendees = "、".join(
            _plain(
                attendee.user.full_name
                if attendee.user_id
                else attendee.email
            )
            for attendee in event.attendees.all()
            if attendee.role != models.EventAttendeeRoleChoices.ORGANIZER
        )
        repeated = bool(event.recurrence or event.recurrence_parent_id)
        room_name = ""
        if booking is not None:
            room_name = booking.room.name or booking.room.code
        row = [
            job.calendar.display_name,
            "忙碌" if redacted else event.title,
            _display_time(event, "start", zone),
            _display_time(event, "end", zone),
            "是" if repeated else "否",
            "" if redacted else event.organizer.full_name,
            "" if redacted else attendees,
            "" if redacted else room_name,
            "" if redacted else event.location,
            "无",
            "无",
            "" if redacted else event.description,
            (
                "无"
                if redacted or not event.attachment_names
                else "、".join(str(value) for value in event.attachment_names)
            ),
        ]
        rows.append([_safe_cell(value) for value in row])
    return rows


def _csv_bytes(rows) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(COLUMNS)
    # Apply the spreadsheet-formula guard at the serialization boundary as
    # well.  Callers currently sanitize event fields while building rows, but
    # keeping this invariant here also protects future/custom export sources.
    writer.writerows([[_safe_cell(value) for value in row] for row in rows])
    return b"\xef\xbb\xbf" + output.getvalue().encode("utf-8")


def _download_url(job) -> str:
    base = str(getattr(settings, "EMAIL_APP_BASE_URL", "") or "").rstrip("/")
    return (
        f"{base}/api/{settings.API_VERSION}/calendar-exports/{job.id}/download/"
        f"?token={job.csv_token}"
    )


def run_export(job_id: str) -> None:
    job = (
        models.CalendarExportJob.objects.select_related(
            "calendar", "calendar__owner", "requester"
        )
        .filter(pk=job_id)
        .first()
    )
    if job is None or job.status != models.CalendarExportStatusChoices.QUEUED:
        return
    job.status = models.CalendarExportStatusChoices.RUNNING
    job.started_at = timezone.now()
    job.save(update_fields=["status", "started_at", "updated_at"])
    try:
        # Exports may request dates outside the rolling mirror window.  Expand
        # and refill that window in the worker before taking the immutable
        # snapshot; the HTTP request still never performs provider I/O.
        if job.calendar.kind == models.CalendarKindChoices.EXTERNAL:
            binding = job.calendar.external_binding
            if (
                binding.sync_window_start is None
                or binding.sync_window_end is None
                or job.range_start < binding.sync_window_start
                or job.range_end > binding.sync_window_end
            ):
                binding.sync_window_start = min(
                    value for value in (binding.sync_window_start, job.range_start) if value
                )
                binding.sync_window_end = max(
                    value for value in (binding.sync_window_end, job.range_end) if value
                )
                binding.sync_cursor = ""
                binding.save(
                    update_fields=[
                        "sync_window_start",
                        "sync_window_end",
                        "sync_cursor",
                        "updated_at",
                    ]
                )
                external_calendars.sync_binding(binding.id)
        rows = _event_rows(job)
        token = secrets.token_urlsafe(48)
        job.csv_token = token
        job.csv_expires_at = timezone.now() + CSV_TTL
        filename = f"calendar-{job.range_start}-{job.range_end}.csv"
        job.csv_file.save(filename, ContentFile(_csv_bytes(rows)), save=False)

        cfg = settings.DOCS_CONFIGURATION
        client = DocsClient(
            api_url=str(cfg["api_url"]),
            server_to_server_token=str(cfg["server_to_server_token"]),
            timeout_seconds=float(cfg.get("request_timeout_seconds") or 5),
        )
        title = f"{job.range_start} - {job.range_end} 的日历详情"
        created = client.create_table_for_owner(
            sub=str(job.requester.sub or ""),
            email=str(job.requester.email or ""),
            title=title,
            intro=f"静态导出快照。CSV 下载（90天有效）：{_download_url(job)}",
            columns=COLUMNS,
            rows=rows,
        )
        job.document_id = created.id
        job.row_count = len(rows)
        job.status = models.CalendarExportStatusChoices.SUCCEEDED
        job.completed_at = timezone.now()
        job.save()

        doc_base = str(cfg["api_url"]).rstrip("/")
        card = im_cards.build_doc_card(
            doc_id=created.id,
            title=title,
            url=f"{doc_base}/docs/{created.id}/",
            shared_by="日历助手",
        )
        calendar_im_notify.push_user_cards(
            [(job.requester, card)], content_type=im_cards.DOC_CARD
        )
    except Exception as exc:
        job.status = models.CalendarExportStatusChoices.FAILED
        job.error_code = type(exc).__name__[:64]
        job.error_detail = str(exc)[:2000]
        job.completed_at = timezone.now()
        job.save(
            update_fields=[
                "status",
                "error_code",
                "error_detail",
                "completed_at",
                "updated_at",
            ]
        )
        card = im_cards.build_rich_card(
            plain="日历导出失败，请稍后重试",
            header={"title": "日历导出失败", "theme": "danger"},
            blocks=[
                {
                    "type": "text",
                    "spans": [
                        {"tag": "text", "text": "未能生成导出文档，请稍后重试。"}
                    ],
                }
            ],
        )
        calendar_im_notify.push_user_cards(
            [(job.requester, card)], content_type=im_cards.RICH_CARD
        )
        raise
