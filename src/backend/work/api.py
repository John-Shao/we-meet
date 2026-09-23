"""Authenticated material APIs; no model calls or meeting reads."""

import uuid

from django.conf import settings
from django.db import transaction
from django.http import Http404
from django.shortcuts import get_object_or_404
from django.utils import timezone

from rest_framework import permissions, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.pagination import PageNumberPagination
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from . import services
from .models import WorkMaterial
from .upload import BoundedMaterialUpload


class WorkUser(permissions.BasePermission):
    """Require a real active account, including for API bearer authentication."""

    def has_permission(self, request, view):
        user = request.user
        return bool(
            user.is_authenticated and user.is_active and user.sub and not user.is_device
        )


class MaterialSerializer(serializers.ModelSerializer):
    """Never expose storage key or full parsed content in list responses."""

    class Meta:
        model = WorkMaterial
        fields = [
            "id",
            "original_name",
            "size",
            "mime",
            "checksum",
            "status",
            "parser_version",
            "line_count",
            "error_code",
            "generation",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields


class MaterialPagination(PageNumberPagination):
    page_size = 20


class CapabilitiesView(APIView):
    """Server authority for visible features and accepted file limits."""

    permission_classes = [WorkUser]

    def get(self, request):
        return Response(
            {
                "enabled": settings.WORK_ENABLED,
                "materials_enabled": settings.WORK_ENABLED
                and settings.WORK_MATERIALS_ENABLED,
                "formats": [".txt", ".md", ".markdown"],
                "max_file_bytes": services.MAX_FILE_BYTES,
                "max_owner_bytes": services.MAX_OWNER_BYTES,
                "max_owner_files": services.MAX_OWNER_FILES,
                "max_batch_files": 10,
                "max_batch_bytes": 30 * 1024 * 1024,
                "skills": [],
            }
        )


class MaterialViewSet(viewsets.GenericViewSet):
    """Private material lifecycle; safe reads remain available after disabling."""

    permission_classes = [WorkUser]
    serializer_class = MaterialSerializer
    pagination_class = MaterialPagination
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def initialize_request(self, request, *args, **kwargs):
        if self.action_map.get(request.method.lower()) == "create":
            request.upload_handlers.insert(0, BoundedMaterialUpload(request))
        return super().initialize_request(request, *args, **kwargs)

    def get_queryset(self):
        return services.visible_materials(self.request.user)

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "no-store"
        return response

    def list(self, request):
        page = self.paginate_queryset(self.get_queryset().defer("text", "storage_key"))
        return self.get_paginated_response(self.get_serializer(page, many=True).data)

    def retrieve(self, request, pk=None):
        return Response(self.get_serializer(self.get_object()).data)

    def create(self, request):
        self.require_enabled()
        key = self.request_key(request)
        data = request.data  # stream through the bounded upload handler before saving
        upload_error = getattr(request, "work_upload_error", "")
        if upload_error:
            return Response(
                {"code": upload_error},
                status=413 if upload_error == "file_too_large" else 400,
            )
        if set(data) != {"file"} or len(request.FILES.getlist("file")) != 1:
            return Response({"code": "one_file_required"}, status=400)
        try:
            item, created = services.create_material(
                request.user, request.FILES["file"], key
            )
        except services.MaterialError as exc:
            return Response({"code": exc.code}, status=exc.status)
        except Exception:  # noqa: BLE001 -- sanitize storage failures at the public boundary
            return Response({"code": "upload_unavailable"}, status=503)
        return Response(self.get_serializer(item).data, status=201 if created else 200)

    @staticmethod
    def require_enabled():
        if not settings.WORK_ENABLED or not settings.WORK_MATERIALS_ENABLED:
            raise Http404

    @staticmethod
    def request_key(request):
        try:
            return uuid.UUID(request.headers.get("Idempotency-Key", ""))
        except (ValueError, AttributeError) as exc:
            raise serializers.ValidationError(
                {"code": "invalid_idempotency_key"}
            ) from exc

    @action(detail=True, methods=["get"])
    def preview(self, request, pk=None):
        item = self.get_object()
        if item.status != WorkMaterial.Status.READY:
            return Response({"code": "material_not_ready"}, status=409)
        try:
            start = int(request.query_params.get("start", "1"))
        except ValueError:
            start = 0
        if start < 1 or start > max(item.line_count, 1):
            return Response({"code": "invalid_line"}, status=400)
        lines = item.text.splitlines()
        end = min(start - 1 + 100, len(lines))
        # A huge single line is explicitly truncated for display, never for generation.
        selected = [
            {
                "number": i + 1,
                "text": lines[i][:2000],
                "truncated": len(lines[i]) > 2000,
            }
            for i in range(start - 1, end)
        ]
        return Response(
            {
                "id": str(item.pk),
                "parser_version": item.parser_version,
                "checksum": item.checksum,
                "lines": selected,
                "next_start": end + 1 if end < len(lines) else None,
                "line_count": item.line_count,
            }
        )

    @action(detail=True, methods=["post"])
    def retry(self, request, pk=None):
        self.require_enabled()
        key = self.request_key(request)
        with transaction.atomic():
            item = get_object_or_404(self.get_queryset().select_for_update(), pk=pk)
            if item.retry_key == key:
                return Response(self.get_serializer(item).data)
            if item.status != WorkMaterial.Status.FAILED:
                return Response({"code": "material_not_failed"}, status=409)
            if request.data.get("generation") != item.generation:
                return Response({"code": "stale_material"}, status=409)
            item.status = WorkMaterial.Status.UPLOADED
            item.error_code = ""
            item.retry_key = key
            item.save(update_fields=["status", "error_code", "retry_key", "updated_at"])
        return Response(self.get_serializer(item).data, status=202)

    def destroy(self, request, pk=None):
        with transaction.atomic():
            item = get_object_or_404(self.get_queryset().select_for_update(), pk=pk)
            item.deleted_at = timezone.now()
            item.text = ""
            item.line_count = 0
            item.generation += 1
            item.save(
                update_fields=[
                    "deleted_at",
                    "text",
                    "line_count",
                    "generation",
                    "updated_at",
                ]
            )
        return Response(status=status.HTTP_204_NO_CONTENT)
