"""Account-scoped sync of explicit AI conversation records.

Phase 1 stores the conversation index and text rows only. Screen frames, camera
images and raw audio intentionally stay on the client.
"""

import json

from django.db import transaction
from django.db.models import Count
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import permissions, serializers, status, throttling
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from core.models import AIConversation, AIConversationMessage

MAX_MESSAGES = 2000
MAX_TEXT_BYTES = 2_000_000
CLIENT_ID = r"^[A-Za-z0-9._:-]{1,128}$"


class ConversationThrottle(throttling.UserRateThrottle):
    scope = "ai_conversation_sync"
    rate = "120/min"


class MessageInputSerializer(serializers.Serializer):
    client_id = serializers.RegexField(CLIENT_ID)
    position = serializers.IntegerField(min_value=0, max_value=MAX_MESSAGES - 1)
    role = serializers.ChoiceField(choices=("user", "assistant", "system"))
    text = serializers.CharField(max_length=20_000, allow_blank=True)
    source = serializers.CharField(max_length=20, allow_blank=True, default="")


class ConversationInputSerializer(serializers.Serializer):
    client_id = serializers.RegexField(CLIENT_ID)
    device_id = serializers.CharField(max_length=128, allow_blank=True, default="")
    kind = serializers.ChoiceField(choices=("call", "chat", "translation"), default="call")
    title = serializers.CharField(max_length=200, allow_blank=True, default="")
    started_at = serializers.DateTimeField()
    ended_at = serializers.DateTimeField(required=False, allow_null=True)
    status = serializers.ChoiceField(
        choices=("ongoing", "completed", "interrupted", "error"),
        default="completed",
    )
    summary = serializers.CharField(max_length=8000, allow_blank=True, default="")
    todos = serializers.ListField(
        child=serializers.JSONField(), required=False, default=list, max_length=20
    )
    messages = MessageInputSerializer(many=True, max_length=MAX_MESSAGES, default=list)

    def validate(self, attrs):
        if attrs.get("ended_at") and attrs["ended_at"] < attrs["started_at"]:
            raise serializers.ValidationError("ended_at must not precede started_at.")
        messages = attrs["messages"]
        ids = [message["client_id"] for message in messages]
        if len(set(ids)) != len(ids):
            raise serializers.ValidationError("Duplicate message client_id.")
        if len({message["position"] for message in messages}) != len(messages):
            raise serializers.ValidationError("Duplicate message position.")
        payload = {
            "summary": attrs.get("summary", ""),
            "todos": attrs.get("todos", []),
            "messages": messages,
        }
        if len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > MAX_TEXT_BYTES:
            raise serializers.ValidationError("Conversation exceeds the text sync limit.")
        return attrs


class MessageOutputSerializer(serializers.ModelSerializer):
    class Meta:
        model = AIConversationMessage
        fields = ("id", "client_id", "position", "role", "text", "source")


class ConversationOutputSerializer(serializers.ModelSerializer):
    message_count = serializers.IntegerField(read_only=True)
    messages = MessageOutputSerializer(many=True, read_only=True)

    class Meta:
        model = AIConversation
        fields = (
            "id",
            "client_id",
            "device_id",
            "kind",
            "title",
            "started_at",
            "ended_at",
            "status",
            "summary",
            "todos",
            "version",
            "updated_at",
            "message_count",
            "messages",
        )


class ConversationListSerializer(serializers.ModelSerializer):
    message_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = AIConversation
        fields = (
            "id",
            "client_id",
            "device_id",
            "kind",
            "title",
            "started_at",
            "ended_at",
            "status",
            "summary",
            "todos",
            "version",
            "updated_at",
            "message_count",
        )


def _conversation_queryset(user):
    return AIConversation.objects.filter(owner=user, deleted_at__isnull=True)


class AIConversationView(APIView):
    """List/sync explicit conversation snapshots; no cross-account access."""

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ConversationThrottle]

    def get(self, request):
        since_raw = request.query_params.get("since")
        since = None
        if since_raw:
            since = parse_datetime(since_raw)
            if since is None:
                raise ValidationError({"since": "Invalid ISO-8601 datetime."})
        include_messages = request.query_params.get("include_messages") in {
            "1",
            "true",
            "yes",
        }
        queryset = _conversation_queryset(request.user).annotate(
            message_count=Count("messages")
        )
        if since:
            queryset = queryset.filter(updated_at__gt=since)
        if include_messages:
            queryset = queryset.prefetch_related("messages")
        conversations = list(queryset.order_by("-started_at", "-id")[:100])
        serializer = (
            ConversationOutputSerializer(conversations, many=True)
            if include_messages
            else ConversationListSerializer(conversations, many=True)
        )
        return Response(
            {"conversations": serializer.data, "server_time": timezone.now()},
            headers={"Cache-Control": "no-store"},
        )

    @transaction.atomic
    def post(self, request):
        source = ConversationInputSerializer(data=request.data)
        source.is_valid(raise_exception=True)
        data = source.validated_data
        existing = (
            AIConversation.objects.select_for_update()
            .filter(owner=request.user, client_id=data["client_id"])
            .first()
        )
        if existing and existing.deleted_at is not None:
            return Response(
                {"detail": "Conversation was deleted on another device."},
                status=status.HTTP_410_GONE,
            )
        title = data.get("title", "").strip()
        if not title:
            first = next(
                (message["text"].strip() for message in data["messages"] if message["text"].strip()),
                "",
            )
            title = first[:80]
        values = {
            "device_id": data.get("device_id", ""),
            "kind": data["kind"],
            "title": title,
            "started_at": data["started_at"],
            "ended_at": data.get("ended_at"),
            "status": data["status"],
            "summary": data.get("summary", ""),
            "todos": data.get("todos", []),
        }
        if existing:
            conversation = existing
            for field, value in values.items():
                setattr(conversation, field, value)
            conversation.version += 1
            conversation.save()
            conversation.messages.all().delete()
            created = False
        else:
            conversation = AIConversation.objects.create(
                owner=request.user,
                client_id=data["client_id"],
                version=1,
                **values,
            )
            created = True
        AIConversationMessage.objects.bulk_create([
            AIConversationMessage(
                conversation=conversation,
                client_id=message["client_id"],
                position=message["position"],
                role=message["role"],
                text=message["text"],
                source=message.get("source", ""),
            )
            for message in data["messages"]
        ])
        conversation.message_count = len(data["messages"])
        serializer = ConversationOutputSerializer(conversation)
        return Response(
            serializer.data,
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
            headers={"Cache-Control": "no-store"},
        )


class AIConversationDetailView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ConversationThrottle]

    def get(self, request, conversation_id):
        conversation = _conversation_queryset(request.user).filter(pk=conversation_id).first()
        if conversation is None:
            raise NotFound
        conversation.message_count = conversation.messages.count()
        return Response(
            ConversationOutputSerializer(conversation).data,
            headers={"Cache-Control": "no-store"},
        )

    def delete(self, request, conversation_id):
        conversation = _conversation_queryset(request.user).filter(pk=conversation_id).first()
        if conversation is None:
            raise NotFound
        conversation.deleted_at = timezone.now()
        conversation.version += 1
        conversation.save(update_fields=["deleted_at", "version", "updated_at"])
        return Response(status=status.HTTP_204_NO_CONTENT)
