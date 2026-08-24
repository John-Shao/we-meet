"""Client serializers for the Meet core app."""

# pylint: disable=abstract-method,no-name-in-module
import logging
from os.path import splitext
from typing import Literal
from urllib.parse import quote

from django.conf import settings
from django.core.exceptions import SuspiciousOperation
from django.db.models import Q
from django.utils import timezone

# pylint: disable=abstract-method,no-name-in-module
from django.utils.translation import gettext_lazy as _

from django_pydantic_field.rest_framework import SchemaField
from pydantic import BaseModel, Field, field_serializer
from pydantic import ValidationError as PydanticValidationError
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied
from timezone_field.rest_framework import TimeZoneSerializerField

from core import models, utils
from core.services.task_action_item_sync import (
    record_manual_action_item_status_change,
)
from core.services.task_time import local_date_for_user, task_time_state

logger = logging.getLogger(__name__)


class UserSerializer(serializers.ModelSerializer):
    """Serialize users."""

    timezone = TimeZoneSerializerField()
    # avatar_url / cover_url are derived: the buckets are private, so we hand
    # the client a short-lived presigned GET URL built from the stored key.
    avatar_url = serializers.SerializerMethodField()
    cover_url = serializers.SerializerMethodField()

    class Meta:
        model = models.User
        fields = [
            "id",
            "email",
            "phone",
            "full_name",
            "short_name",
            "timezone",
            "language",
            "intro",
            "avatar_url",
            "cover_url",
        ]
        # phone: self viewing self → full number, no masking (P3).
        read_only_fields = ["id", "email", "phone", "full_name", "short_name"]

    def get_avatar_url(self, instance):
        """Return a short-lived presigned GET URL for the avatar, '' if unset."""
        return utils.generate_profile_image_get_url("avatar", instance.avatar_key)

    def get_cover_url(self, instance):
        """Return a short-lived presigned GET URL for the cover, '' if unset."""
        return utils.generate_profile_image_get_url("cover", instance.cover_key)


class UserLightSerializer(serializers.ModelSerializer):
    """Serialize users with limited fields."""

    class Meta:
        model = models.User
        fields = ["id", "full_name", "short_name"]
        read_only_fields = ["id", "full_name", "short_name"]


class TaskUserSerializer(UserLightSerializer):
    """Serialize task participants with their display avatar."""

    avatar_url = serializers.SerializerMethodField()

    class Meta(UserLightSerializer.Meta):
        fields = [*UserLightSerializer.Meta.fields, "avatar_url"]
        read_only_fields = fields

    def get_avatar_url(self, instance):
        return utils.generate_profile_image_get_url("avatar", instance.avatar_key)


class ActionItemAssigneeSerializer(UserLightSerializer):
    """Serialize users that a meeting manager can assign action items to."""

    class Meta(UserLightSerializer.Meta):
        fields = [*UserLightSerializer.Meta.fields, "email"]
        read_only_fields = fields


class ResourceAccessSerializerMixin:
    """
    A serializer mixin to share controlling that the logged-in user submitting a room access object
    is administrator on the targeted room.
    """

    # pylint: disable=too-many-boolean-expressions
    def validate(self, data):
        """
        Check access rights specific to writing (create/update)
        """
        request = self.context.get("request", None)
        user = getattr(request, "user", None)
        if (
            # Update
            self.instance
            and (
                data.get("role") == models.RoleChoices.OWNER
                and not self.instance.resource.is_owner(user)
                or self.instance.role == models.RoleChoices.OWNER
                and self.instance.user != user
            )
        ) or (
            # Create
            not self.instance
            and data.get("role") == models.RoleChoices.OWNER
            and not data["resource"].is_owner(user)
        ):
            raise PermissionDenied(
                "Only owners of a room can assign other users as owners."
            )
        return data

    def validate_resource(self, resource):
        """The logged-in user must be administrator of the resource."""
        request = self.context.get("request", None)
        user = getattr(request, "user", None)

        if not (
            user and user.is_authenticated and resource.is_administrator_or_owner(user)
        ):
            raise PermissionDenied(
                _("You must be administrator or owner of a room to add accesses to it.")
            )

        return resource


class ResourceAccessSerializer(
    ResourceAccessSerializerMixin, serializers.ModelSerializer
):
    """Serialize Room to User accesses for the API."""

    class Meta:
        model = models.ResourceAccess
        fields = ["id", "user", "resource", "role"]
        read_only_fields = ["id"]

    def update(self, instance, validated_data):
        """Make "user" and "resource" fields readonly but only on update."""
        validated_data.pop("resource", None)
        validated_data.pop("user", None)
        return super().update(instance, validated_data)


class NestedResourceAccessSerializer(ResourceAccessSerializer):
    """Serialize Room accesses for the API with full nested user."""

    user = UserSerializer(read_only=True)


class ListRoomSerializer(serializers.ModelSerializer):
    """Serialize Room model for a list API endpoint."""

    closed_at = serializers.SerializerMethodField()

    class Meta:
        model = models.Room
        fields = [
            "id",
            "name",
            "slug",            "access_level",
            "created_at",
            "closed_at",
            "scheduled_at",
        ]
        read_only_fields = ["id", "slug", "created_at"]

    def get_closed_at(self, instance):
        """Return the room end time as an ISO string, or '' while still open."""
        return instance.ended_at.isoformat() if instance.ended_at else ""


class RoomSerializer(serializers.ModelSerializer):
    """Serialize Room model for the API."""

    closed_at = serializers.SerializerMethodField()
    owner = serializers.SerializerMethodField()
    event_id = serializers.SerializerMethodField()

    class Meta:
        model = models.Room
        fields = [
            "id",
            "name",
            "slug",            "configuration",
            "access_level",
            "pin_code",
            "created_at",
            "closed_at",
            "owner",
            "scheduled_at",
            "event_id",
        ]
        read_only_fields = ["id", "slug", "pin_code", "created_at", "owner"]

    def get_closed_at(self, instance):
        """Return the room end time as an ISO string, or '' while still open."""
        return instance.ended_at.isoformat() if instance.ended_at else ""

    def get_owner(self, instance):
        """Return the display name of the room owner, or None."""
        owner_access = instance.accesses.filter(
            role=models.RoleChoices.OWNER
        ).select_related("user").first()
        if owner_access is None:
            return None
        user = owner_access.user
        return user.full_name or user.short_name or user.email or None

    def get_event_id(self, instance):
        """关联日程 id;无日程(快速会议/存量裸预约)= None。

        「预约会议 = 创建日程」后,日程创建会顺带建房,于是同一场会既在
        会议列表(房间)又在日历(日程)。客户端据此把详情统一收敛到日程
        详情,避免同一场会两个详情页(有日程 → 日程详情;无 → 会议详情)。
        列表页已 prefetch calendar_events,不逐间多查。
        """
        event = next(iter(instance.calendar_events.all()), None)
        return str(event.id) if event else None

    def validate_configuration(self, value):
        """Validate room configuration against the RoomConfiguration schema."""
        if value is None or value == {}:
            return value
        try:
            RoomConfiguration.model_validate(value)
        except PydanticValidationError as e:
            raise serializers.ValidationError(e.errors()) from e
        return value

    def to_representation(self, instance):
        """
        Add users only for administrator users.
        Add LiveKit credentials for public instance or related users/groups
        """
        output = super().to_representation(instance)
        request = self.context.get("request")

        if not request:
            return output

        role = instance.get_role(request.user)
        is_admin_or_owner = models.RoleChoices.check_administrator_role(
            role
        ) or models.RoleChoices.check_owner_role(role)

        if is_admin_or_owner:
            access_serializer = NestedResourceAccessSerializer(
                instance.accesses.select_related("resource", "user").all(),
                context=self.context,
                many=True,
            )
            output["accesses"] = access_serializer.data

        should_access_room = (
            (
                instance.access_level == models.RoomAccessLevel.TRUSTED
                and request.user.is_authenticated
            )
            or role is not None
            or instance.is_public
        )

        # An ended room must not be joinable again: stop issuing a LiveKit token
        # once `ended_at` is set, so no one can re-enter after the owner ends it.
        if should_access_room and not instance.is_ended:
            room_id = f"{instance.id!s}"
            username = request.query_params.get("username", None)
            output["livekit"] = utils.generate_livekit_config(
                room_id=room_id,
                user=request.user,
                username=username,
                configuration=output["configuration"],
                is_admin_or_owner=is_admin_or_owner,
            )
        else:
            del output["pin_code"]

        output["is_administrable"] = is_admin_or_owner
        # 删除房间要求的是 OWNER(RoomPermissions:DELETE → is_owner),比
        # is_administrable(admin 亦为真)更严;客户端收敛删除入口须用这个,
        # 否则 ADMIN 会看到删除按钮然后吃 403。复用上面已算好的 role,无额外查询。
        output["is_owner"] = models.RoleChoices.check_owner_role(role)

        return output


class RecordingSerializer(serializers.ModelSerializer):
    """Serialize Recording for the API."""

    room = ListRoomSerializer(read_only=True)

    class Meta:
        model = models.Recording
        fields = [
            "id",
            "room",
            "created_at",
            "updated_at",
            "status",
            "mode",
            "options",
            "key",
            "is_expired",
            "expired_at",
        ]
        read_only_fields = fields


class TranscriptSerializer(serializers.ModelSerializer):
    """Read-only serializer for the meeting detail page."""

    class Meta:
        model = models.Transcript
        fields = [
            "id",
            "speaker_identity",
            "speaker_name",
            "text",
            "language",
            "translations",
            "started_at",
            "ended_at",
        ]
        read_only_fields = fields


class ActionItemSerializer(serializers.ModelSerializer):
    """Serialize the AI proposal and its human-review lifecycle."""

    assignee = UserLightSerializer(read_only=True)
    assignee_id = serializers.PrimaryKeyRelatedField(
        source="assignee",
        queryset=models.User.objects.all(),
        allow_null=True,
        required=False,
        write_only=True,
    )
    confirmed_by = UserLightSerializer(read_only=True)
    can_manage = serializers.SerializerMethodField()
    can_update_status = serializers.SerializerMethodField()

    _TRANSITIONS = {
        models.ActionItem.Status.PROPOSED: {
            models.ActionItem.Status.CONFIRMED,
            models.ActionItem.Status.DISMISSED,
        },
        models.ActionItem.Status.CONFIRMED: {
            models.ActionItem.Status.COMPLETED,
            models.ActionItem.Status.DISMISSED,
        },
        models.ActionItem.Status.COMPLETED: {
            models.ActionItem.Status.CONFIRMED,
        },
        models.ActionItem.Status.DISMISSED: {
            models.ActionItem.Status.PROPOSED,
        },
    }

    def _request_user(self):
        request = self.context.get("request")
        return getattr(request, "user", None)

    def get_can_manage(self, instance):
        user = self._request_user()
        return bool(
            user
            and user.is_authenticated
            and instance.room.is_administrator_or_owner(user)
        )

    def get_can_update_status(self, instance):
        user = self._request_user()
        return bool(
            self.get_can_manage(instance)
            or (
                user
                and user.is_authenticated
                and instance.assignee_id == user.id
            )
        )

    def validate_assignee_id(self, assignee):
        """Only meeting members/participants can own an action item."""

        if assignee is None or self.instance is None:
            return assignee
        room = self.instance.room
        has_room_access = room.accesses.filter(user=assignee).exists()
        was_participant = bool(
            self.instance.session_id
            and models.MeetingParticipation.objects.filter(
                session_id=self.instance.session_id, user=assignee
            ).exists()
        )
        if not has_room_access and not was_participant:
            raise serializers.ValidationError(
                _("Assignee must be a member or participant of this meeting.")
            )
        return assignee

    def validate_status(self, status):
        if self.instance is None or status == self.instance.status:
            return status
        allowed = self._TRANSITIONS.get(self.instance.status, set())
        if status not in allowed:
            raise serializers.ValidationError(
                _("This action item status transition is not allowed.")
            )
        return status

    def update(self, instance, validated_data):
        previous_status = instance.status
        previous_sync_activity_id = instance.task_status_sync_activity_id
        instance = super().update(instance, validated_data)
        if instance.status == previous_status:
            return instance

        now = timezone.now()
        actor = self._request_user()
        if instance.status == models.ActionItem.Status.CONFIRMED:
            if instance.confirmed_at is None:
                instance.confirmed_at = now
                instance.confirmed_by = actor
            instance.completed_at = None
        elif instance.status == models.ActionItem.Status.COMPLETED:
            if instance.confirmed_at is None:
                instance.confirmed_at = now
                instance.confirmed_by = actor
            instance.completed_at = now
        elif instance.status == models.ActionItem.Status.PROPOSED:
            instance.confirmed_at = None
            instance.confirmed_by = None
            instance.completed_at = None
        elif instance.status == models.ActionItem.Status.DISMISSED:
            instance.completed_at = None

        instance.task_status_sync_activity = None
        instance.save()
        record_manual_action_item_status_change(
            action_item=instance,
            actor=actor,
            previous_status=previous_status,
            overrode_task_sync=previous_sync_activity_id is not None,
        )
        return instance

    class Meta:
        model = models.ActionItem
        fields = [
            "id",
            "session_id",
            "content",
            "owner_text",
            "due_text",
            "assignee",
            "assignee_id",
            "due_at",
            "status",
            "confirmed_by",
            "confirmed_at",
            "completed_at",
            "task_id",
            "sort_order",
            "is_completed",
            "source_transcript_id",
            "can_manage",
            "can_update_status",
            "created_at",
        ]
        read_only_fields = [
            "id",
            "session_id",
            "owner_text",
            "due_text",
            "confirmed_by",
            "confirmed_at",
            "completed_at",
            "task_id",
            "sort_order",
            "is_completed",
            "source_transcript_id",
            "created_at",
        ]


class TaskActivitySerializer(serializers.ModelSerializer):
    """Serialize one immutable task operation for the activity timeline."""

    actor = TaskUserSerializer(read_only=True)

    class Meta:
        model = models.TaskActivity
        fields = ["id", "actor", "event", "changes", "created_at"]
        read_only_fields = fields


class TaskCommentSerializer(serializers.ModelSerializer):
    """Serialize and validate one immutable task comment."""

    author = TaskUserSerializer(read_only=True)
    content = serializers.CharField(max_length=2000, trim_whitespace=True)

    class Meta:
        model = models.TaskComment
        fields = ["id", "author", "content", "created_at"]
        read_only_fields = ["id", "author", "created_at"]


class TaskAttachmentSerializer(serializers.ModelSerializer):
    """Serialize one task attachment without exposing its storage key."""

    file_id = serializers.UUIDField(source="file.id", read_only=True)
    title = serializers.CharField(source="file.title", read_only=True)
    filename = serializers.CharField(source="file.filename", read_only=True)
    mimetype = serializers.CharField(source="file.mimetype", read_only=True)
    size = serializers.IntegerField(source="file.size", read_only=True)
    uploader = TaskUserSerializer(read_only=True)
    url = serializers.SerializerMethodField()

    def get_url(self, obj):
        return f"/api/v1.0/tasks/{obj.task_id}/attachments/{obj.id}/download/"

    class Meta:
        model = models.TaskAttachment
        fields = [
            "id",
            "file_id",
            "title",
            "filename",
            "mimetype",
            "size",
            "url",
            "uploader",
            "created_at",
        ]
        read_only_fields = fields


class TaskListGroupSummarySerializer(serializers.ModelSerializer):
    """Compact task-list group reference embedded in a task list."""

    class Meta:
        model = models.TaskListGroup
        fields = ["id", "name", "sort_order"]
        read_only_fields = fields


class TaskListGroupSerializer(serializers.ModelSerializer):
    """Serialize an organization section that contains task lists."""

    creator = TaskUserSerializer(read_only=True)
    can_manage = serializers.SerializerMethodField()
    list_count = serializers.SerializerMethodField()

    def get_can_manage(self, obj):
        request = self.context.get("request")
        user = getattr(request, "user", None)
        return bool(
            user
            and user.is_authenticated
            and (
                obj.creator_id == user.id
                or self.context.get("can_manage_all_task_lists", False)
            )
        )

    def get_list_count(self, obj):
        annotated = getattr(obj, "_list_count", None)
        if annotated is not None:
            return annotated
        return obj.task_lists.filter(is_archived=False).count()

    class Meta:
        model = models.TaskListGroup
        fields = [
            "id",
            "name",
            "sort_order",
            "creator",
            "can_manage",
            "list_count",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id",
            "creator",
            "can_manage",
            "list_count",
            "created_at",
            "updated_at",
        ]


class TaskGroupSerializer(serializers.ModelSerializer):
    """Serialize a custom section inside a task list."""

    task_count = serializers.SerializerMethodField()
    can_delete = serializers.SerializerMethodField()

    @staticmethod
    def _task_count(obj):
        annotated = getattr(obj, "_task_count", None)
        return annotated if annotated is not None else obj.tasks.count()

    def get_can_delete(self, obj):
        return self._task_count(obj) == 0

    def get_task_count(self, obj):
        return self._task_count(obj)

    class Meta:
        model = models.TaskGroup
        fields = [
            "id",
            "name",
            "sort_order",
            "task_count",
            "can_delete",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "task_count", "created_at", "updated_at"]


class TaskListSerializer(serializers.ModelSerializer):
    """Serialize an organization task list and its ordered groups."""

    creator = TaskUserSerializer(read_only=True)
    list_group = TaskListGroupSummarySerializer(read_only=True)
    list_group_id = serializers.PrimaryKeyRelatedField(
        source="list_group",
        queryset=models.TaskListGroup.objects.all(),
        allow_null=True,
        required=False,
        write_only=True,
    )
    groups = TaskGroupSerializer(many=True, read_only=True)
    access_role = serializers.SerializerMethodField()
    can_manage = serializers.SerializerMethodField()
    can_share = serializers.SerializerMethodField()
    can_archive = serializers.SerializerMethodField()
    can_remove = serializers.SerializerMethodField()
    can_delete = serializers.SerializerMethodField()
    can_create_tasks = serializers.SerializerMethodField()
    task_count = serializers.SerializerMethodField()

    def _access_role(self, obj):
        request = self.context.get("request")
        user = getattr(request, "user", None)
        if user is None or not user.is_authenticated:
            return None
        prefetched = getattr(obj, "_current_user_accesses", None)
        if prefetched is not None:
            role = prefetched[0].role if prefetched else None
        else:
            role = (
                obj.accesses.filter(user=user)
                .values_list("role", flat=True)
                .first()
            )
        if role is None and obj.creator_id == user.id:
            return models.TaskListAccess.Role.OWNER
        return role

    def get_access_role(self, obj):
        return self._access_role(obj)

    def get_can_manage(self, obj):
        return self._access_role(obj) in {
            models.TaskListAccess.Role.EDITOR,
            models.TaskListAccess.Role.OWNER,
        }

    def get_can_share(self, obj):
        return self.get_can_manage(obj)

    def get_can_archive(self, obj):
        return self.get_can_manage(obj)

    def get_can_remove(self, obj):
        role = self._access_role(obj)
        return role is not None and role != models.TaskListAccess.Role.OWNER

    def get_can_delete(self, obj):
        return self._access_role(obj) == models.TaskListAccess.Role.OWNER

    def get_can_create_tasks(self, obj):
        return self.get_can_manage(obj) and not obj.is_archived

    def get_task_count(self, obj):
        annotated = getattr(obj, "_task_count", None)
        if annotated is not None:
            return annotated
        request = self.context.get("request")
        user = getattr(request, "user", None)
        if user is None or not user.is_authenticated:
            return 0
        return obj.tasks.count()

    class Meta:
        model = models.TaskList
        fields = [
            "id",
            "name",
            "description",
            "color",
            "creator",
            "list_group",
            "list_group_id",
            "is_archived",
            "access_role",
            "can_manage",
            "can_share",
            "can_archive",
            "can_remove",
            "can_delete",
            "can_create_tasks",
            "task_count",
            "groups",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id",
            "creator",
            "list_group",
            "access_role",
            "can_manage",
            "can_share",
            "can_archive",
            "can_remove",
            "can_delete",
            "can_create_tasks",
            "task_count",
            "groups",
            "created_at",
            "updated_at",
        ]


class TaskListAccessSerializer(serializers.ModelSerializer):
    """Serialize one task-list collaborator and their permission level."""

    user = TaskUserSerializer(read_only=True)

    class Meta:
        model = models.TaskListAccess
        fields = ["id", "user", "role", "created_at", "updated_at"]
        read_only_fields = ["id", "user", "created_at", "updated_at"]


class TaskListSummarySerializer(serializers.ModelSerializer):
    """Compact task-list reference embedded in a task."""

    class Meta:
        model = models.TaskList
        fields = ["id", "name", "color"]
        read_only_fields = fields


class TaskGroupSummarySerializer(serializers.ModelSerializer):
    """Compact group reference embedded in a task."""

    class Meta:
        model = models.TaskGroup
        fields = ["id", "name", "sort_order"]
        read_only_fields = fields


class TaskSerializer(serializers.ModelSerializer):
    """Serialize a durable task for the task center and meeting detail."""

    creator = TaskUserSerializer(read_only=True)
    assignee = TaskUserSerializer(read_only=True)
    source_action_item_id = serializers.UUIDField(read_only=True)
    source_room_id = serializers.SerializerMethodField()
    source_room_name = serializers.SerializerMethodField()
    can_edit = serializers.SerializerMethodField()
    can_update_status = serializers.SerializerMethodField()
    can_cancel = serializers.SerializerMethodField()
    can_comment = serializers.SerializerMethodField()
    can_manage_attachments = serializers.SerializerMethodField()
    time_state = serializers.SerializerMethodField()
    task_list = TaskListSummarySerializer(read_only=True)
    group = TaskGroupSummarySerializer(read_only=True)

    def _request_user(self):
        request = self.context.get("request")
        return getattr(request, "user", None)

    def get_can_edit(self, obj):
        user = self._request_user()
        if not user or not user.is_authenticated:
            return False
        if obj.creator_id == user.id:
            return True
        return self._can_edit_task_list(obj, user)

    @staticmethod
    def _can_edit_task_list(obj, user):
        if not obj.task_list_id:
            return False
        annotated = getattr(obj, "_can_edit_task_list", None)
        if annotated is not None:
            return bool(annotated)
        return obj.task_list.accesses.filter(
            user=user,
            role__in=[
                models.TaskListAccess.Role.EDITOR,
                models.TaskListAccess.Role.OWNER,
            ],
        ).exists()

    def _can_collaborate(self, obj, user):
        return bool(
            user
            and user.is_authenticated
            and (
                user.id in {obj.creator_id, obj.assignee_id}
                or self._can_edit_task_list(obj, user)
            )
        )

    def get_can_update_status(self, obj):
        user = self._request_user()
        can_update = bool(
            user
            and user.is_authenticated
            and (
                user.id in {obj.creator_id, obj.assignee_id}
                or self._can_edit_task_list(obj, user)
            )
        )
        if (
            can_update
            and obj.status == models.Task.Status.CANCELED
            and obj.creator_id != user.id
        ):
            return False
        return can_update

    def get_can_cancel(self, obj):
        user = self._request_user()
        return bool(user and user.is_authenticated and obj.creator_id == user.id)

    def get_can_comment(self, obj):
        return self._can_collaborate(obj, self._request_user())

    def get_can_manage_attachments(self, obj):
        return self._can_collaborate(obj, self._request_user())

    def get_time_state(self, obj):
        user = self._request_user()
        if user is None or not user.is_authenticated:
            return None
        today = getattr(obj, "_assignee_local_date", None)
        if today is None:
            today = local_date_for_user(obj.assignee or user)
        return task_time_state(obj, today=today)

    def get_source_room_id(self, obj):
        if obj.source_action_item_id is None:
            return None
        return obj.source_action_item.room_id

    def get_source_room_name(self, obj):
        if obj.source_action_item_id is None:
            return None
        return obj.source_action_item.room.name

    class Meta:
        model = models.Task
        fields = [
            "id",
            "title",
            "description",
            "creator",
            "assignee",
            "status",
            "priority",
            "task_list",
            "group",
            "position",
            "start_date",
            "due_date",
            "completed_at",
            "source_action_item_id",
            "source_room_id",
            "source_room_name",
            "can_edit",
            "can_update_status",
            "can_cancel",
            "can_comment",
            "can_manage_attachments",
            "time_state",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields


class SummaryChapterSerializer(serializers.ModelSerializer):
    """纪要闭环 D1:智能章节(read-only,嵌在 Summary 里)。"""

    class Meta:
        model = models.SummaryChapter
        fields = [
            "id",
            "title",
            "digest",
            "started_at",
            "ended_at",
            "sort_order",
        ]
        read_only_fields = fields


class SummarySerializer(serializers.ModelSerializer):
    """Read-only serializer for the meeting detail page."""

    action_items = ActionItemSerializer(many=True, read_only=True)
    # 纪要闭环 D2:三板块之三。旧客户端忽略新字段即可,无破坏性变更。
    chapters = SummaryChapterSerializer(many=True, read_only=True)
    # 纪要闭环 M2(D3)可编辑:content 永远是 AI 原文;展示用 effective_content。
    is_edited = serializers.BooleanField(read_only=True)
    effective_content = serializers.CharField(read_only=True)
    ai_updated_after_edit = serializers.BooleanField(read_only=True)
    edited_by = UserLightSerializer(read_only=True)

    class Meta:
        model = models.Summary
        fields = [
            "id",
            "content",
            "model_used",
            "transcripts_count",
            "status",
            "error_message",
            "created_at",
            "updated_at",
            "action_items",
            "chapters",
            "is_edited",
            "effective_content",
            "ai_updated_after_edit",
            "edited_by",
            "edited_at",
        ]
        read_only_fields = fields


class BaseValidationOnlySerializer(serializers.Serializer):
    """Base serializer for validation-only operations."""

    def create(self, validated_data):
        """Not implemented as this is a validation-only serializer."""
        raise NotImplementedError(f"{self.__class__.__name__} is validation-only")

    def update(self, instance, validated_data):
        """Not implemented as this is a validation-only serializer."""
        raise NotImplementedError(f"{self.__class__.__name__} is validation-only")


class RecordingOptions(BaseModel):
    """Configuration options for recording.

    Attributes:
        language: ISO 639-1 language code compatible with whisperX.
            When `None`, the transcription engine will attempt to
            auto-detect the spoken language.
        transcribe: Whether to transcribe the recorded audio.
            When `None`, falls back to the application default.
        original_mode: The original recording mode before any override.
            Must be one of the valid RecordingModeChoices values when provided.
        collect_metadata: Whether to collect additional metadata during recording.
            When `None`, no metadata are collected.

    """

    language: str | None = None
    transcribe: bool | None = None
    collect_metadata: bool | None = None
    original_mode: Literal["screen_recording", "transcript"] | None = None

    model_config = {"extra": "forbid"}


class StartRecordingSerializer(BaseValidationOnlySerializer):
    """Validate start recording requests."""

    mode = serializers.ChoiceField(
        choices=models.RecordingModeChoices.choices,
        required=True,
        error_messages={
            "required": "Recording mode is required.",
            "invalid_choice": "Invalid recording mode. Choose between "
            "screen_recording or transcript.",
        },
    )
    options = SchemaField(
        schema=RecordingOptions | None,
        required=False,
        allow_null=True,
        help_text="Recording options",
    )


class RequestEntrySerializer(BaseValidationOnlySerializer):
    """Validate request entry data."""

    username = serializers.CharField(required=True)


class ParticipantEntrySerializer(BaseValidationOnlySerializer):
    """Validate participant entry decision data."""

    participant_id = serializers.UUIDField(required=True)
    allow_entry = serializers.BooleanField(required=True)


class CreationCallbackSerializer(BaseValidationOnlySerializer):
    """Validate room creation callback data."""

    callback_id = serializers.CharField(required=True)


class RoomInviteSerializer(serializers.Serializer):
    """Validate room invite creation data."""

    emails = serializers.ListField(child=serializers.EmailField(), allow_empty=False)


class RoomSuggestedInviteesSerializer(serializers.Serializer):
    """Validate the P5 suggested-participants report body (user ids + source).

    ``source`` mirrors ``RoomInvitee.source``: "group" for group-originated
    calls (the whole source group becomes the suggestion list), "manual" for
    people picked in the in-meeting invite panel.
    """

    user_ids = serializers.ListField(
        child=serializers.UUIDField(), allow_empty=False, max_length=200
    )
    source = serializers.ChoiceField(choices=["group", "manual"], default="manual")


class BaseParticipantsManagementSerializer(BaseValidationOnlySerializer):
    """Base serializer for participant management operations."""

    participant_identity = serializers.UUIDField(
        help_text="LiveKit participant identity (UUID format)"
    )


class MuteParticipantSerializer(BaseParticipantsManagementSerializer):
    """Validate participant muting data."""

    track_sid = serializers.CharField(
        max_length=255, help_text="LiveKit track SID to mute"
    )


class StartAIAgentSerializer(BaseValidationOnlySerializer):
    """Validate AI assistant start requests.

    The frontend selects an AI agent profile (an admin-managed assembly of
    STT/VLM/LLM/TTS or Omni model) and optionally overrides the default
    voice / prompt by id. Models, endpoints and credentials are resolved
    server-side from the catalog.
    """

    profile_code = serializers.CharField(
        max_length=64,
        required=True,
        help_text="AIAgentProfile.code, e.g. 'qwen', 'doubao_s2s', 'doubao_pipeline'.",
    )
    voice_id = serializers.UUIDField(
        required=False,
        allow_null=True,
        help_text="AIVoice id; falls back to user preference, then profile default.",
    )
    prompt_id = serializers.UUIDField(
        required=False,
        allow_null=True,
        help_text="AIPrompt id; falls back to user preference, then profile default.",
    )


class AskAISerializer(BaseValidationOnlySerializer):
    """Validate a single room-AI ``ask-ai`` question.

    The endpoint is single-turn, so we only need the question text. The
    500-char cap is deliberately generous (a couple of sentences with
    context) without leaving room for prompt-injection padding.
    """

    question = serializers.CharField(
        required=True,
        max_length=500,
        allow_blank=False,
        trim_whitespace=True,
        help_text="The user's question about the current meeting.",
    )


class AskPersonalAISerializer(BaseValidationOnlySerializer):
    """Validate a single cross-meeting (personal) AI question.

    Same shape as :class:`AskAISerializer` — kept as its own class so
    OpenAPI docs / spectacular pick up the distinct endpoint semantics.
    """

    question = serializers.CharField(
        required=True,
        max_length=500,
        allow_blank=False,
        trim_whitespace=True,
        help_text="The user's question about their accessible meetings.",
    )


class _ChatHistoryItemSerializer(serializers.Serializer):
    """One element of the ``history`` array on streaming endpoints.

    ``role`` is restricted to ``user`` / ``assistant`` so the frontend
    can't smuggle in a ``system`` entry that would override the backend's
    own prompt; ``sanitise_history`` enforces the same rule defensively
    inside the service layer.
    """

    role = serializers.ChoiceField(choices=("user", "assistant"))
    content = serializers.CharField(
        max_length=2000, allow_blank=False, trim_whitespace=True
    )


class AskAIStreamSerializer(BaseValidationOnlySerializer):
    """Validate a streaming room-AI question (Sprint 2.5)."""

    question = serializers.CharField(
        required=True,
        max_length=500,
        allow_blank=False,
        trim_whitespace=True,
    )
    history = _ChatHistoryItemSerializer(
        many=True,
        required=False,
        help_text="Up to 3 previous turns (6 messages) for follow-up context.",
    )


class AskPersonalAIStreamSerializer(BaseValidationOnlySerializer):
    """Validate a streaming cross-meeting AI question (Sprint 2.5)."""

    question = serializers.CharField(
        required=True,
        max_length=500,
        allow_blank=False,
        trim_whitespace=True,
    )
    history = _ChatHistoryItemSerializer(many=True, required=False)


TrackSource = Literal["camera", "microphone", "screen_share", "screen_share_audio"]


class RoomConfiguration(BaseModel):
    """Validate room configuration structure.

    Unknown fields are rejected.
    """

    can_publish_sources: list[TrackSource] | None = None
    everyone_can_mute: bool | None = None

    model_config = {"extra": "forbid"}


class ParticipantPermission(BaseModel):
    """Mirror the LiveKit ParticipantPermission protobuf.

    Control what a participant is allowed to publish, subscribe, and do within a room.
    Unknown fields are rejected.
    """

    can_subscribe: bool | None = None
    can_publish: bool | None = None
    can_publish_data: bool | None = None
    can_publish_sources: list[TrackSource] = Field(default_factory=list)
    hidden: bool | None = None
    recorder: bool | None = None
    can_update_metadata: bool | None = None
    agent: bool | None = None
    can_subscribe_metrics: bool | None = None

    model_config = {"extra": "forbid"}

    @field_serializer("can_publish_sources")
    def _serialize_sources(self, sources: list[str]) -> list[str]:
        return [s.upper() for s in sources]


class UpdateParticipantSerializer(BaseParticipantsManagementSerializer):
    """Validate participant update data."""

    metadata = serializers.DictField(
        required=False, allow_null=True, help_text="Participant metadata as JSON object"
    )
    attributes = serializers.DictField(
        required=False,
        allow_null=True,
        help_text="Participant attributes as JSON object",
    )
    permission = SchemaField(
        schema=ParticipantPermission | None,
        required=False,
        allow_null=True,
        help_text="Participant permissions",
    )
    name = serializers.CharField(
        max_length=255,
        required=False,
        allow_blank=True,
        allow_null=True,
        help_text="Display name for the participant",
    )

    def validate_permission(self, permission):
        """Validate that the given permission does not include forbidden or unimplemented fields."""

        if permission is None:
            return None

        suspicious_fields = [
            field
            for field in settings.PARTICIPANT_FORBIDDEN_PERMISSION_FIELDS
            if getattr(permission, field) is not None
        ]
        if suspicious_fields:
            raise SuspiciousOperation(
                f"Setting the following participant permissions is not allowed: "
                f"{', '.join(suspicious_fields)}."
            )

        return permission

    def validate(self, attrs):
        """Ensure at least one update field is provided."""
        update_fields = ["metadata", "attributes", "permission", "name"]

        has_update = any(
            field in attrs and attrs[field] is not None and attrs[field] != ""
            for field in update_fields
        )

        if not has_update:
            raise serializers.ValidationError(
                f"At least one of the following fields must be provided: "
                f"{', '.join(update_fields)}."
            )

        return attrs


class ListFileSerializer(serializers.ModelSerializer):
    """Serialize File model for the API."""

    url = serializers.SerializerMethodField(read_only=True)
    creator = UserLightSerializer(read_only=True)
    abilities = serializers.SerializerMethodField(read_only=True)

    class Meta:
        model = models.File
        fields = [
            "id",
            "created_at",
            "updated_at",
            "title",
            "type",
            "creator",
            "deleted_at",
            "hard_deleted_at",
            "filename",
            "upload_state",
            "mimetype",
            "size",
            "description",
            "url",
            "abilities",
        ]
        read_only_fields = [
            "id",
            "created_at",
            "updated_at",
            "creator",
            "deleted_at",
            "hard_deleted_at",
            "filename",
            "upload_state",
            "mimetype",
            "size",
            "url",
            "abilities",
        ]

    def get_url(self, obj):
        """Return the URL of the file."""
        if obj.is_pending_upload:
            return None

        return f"{settings.MEDIA_BASE_URL}{settings.MEDIA_URL}{quote(obj.file_key)}"

    def get_abilities(self, file) -> dict:
        """Return abilities of the logged-in user on the instance."""
        request = self.context.get("request")
        if not request:
            return {}

        return file.get_abilities(request.user)


class FileSerializer(ListFileSerializer):
    """Default serializer File model for the API."""

    def create(self, validated_data):
        raise NotImplementedError("Create method can not be used.")


class CreateFileSerializer(ListFileSerializer):
    """Serializer used to create a new file"""

    title = serializers.CharField(max_length=255, required=False)
    policy = serializers.SerializerMethodField()

    class Meta:
        model = models.File
        fields = [*ListFileSerializer.Meta.fields, "policy"]
        read_only_fields = [
            *(
                field
                for field in ListFileSerializer.Meta.read_only_fields
                if field != "filename"
            ),
            "policy",
        ]

    def get_fields(self):
        """Force the id field to be writable."""
        fields = super().get_fields()
        fields["id"].read_only = False

        return fields

    def validate_id(self, value):
        """Ensure the provided ID does not already exist when creating a new file."""
        request = self.context.get("request")

        # Only check this on POST (creation)
        if request and models.File.objects.filter(id=value).exists():
            raise serializers.ValidationError(
                "A file with this ID already exists. You cannot override it.",
                code="file_create_existing_id",
            )

        return value

    def validate(self, attrs):
        """Validate extension and fill title."""
        # we run the default validation first to make sure the base data in attrs is ok
        attrs = super().validate(attrs)

        filename_root, ext = splitext(attrs["filename"])

        if settings.FILE_UPLOAD_APPLY_RESTRICTIONS:
            config_for_file_type = settings.FILE_UPLOAD_RESTRICTIONS[attrs["type"]]
            if ext.lower() not in config_for_file_type["allowed_extensions"]:
                logger.info(
                    "create_item: file extension not allowed %s for filename %s",
                    ext,
                    attrs["filename"],
                )
                raise serializers.ValidationError(
                    {"filename": _("This file extension is not allowed.")},
                    code="item_create_file_extension_not_allowed",
                )

        # The title will be the filename if not provided
        if not attrs.get("title", None):
            attrs["title"] = filename_root

        return attrs

    def get_policy(self, file):
        """Return the policy to use if the item is a file."""

        if file.upload_state == models.FileUploadStateChoices.READY:
            return None

        return utils.generate_upload_policy(file)

    def update(self, instance, validated_data):
        raise NotImplementedError("Update method can not be used.")


class RaiseHandSerializer(BaseValidationOnlySerializer):
    """Serializer for raising or lowering a participant's hand in a room."""

    raised = serializers.BooleanField()


class RenameParticipantSerializer(BaseValidationOnlySerializer):
    """Serializer for renaming a participant in a room."""

    name = serializers.CharField(min_length=1, max_length=255, allow_blank=False)
