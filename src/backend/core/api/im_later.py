"""IM「稍后处理」bookmarks: ``/api/v1.0/im/later/`` (P3-M1).

Per-user marks on IM messages, stored entirely on the we-meet side (see
``ImLaterItem`` docstring for why no jusi round-trip happens here). Matches
the narrowly-scoped feature-endpoint pattern of ``im.py`` / ``ai_agent_*``.

Surface:

    GET    /api/v1.0/im/later/            → list (``?status=pending|done|all``, default pending)
    POST   /api/v1.0/im/later/            → mark (idempotent; re-marking a done item reopens it)
    POST   /api/v1.0/im/later/{id}/done/  → resolve (idempotent)
    DELETE /api/v1.0/im/later/{id}/       → remove from the list entirely
"""

from __future__ import annotations

from django.utils import timezone

from rest_framework import mixins, permissions, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from core import models


class ImLaterItemSerializer(serializers.ModelSerializer):
    """Rows are user-scoped; ``user`` never crosses the wire."""

    class Meta:
        model = models.ImLaterItem
        fields = [
            "id",
            "cid",
            "mid",
            "seq",
            "snippet",
            "sender_name",
            "content_type",
            "done_at",
            "created_at",
        ]
        read_only_fields = ["id", "done_at", "created_at"]


class ImLaterViewSet(
    mixins.ListModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    """CRUD-lite over the caller's own later-list."""

    permission_classes = [permissions.IsAuthenticated]
    serializer_class = ImLaterItemSerializer
    # Later-lists are personal and short; a bare array keeps the client simple.
    pagination_class = None

    def get_queryset(self):
        queryset = models.ImLaterItem.objects.filter(user=self.request.user)
        if self.action == "list":
            status_filter = self.request.query_params.get("status", "pending")
            if status_filter == "pending":
                queryset = queryset.filter(done_at__isnull=True)
            elif status_filter == "done":
                queryset = queryset.filter(done_at__isnull=False)
            # "all" (or anything else) → no extra filter.
        return queryset

    def create(self, request):
        """Mark a message. Idempotent on (user, cid, mid): re-marking an
        existing pending item is a no-op; re-marking a done item reopens it
        and refreshes the snapshot."""
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        item, created = models.ImLaterItem.objects.get_or_create(
            user=request.user,
            cid=data["cid"],
            mid=data["mid"],
            defaults={
                "seq": data.get("seq", 0),
                "snippet": data.get("snippet", ""),
                "sender_name": data.get("sender_name", ""),
                "content_type": data.get("content_type", ""),
            },
        )
        if not created and item.done_at is not None:
            item.done_at = None
            item.seq = data.get("seq", item.seq)
            item.snippet = data.get("snippet", item.snippet)
            item.sender_name = data.get("sender_name", item.sender_name)
            item.content_type = data.get("content_type", item.content_type)
            item.save()

        return Response(
            self.get_serializer(item).data,
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )

    @action(detail=True, methods=["post"], url_path="done")
    def done(self, request, pk=None):
        """Resolve one item. Idempotent — resolving twice keeps the first
        ``done_at``."""
        item = self.get_object()
        if item.done_at is None:
            item.done_at = timezone.now()
            item.save(update_fields=["done_at", "updated_at"])
        return Response(self.get_serializer(item).data)
