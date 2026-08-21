"""Task-assignment delivery ledger, card and retry coverage."""

import json
from datetime import timedelta
from unittest import mock

from django.utils import timezone

import pytest

from core import models
from core.factories import RoomFactory, UserFactory
from core.services import im_bots
from core.services.jusi_im import JusiImBadResponseError, JusiImUnreachableError
from core.services.task_notifications import (
    enqueue_due_task_assignments,
    record_task_assignment,
    record_task_comment,
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
