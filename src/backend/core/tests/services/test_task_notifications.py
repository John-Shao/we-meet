"""Task-assignment delivery ledger, card and retry coverage."""

import json
from datetime import date, datetime, timedelta
from datetime import timezone as dt_timezone
from unittest import mock

from django.utils import timezone

import pytest

from core import models
from core.factories import RoomFactory, UserFactory
from core.services import im_bots
from core.services.jusi_im import JusiImBadResponseError, JusiImUnreachableError
from core.services.task_notifications import (
    enqueue_due_task_assignments,
    record_due_task_reminders,
    record_task_assignment,
    record_task_comment,
    record_task_date_change,
    record_task_status_change,
)
from core.tasks.task_notifications import deliver_task_assignment

pytestmark = pytest.mark.django_db


def _delivery(*, event=models.TaskImDelivery.Event.ASSIGNED, source=False):
    creator = UserFactory(full_name="创建人")
    recipient = UserFactory(full_name="负责人")
    source_item = None
    if source:
        room = RoomFactory(name="项目例会")
        summary = models.Summary.objects.create(
            room=room,
            content="summary",
            status=models.Summary.Status.SUCCESS,
        )
        source_item = models.ActionItem.objects.create(
            room=room,
            summary=summary,
            content="跟进合同",
        )
    task = models.Task.objects.create(
        title="跟进合同",
        description="与法务确认最终版本",
        creator=creator,
        assignee=recipient,
        start_date="2026-08-20",
        due_date="2026-08-25",
        source_action_item=source_item,
    )
    delivery = models.TaskImDelivery.objects.create(
        task=task,
        recipient=recipient,
        event=event,
        next_attempt_at=timezone.now(),
    )
    return delivery


def test_successful_delivery_uses_task_assistant_rich_card_once(settings):
    settings.JUSI_IM_CONFIGURATION = {
        "api_url": "https://im.example.test",
        "admin_hmac_secret": "s" * 32,
        "request_timeout_seconds": 5,
    }
    settings.APPLICATION_BASE_URL = "https://meet.example.test"
    delivery = _delivery(source=True)
    assistant = mock.Mock(name="task-assistant")

    with (
        mock.patch(
            "core.services.task_notifications.im_bots.get_builtin",
            return_value=assistant,
        ) as get_builtin,
        mock.patch(
            "core.services.task_notifications.im_bots.post_direct",
            return_value=("direct-cid", mock.Mock()),
        ) as post_direct,
    ):
        assert deliver_task_assignment(str(delivery.id)) == "delivered"
        assert deliver_task_assignment(str(delivery.id)) is None

    delivery.refresh_from_db()
    assert delivery.status == models.TaskImDelivery.Status.DELIVERED
    assert delivery.attempt_count == 1
    assert delivery.conversation_id == "direct-cid"
    assert delivery.delivered_at is not None
    get_builtin.assert_called_once_with(im_bots.BOT_TASK_ASSISTANT)
    assert post_direct.call_count == 1
    assert post_direct.call_args.args[1] is assistant
    assert post_direct.call_args.kwargs["content_type"] == "rich-card"
    card = json.loads(post_direct.call_args.args[3])
    assert card["header"] == {"title": "你收到一个新任务", "theme": "info"}
    assert card["plain"] == "你收到一个新任务：跟进合同"
    assert {item["label"]: item["value"] for item in card["blocks"][2]["items"]} == {
        "创建人": "创建人",
        "开始日期": "2026-08-20",
        "截止日期": "2026-08-25",
        "来源会议": "项目例会",
    }
    assert card["blocks"][-1]["buttons"][0] == {
        "id": "open-task-center",
        "text": "查看任务",
        "style": "primary",
        "action": "url",
        "url": "https://meet.example.test/tasks",
    }


def test_successful_comment_delivery_uses_task_assistant_comment_card(settings):
    settings.JUSI_IM_CONFIGURATION = {
        "api_url": "https://im.example.test",
        "admin_hmac_secret": "s" * 32,
    }
    settings.APPLICATION_BASE_URL = "https://meet.example.test"
    creator = UserFactory(full_name="创建人")
    recipient = UserFactory(full_name="负责人")
    task = models.Task.objects.create(
        title="复核发布清单",
        creator=creator,
        assignee=recipient,
    )
    comment = models.TaskComment.objects.create(
        task=task,
        author=creator,
        content="请重点确认回滚步骤。",
    )
    delivery = models.TaskImDelivery.objects.create(
        task=task,
        comment=comment,
        recipient=recipient,
        event=models.TaskImDelivery.Event.COMMENTED,
        next_attempt_at=timezone.now(),
    )

    with (
        mock.patch(
            "core.services.task_notifications.im_bots.get_builtin",
            return_value=mock.Mock(),
        ),
        mock.patch(
            "core.services.task_notifications.im_bots.post_direct",
            return_value=("direct-cid", mock.Mock()),
        ) as post_direct,
    ):
        assert deliver_task_assignment(str(delivery.id)) == "delivered"

    card = json.loads(post_direct.call_args.args[3])
    assert card["header"] == {"title": "任务有新评论", "theme": "info"}
    assert card["plain"] == "创建人 评论了任务：复核发布清单"
    assert card["blocks"][0]["spans"][0]["text"] == "复核发布清单"
    assert card["blocks"][1]["spans"][0]["text"] == "请重点确认回滚步骤。"
    assert card["blocks"][2]["items"] == [{"label": "评论人", "value": "创建人"}]
    assert card["blocks"][-1]["buttons"][0] == {
        "id": "open-task-comment",
        "text": "查看评论",
        "style": "primary",
        "action": "url",
        "url": "https://meet.example.test/tasks",
    }


def test_transient_failure_stays_pending_and_schedules_backoff(settings):
    settings.JUSI_IM_CONFIGURATION = {
        "api_url": "https://im.example.test",
        "admin_hmac_secret": "s" * 32,
    }
    delivery = _delivery()

    with (
        mock.patch(
            "core.services.task_notifications.im_bots.get_builtin",
            return_value=mock.Mock(),
        ),
        mock.patch(
            "core.services.task_notifications.im_bots.post_direct",
            side_effect=JusiImUnreachableError("temporary DNS failure"),
        ),
        mock.patch.object(deliver_task_assignment, "apply_async") as retry,
    ):
        assert deliver_task_assignment(str(delivery.id)) == "retrying"

    delivery.refresh_from_db()
    assert delivery.status == models.TaskImDelivery.Status.PENDING
    assert delivery.attempt_count == 1
    assert delivery.next_attempt_at is not None
    assert delivery.last_error == "temporary DNS failure"
    retry.assert_called_once_with(args=[str(delivery.id)], countdown=15)


def test_permanent_im_response_marks_delivery_failed(settings):
    settings.JUSI_IM_CONFIGURATION = {
        "api_url": "https://im.example.test",
        "admin_hmac_secret": "s" * 32,
    }
    delivery = _delivery()

    with (
        mock.patch(
            "core.services.task_notifications.im_bots.get_builtin",
            return_value=mock.Mock(),
        ),
        mock.patch(
            "core.services.task_notifications.im_bots.post_direct",
            side_effect=JusiImBadResponseError("invalid recipient"),
        ),
    ):
        assert deliver_task_assignment(str(delivery.id)) == "failed"

    delivery.refresh_from_db()
    assert delivery.status == models.TaskImDelivery.Status.FAILED
    assert delivery.next_attempt_at is None
    assert delivery.last_error == "invalid recipient"


def test_reassignment_supersedes_pending_old_recipient(
    django_capture_on_commit_callbacks,
):
    creator = UserFactory()
    previous = UserFactory()
    next_recipient = UserFactory()
    task = models.Task.objects.create(
        title="handoff",
        creator=creator,
        assignee=previous,
    )
    old = models.TaskImDelivery.objects.create(
        task=task,
        recipient=previous,
        event=models.TaskImDelivery.Event.ASSIGNED,
        next_attempt_at=timezone.now(),
    )
    task.assignee = next_recipient
    task.save(update_fields=["assignee", "updated_at"])

    with (
        mock.patch("core.services.task_notifications._enqueue_delivery") as enqueue,
        django_capture_on_commit_callbacks(execute=True),
    ):
        new = record_task_assignment(
            task=task,
            event=models.TaskImDelivery.Event.REASSIGNED,
        )

    old.refresh_from_db()
    assert old.status == models.TaskImDelivery.Status.SUPERSEDED
    assert old.next_attempt_at is None
    assert new is not None
    assert new.recipient == next_recipient
    enqueue.assert_called_once_with(new.id)


def test_reassignment_supersedes_pending_comment_for_previous_assignee():
    creator = UserFactory()
    previous = UserFactory()
    next_recipient = UserFactory()
    task = models.Task.objects.create(
        title="handoff",
        creator=creator,
        assignee=previous,
    )
    comment = models.TaskComment.objects.create(
        task=task,
        author=creator,
        content="Before handoff",
    )
    pending_comment = models.TaskImDelivery.objects.create(
        task=task,
        comment=comment,
        recipient=previous,
        event=models.TaskImDelivery.Event.COMMENTED,
        next_attempt_at=timezone.now(),
    )
    task.assignee = next_recipient
    task.save(update_fields=["assignee", "updated_at"])

    with mock.patch("core.services.task_notifications._enqueue_delivery"):
        record_task_assignment(
            task=task,
            event=models.TaskImDelivery.Event.REASSIGNED,
        )

    pending_comment.refresh_from_db()
    assert pending_comment.status == models.TaskImDelivery.Status.SUPERSEDED
    assert pending_comment.next_attempt_at is None


def test_record_task_comment_notifies_only_the_other_collaborator(
    django_capture_on_commit_callbacks,
):
    creator = UserFactory()
    assignee = UserFactory()
    task = models.Task.objects.create(
        title="collaborate",
        creator=creator,
        assignee=assignee,
    )
    comment = models.TaskComment.objects.create(
        task=task,
        author=assignee,
        content="Ready for review",
    )

    with (
        mock.patch("core.services.task_notifications._enqueue_delivery") as enqueue,
        django_capture_on_commit_callbacks(execute=True),
    ):
        delivery = record_task_comment(comment=comment)
        duplicate = record_task_comment(comment=comment)

    assert delivery is not None
    assert duplicate == delivery
    assert delivery.recipient == creator
    assert delivery.comment == comment
    assert delivery.event == models.TaskImDelivery.Event.COMMENTED
    assert models.TaskImDelivery.objects.filter(comment=comment).count() == 1
    enqueue.assert_called_once_with(delivery.id)


def test_recovery_scan_enqueues_only_due_pending_rows():
    due = _delivery()
    future = _delivery()
    delivered = _delivery()
    models.TaskImDelivery.objects.filter(pk=future.pk).update(
        next_attempt_at=timezone.now() + timedelta(minutes=5)
    )
    models.TaskImDelivery.objects.filter(pk=delivered.pk).update(
        status=models.TaskImDelivery.Status.DELIVERED,
        next_attempt_at=None,
    )

    with mock.patch(
        "core.services.task_notifications._enqueue_delivery", return_value=True
    ) as enqueue:
        assert enqueue_due_task_assignments() == 1

    enqueue.assert_called_once_with(due.id)


def test_task_date_reminders_respect_assignee_timezone_and_are_idempotent(
    django_capture_on_commit_callbacks,
):
    creator = UserFactory()
    shanghai = UserFactory(timezone="Asia/Shanghai")
    utc_user = UserFactory(timezone="UTC")
    now = datetime(2026, 8, 21, 16, 30, tzinfo=dt_timezone.utc)

    starting = models.Task.objects.create(
        title="Shanghai starting",
        creator=creator,
        assignee=shanghai,
        start_date=date(2026, 8, 22),
    )
    due = models.Task.objects.create(
        title="Shanghai due",
        creator=creator,
        assignee=shanghai,
        due_date=date(2026, 8, 22),
    )
    overdue = models.Task.objects.create(
        title="Shanghai overdue",
        creator=creator,
        assignee=shanghai,
        due_date=date(2026, 8, 21),
    )
    one_day = models.Task.objects.create(
        title="One day",
        creator=creator,
        assignee=shanghai,
        start_date=date(2026, 8, 22),
        due_date=date(2026, 8, 22),
    )
    utc_starting = models.Task.objects.create(
        title="UTC starting",
        creator=creator,
        assignee=utc_user,
        start_date=date(2026, 8, 21),
    )
    models.Task.objects.create(
        title="Completed",
        creator=creator,
        assignee=shanghai,
        due_date=date(2026, 8, 21),
        status=models.Task.Status.COMPLETED,
    )

    with (
        mock.patch("core.services.task_notifications._enqueue_delivery") as enqueue,
        django_capture_on_commit_callbacks(execute=True),
    ):
        assert record_due_task_reminders(now=now) == 5
        assert record_due_task_reminders(now=now) == 0

    assert set(
        models.TaskImDelivery.objects.values_list("task_id", "event", "reference_date")
    ) == {
        (starting.id, models.TaskImDelivery.Event.STARTING, date(2026, 8, 22)),
        (due.id, models.TaskImDelivery.Event.DUE_TODAY, date(2026, 8, 22)),
        (overdue.id, models.TaskImDelivery.Event.OVERDUE, date(2026, 8, 21)),
        (one_day.id, models.TaskImDelivery.Event.DUE_TODAY, date(2026, 8, 22)),
        (
            utc_starting.id,
            models.TaskImDelivery.Event.STARTING,
            date(2026, 8, 21),
        ),
    }
    assert enqueue.call_count == 5


def test_due_today_delivery_uses_task_assistant_reminder_card(settings):
    settings.JUSI_IM_CONFIGURATION = {
        "api_url": "https://im.example.test",
        "admin_hmac_secret": "s" * 32,
    }
    settings.APPLICATION_BASE_URL = "https://meet.example.test"
    creator = UserFactory(full_name="创建人")
    recipient = UserFactory(full_name="负责人", timezone="Asia/Shanghai")
    task = models.Task.objects.create(
        title="提交发布材料",
        creator=creator,
        assignee=recipient,
        start_date=date(2026, 8, 20),
        due_date=date(2026, 8, 22),
    )
    delivery = models.TaskImDelivery.objects.create(
        task=task,
        recipient=recipient,
        event=models.TaskImDelivery.Event.DUE_TODAY,
        reference_date=date(2026, 8, 22),
        next_attempt_at=timezone.now(),
    )

    with (
        mock.patch(
            "core.services.task_notifications.local_date_for_user",
            return_value=date(2026, 8, 22),
        ),
        mock.patch(
            "core.services.task_notifications.im_bots.get_builtin",
            return_value=mock.Mock(),
        ),
        mock.patch(
            "core.services.task_notifications.im_bots.post_direct",
            return_value=("direct-cid", mock.Mock()),
        ) as post_direct,
    ):
        assert deliver_task_assignment(str(delivery.id)) == "delivered"

    card = json.loads(post_direct.call_args.args[3])
    assert card["header"] == {"title": "任务今天截止", "theme": "warning"}
    assert card["plain"] == "任务今天截止：提交发布材料"
    assert card["blocks"][-1]["buttons"][0]["url"] == (
        "https://meet.example.test/tasks"
    )


def test_completed_task_supersedes_pending_time_reminder():
    creator = UserFactory()
    recipient = UserFactory(timezone="UTC")
    task = models.Task.objects.create(
        title="Already done",
        creator=creator,
        assignee=recipient,
        due_date=date(2026, 8, 21),
        status=models.Task.Status.COMPLETED,
    )
    delivery = models.TaskImDelivery.objects.create(
        task=task,
        recipient=recipient,
        event=models.TaskImDelivery.Event.DUE_TODAY,
        reference_date=date(2026, 8, 21),
        next_attempt_at=timezone.now(),
    )

    assert deliver_task_assignment(str(delivery.id)) is None
    delivery.refresh_from_db()
    assert delivery.status == models.TaskImDelivery.Status.SUPERSEDED


def test_record_task_date_change_notifies_assignee_once(
    django_capture_on_commit_callbacks,
):
    creator = UserFactory()
    assignee = UserFactory()
    task = models.Task.objects.create(
        title="Reschedule launch",
        creator=creator,
        assignee=assignee,
        start_date=date(2026, 8, 22),
        due_date=date(2026, 8, 30),
    )
    activity = models.TaskActivity.objects.create(
        task=task,
        actor=creator,
        event=models.TaskActivity.Event.DATES_CHANGED,
        changes={
            "dates": {
                "start_date": {"from": "2026-08-20", "to": "2026-08-22"},
                "due_date": {"from": "2026-08-25", "to": "2026-08-30"},
            }
        },
    )

    with (
        mock.patch("core.services.task_notifications._enqueue_delivery") as enqueue,
        django_capture_on_commit_callbacks(execute=True),
    ):
        delivery = record_task_date_change(activity=activity)
        duplicate = record_task_date_change(activity=activity)

    assert delivery is not None
    assert duplicate == delivery
    assert delivery.recipient == assignee
    assert delivery.activity == activity
    assert delivery.event == models.TaskImDelivery.Event.DATES_CHANGED
    assert delivery.status == models.TaskImDelivery.Status.PENDING
    assert models.TaskImDelivery.objects.filter(activity=activity).count() == 1
    enqueue.assert_called_once_with(delivery.id)


def test_date_change_card_preserves_old_and_new_dates(settings):
    settings.JUSI_IM_CONFIGURATION = {
        "api_url": "https://im.example.test",
        "admin_hmac_secret": "s" * 32,
    }
    settings.APPLICATION_BASE_URL = "https://meet.example.test"
    creator = UserFactory(full_name="创建人")
    assignee = UserFactory(full_name="负责人")
    task = models.Task.objects.create(
        title="调整发布日期",
        creator=creator,
        assignee=assignee,
        start_date=date(2026, 8, 23),
        due_date=date(2026, 8, 31),
    )
    activity = models.TaskActivity.objects.create(
        task=task,
        actor=creator,
        event=models.TaskActivity.Event.DATES_CHANGED,
        changes={
            "dates": {
                "start_date": {"from": None, "to": "2026-08-23"},
                "due_date": {"from": "2026-08-28", "to": "2026-08-31"},
            }
        },
    )
    delivery = models.TaskImDelivery.objects.create(
        task=task,
        activity=activity,
        recipient=assignee,
        event=models.TaskImDelivery.Event.DATES_CHANGED,
        next_attempt_at=timezone.now(),
    )

    with (
        mock.patch(
            "core.services.task_notifications.im_bots.get_builtin",
            return_value=mock.Mock(),
        ),
        mock.patch(
            "core.services.task_notifications.im_bots.post_direct",
            return_value=("direct-cid", mock.Mock()),
        ) as post_direct,
    ):
        assert deliver_task_assignment(str(delivery.id)) == "delivered"

    card = json.loads(post_direct.call_args.args[3])
    assert card["header"] == {"title": "任务日期已调整", "theme": "warning"}
    assert card["plain"] == "任务日期已调整：调整发布日期"
    assert card["blocks"][1:4] == [
        {
            "type": "fields",
            "items": [{"label": "开始日期", "value": "未设置 → 2026-08-23"}],
        },
        {
            "type": "fields",
            "items": [{"label": "截止日期", "value": "2026-08-28 → 2026-08-31"}],
        },
        {
            "type": "fields",
            "items": [{"label": "修改人", "value": "创建人"}],
        },
    ]
    assert card["blocks"][-1]["buttons"][0]["url"] == (
        "https://meet.example.test/tasks"
    )


def test_latest_date_change_supersedes_stale_change_and_reminders(
    django_capture_on_commit_callbacks,
):
    creator = UserFactory()
    assignee = UserFactory()
    task = models.Task.objects.create(
        title="Move again",
        creator=creator,
        assignee=assignee,
        start_date=date(2026, 9, 2),
        due_date=date(2026, 9, 2),
    )
    previous_activity = models.TaskActivity.objects.create(
        task=task,
        actor=creator,
        event=models.TaskActivity.Event.DATES_CHANGED,
        changes={"dates": {"due_date": {"from": "2026-08-30", "to": "2026-09-01"}}},
    )
    previous_change = models.TaskImDelivery.objects.create(
        task=task,
        activity=previous_activity,
        recipient=assignee,
        event=models.TaskImDelivery.Event.DATES_CHANGED,
        next_attempt_at=timezone.now(),
    )
    stale_starting = models.TaskImDelivery.objects.create(
        task=task,
        recipient=assignee,
        event=models.TaskImDelivery.Event.STARTING,
        reference_date=date(2026, 9, 2),
        next_attempt_at=timezone.now(),
    )
    stale_due = models.TaskImDelivery.objects.create(
        task=task,
        recipient=assignee,
        event=models.TaskImDelivery.Event.DUE_TODAY,
        reference_date=date(2026, 9, 1),
        next_attempt_at=timezone.now(),
    )
    latest_activity = models.TaskActivity.objects.create(
        task=task,
        actor=creator,
        event=models.TaskActivity.Event.DATES_CHANGED,
        changes={
            "dates": {
                "start_date": {"from": "2026-09-01", "to": "2026-09-02"},
                "due_date": {"from": "2026-09-01", "to": "2026-09-02"},
            }
        },
    )

    with (
        mock.patch("core.services.task_notifications._enqueue_delivery"),
        django_capture_on_commit_callbacks(execute=True),
    ):
        latest = record_task_date_change(activity=latest_activity)

    assert latest is not None
    for stale in (previous_change, stale_starting, stale_due):
        stale.refresh_from_db()
        assert stale.status == models.TaskImDelivery.Status.SUPERSEDED
        assert stale.next_attempt_at is None


@pytest.mark.parametrize("closed_status", [None, models.Task.Status.COMPLETED])
def test_date_change_does_not_notify_self_or_closed_task(closed_status):
    creator = UserFactory()
    assignee = creator if closed_status is None else UserFactory()
    task = models.Task.objects.create(
        title="Silent change",
        creator=creator,
        assignee=assignee,
        due_date=date(2026, 9, 1),
        status=closed_status or models.Task.Status.TODO,
    )
    activity = models.TaskActivity.objects.create(
        task=task,
        actor=creator,
        event=models.TaskActivity.Event.DATES_CHANGED,
        changes={"dates": {"due_date": {"from": "2026-08-31", "to": "2026-09-01"}}},
    )

    assert record_task_date_change(activity=activity) is None
    assert not models.TaskImDelivery.objects.filter(activity=activity).exists()


def test_record_task_status_change_notifies_other_collaborator_once(
    django_capture_on_commit_callbacks,
):
    creator = UserFactory()
    assignee = UserFactory()
    task = models.Task.objects.create(
        title="Complete review",
        creator=creator,
        assignee=assignee,
        status=models.Task.Status.COMPLETED,
    )
    activity = models.TaskActivity.objects.create(
        task=task,
        actor=assignee,
        event=models.TaskActivity.Event.STATUS_CHANGED,
        changes={
            "status": {
                "from": models.Task.Status.IN_PROGRESS,
                "to": models.Task.Status.COMPLETED,
            }
        },
    )

    with (
        mock.patch("core.services.task_notifications._enqueue_delivery") as enqueue,
        django_capture_on_commit_callbacks(execute=True),
    ):
        deliveries = record_task_status_change(activity=activity)
        duplicates = record_task_status_change(activity=activity)

    assert len(deliveries) == 1
    assert duplicates == deliveries
    delivery = deliveries[0]
    assert delivery.recipient == creator
    assert delivery.activity == activity
    assert delivery.event == models.TaskImDelivery.Event.STATUS_CHANGED
    assert models.TaskImDelivery.objects.filter(activity=activity).count() == 1
    enqueue.assert_called_once_with(delivery.id)


def test_status_change_by_parent_collaborator_notifies_both_task_owners(
    django_capture_on_commit_callbacks,
):
    creator = UserFactory()
    assignee = UserFactory()
    parent_collaborator = UserFactory()
    task = models.Task.objects.create(
        title="Child progress",
        creator=creator,
        assignee=assignee,
        status=models.Task.Status.IN_PROGRESS,
    )
    activity = models.TaskActivity.objects.create(
        task=task,
        actor=parent_collaborator,
        event=models.TaskActivity.Event.STATUS_CHANGED,
        changes={
            "status": {
                "from": models.Task.Status.TODO,
                "to": models.Task.Status.IN_PROGRESS,
            }
        },
    )

    with (
        mock.patch("core.services.task_notifications._enqueue_delivery") as enqueue,
        django_capture_on_commit_callbacks(execute=True),
    ):
        deliveries = record_task_status_change(activity=activity)

    assert {delivery.recipient_id for delivery in deliveries} == {
        creator.id,
        assignee.id,
    }
    assert enqueue.call_count == 2


def test_status_change_card_preserves_transition_and_actor(settings):
    settings.JUSI_IM_CONFIGURATION = {
        "api_url": "https://im.example.test",
        "admin_hmac_secret": "s" * 32,
    }
    settings.APPLICATION_BASE_URL = "https://meet.example.test"
    creator = UserFactory(full_name="创建人")
    assignee = UserFactory(full_name="负责人")
    task = models.Task.objects.create(
        title="完成发布复核",
        creator=creator,
        assignee=assignee,
        status=models.Task.Status.COMPLETED,
    )
    activity = models.TaskActivity.objects.create(
        task=task,
        actor=assignee,
        event=models.TaskActivity.Event.STATUS_CHANGED,
        changes={
            "status": {
                "from": models.Task.Status.IN_PROGRESS,
                "to": models.Task.Status.COMPLETED,
            }
        },
    )
    delivery = models.TaskImDelivery.objects.create(
        task=task,
        activity=activity,
        recipient=creator,
        event=models.TaskImDelivery.Event.STATUS_CHANGED,
        next_attempt_at=timezone.now(),
    )

    with (
        mock.patch(
            "core.services.task_notifications.im_bots.get_builtin",
            return_value=mock.Mock(),
        ),
        mock.patch(
            "core.services.task_notifications.im_bots.post_direct",
            return_value=("direct-cid", mock.Mock()),
        ) as post_direct,
    ):
        assert deliver_task_assignment(str(delivery.id)) == "delivered"

    card = json.loads(post_direct.call_args.args[3])
    assert card["header"] == {"title": "任务已完成", "theme": "success"}
    assert card["plain"] == "任务已完成：完成发布复核"
    assert card["blocks"][1]["items"] == [
        {"label": "状态", "value": "进行中 → 已完成"},
        {"label": "操作人", "value": "负责人"},
    ]
    assert card["blocks"][-1]["buttons"][0] == {
        "id": "open-task-status-change",
        "text": "查看任务",
        "style": "primary",
        "action": "url",
        "url": "https://meet.example.test/tasks",
    }


def test_latest_status_change_supersedes_stale_change_and_closed_reminders(
    django_capture_on_commit_callbacks,
):
    creator = UserFactory()
    assignee = UserFactory()
    task = models.Task.objects.create(
        title="Close task",
        creator=creator,
        assignee=assignee,
        due_date=date(2026, 8, 22),
        status=models.Task.Status.COMPLETED,
    )
    stale_activity = models.TaskActivity.objects.create(
        task=task,
        actor=assignee,
        event=models.TaskActivity.Event.STATUS_CHANGED,
        changes={
            "status": {
                "from": models.Task.Status.TODO,
                "to": models.Task.Status.IN_PROGRESS,
            }
        },
    )
    stale_status = models.TaskImDelivery.objects.create(
        task=task,
        activity=stale_activity,
        recipient=creator,
        event=models.TaskImDelivery.Event.STATUS_CHANGED,
        next_attempt_at=timezone.now(),
    )
    date_activity = models.TaskActivity.objects.create(
        task=task,
        actor=creator,
        event=models.TaskActivity.Event.DATES_CHANGED,
        changes={"dates": {"due_date": {"from": "2026-08-21", "to": "2026-08-22"}}},
    )
    pending_date_change = models.TaskImDelivery.objects.create(
        task=task,
        activity=date_activity,
        recipient=assignee,
        event=models.TaskImDelivery.Event.DATES_CHANGED,
        next_attempt_at=timezone.now(),
    )
    pending_reminder = models.TaskImDelivery.objects.create(
        task=task,
        recipient=assignee,
        event=models.TaskImDelivery.Event.DUE_TODAY,
        reference_date=date(2026, 8, 22),
        next_attempt_at=timezone.now(),
    )
    latest_activity = models.TaskActivity.objects.create(
        task=task,
        actor=assignee,
        event=models.TaskActivity.Event.STATUS_CHANGED,
        changes={
            "status": {
                "from": models.Task.Status.IN_PROGRESS,
                "to": models.Task.Status.COMPLETED,
            }
        },
    )

    with (
        mock.patch("core.services.task_notifications._enqueue_delivery"),
        django_capture_on_commit_callbacks(execute=True),
    ):
        deliveries = record_task_status_change(activity=latest_activity)

    assert len(deliveries) == 1
    for stale in (stale_status, pending_date_change, pending_reminder):
        stale.refresh_from_db()
        assert stale.status == models.TaskImDelivery.Status.SUPERSEDED
        assert stale.next_attempt_at is None


def test_stale_status_change_is_superseded_before_delivery():
    creator = UserFactory()
    assignee = UserFactory()
    task = models.Task.objects.create(
        title="Already reopened",
        creator=creator,
        assignee=assignee,
        status=models.Task.Status.TODO,
    )
    activity = models.TaskActivity.objects.create(
        task=task,
        actor=assignee,
        event=models.TaskActivity.Event.STATUS_CHANGED,
        changes={
            "status": {
                "from": models.Task.Status.IN_PROGRESS,
                "to": models.Task.Status.COMPLETED,
            }
        },
    )
    delivery = models.TaskImDelivery.objects.create(
        task=task,
        activity=activity,
        recipient=creator,
        event=models.TaskImDelivery.Event.STATUS_CHANGED,
        next_attempt_at=timezone.now(),
    )

    assert deliver_task_assignment(str(delivery.id)) is None
    delivery.refresh_from_db()
    assert delivery.status == models.TaskImDelivery.Status.SUPERSEDED
