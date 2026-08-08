"""Cross-device IM drafts, emoji preferences and organization emoji APIs."""

from __future__ import annotations

from rest_framework import permissions, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from core import models, utils
from core.api.admin_org import IsOrgAdmin
from core.api.directory import get_caller_organization


class DraftSerializer(serializers.ModelSerializer):
    class Meta:
        model = models.ImDraft
        fields = ("cid", "text", "reply", "updated_at")
        read_only_fields = ("cid", "updated_at")

    def validate_text(self, value):
        if len(value) > 4000:
            raise serializers.ValidationError("max 4000 Unicode characters")
        return value

    def validate_reply(self, value):
        if value is None:
            return None
        if not isinstance(value, dict):
            raise serializers.ValidationError("must be an object or null")
        allowed = {"mid", "sender", "summary"}
        if set(value) - allowed or not str(value.get("mid") or "").strip():
            raise serializers.ValidationError("mid is required; only sender/summary are allowed")
        return {
            "mid": str(value["mid"])[:64],
            "sender": str(value.get("sender") or "")[:128],
            "summary": str(value.get("summary") or "")[:256],
        }


class ImDraftViewSet(viewsets.ViewSet):
    permission_classes = [permissions.IsAuthenticated]
    lookup_value_regex = r"[^/]+"

    def list(self, request):
        drafts = models.ImDraft.objects.filter(user=request.user).exclude(
            text="", reply__isnull=True
        )
        return Response(DraftSerializer(drafts, many=True).data)

    def update(self, request, pk=None):
        cid = str(pk or "").strip()
        if not cid or len(cid) > 64:
            raise ValidationError({"cid": "invalid conversation id"})
        draft = models.ImDraft.objects.filter(user=request.user, cid=cid).first()
        serializer = DraftSerializer(draft, data=request.data or {})
        serializer.is_valid(raise_exception=True)
        text = serializer.validated_data.get("text", "")
        reply = serializer.validated_data.get("reply")
        if not text and reply is None:
            if draft:
                draft.delete()
            return Response(status=status.HTTP_204_NO_CONTENT)
        draft, _ = models.ImDraft.objects.update_or_create(
            user=request.user, cid=cid, defaults={"text": text, "reply": reply}
        )
        return Response(DraftSerializer(draft).data)

    def destroy(self, request, pk=None):
        models.ImDraft.objects.filter(user=request.user, cid=pk).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


def _serialize_emoji(item: models.OrganizationEmoji) -> dict:
    return {
        "id": str(item.id),
        "name": item.name,
        "key": item.object_key,
        "url": utils.generate_chat_object_get_url(item.object_key),
        "content_type": item.content_type,
        "width": item.width,
        "height": item.height,
        "animated": item.is_animated,
        "sort_order": item.sort_order,
        "active": item.is_active,
    }


def _normalize_recent(user, raw) -> list[dict]:
    if not isinstance(raw, list):
        raise ValidationError({"recent_emojis": "must be a list"})
    organization = get_caller_organization(user)
    custom_ids = {
        str(item.id): item
        for item in models.OrganizationEmoji.objects.filter(
            organization=organization, is_active=True
        )
    } if organization else {}
    result, seen = [], set()
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        kind = entry.get("kind")
        if kind == "unicode":
            value = str(entry.get("value") or "")
            if not value or len(value) > 16:
                continue
            normalized = {"kind": "unicode", "value": value}
            identity = (kind, value)
        elif kind == "custom":
            item = custom_ids.get(str(entry.get("id") or ""))
            if not item:
                continue
            normalized = {
                "kind": "custom", "id": str(item.id),
                "key": item.object_key, "name": item.name,
            }
            identity = (kind, str(item.id))
        else:
            continue
        if identity in seen:
            continue
        seen.add(identity)
        result.append(normalized)
        if len(result) == 24:
            break
    return result


class ImPreferenceView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        preference, _ = models.ImUserPreference.objects.get_or_create(user=request.user)
        recent = _normalize_recent(request.user, preference.recent_emojis)
        if recent != preference.recent_emojis:
            preference.recent_emojis = recent
            preference.save(update_fields=["recent_emojis", "updated_at"])
        return Response({"recent_emojis": recent, "updated_at": preference.updated_at})

    def patch(self, request):
        recent = _normalize_recent(request.user, (request.data or {}).get("recent_emojis"))
        preference, _ = models.ImUserPreference.objects.update_or_create(
            user=request.user, defaults={"recent_emojis": recent}
        )
        return Response({"recent_emojis": recent, "updated_at": preference.updated_at})


class ImCustomEmojiViewSet(viewsets.ViewSet):
    permission_classes = [permissions.IsAuthenticated]

    def list(self, request):
        organization = get_caller_organization(request.user)
        if not organization:
            return Response([])
        items = models.OrganizationEmoji.objects.filter(
            organization=organization, is_active=True
        )
        return Response([_serialize_emoji(item) for item in items])


class AdminImEmojiViewSet(viewsets.ViewSet):
    permission_classes = [IsOrgAdmin]

    def _organization(self):
        organization = get_caller_organization(self.request.user)
        if not organization:
            raise PermissionDenied("organization required")
        return organization

    def _item(self, pk):
        item = models.OrganizationEmoji.objects.filter(
            id=pk, organization=self._organization()
        ).first()
        if not item:
            raise ValidationError({"id": "emoji not found"})
        return item

    def list(self, request):
        return Response([
            _serialize_emoji(item)
            for item in models.OrganizationEmoji.objects.filter(
                organization=self._organization()
            )
        ])

    @action(detail=False, methods=["post"], url_path="upload-url")
    def upload_url(self, request):
        data = request.data or {}
        content_type, size = data.get("content_type"), data.get("size")
        if content_type not in utils.ALLOWED_CHAT_IMAGE_MIME_TYPES:
            raise ValidationError({"content_type": "must be jpeg/png/webp/gif"})
        if not isinstance(size, int) or size <= 0 or size > utils.MAX_CUSTOM_EMOJI_SIZE:
            raise ValidationError({"size": f"must be 1..{utils.MAX_CUSTOM_EMOJI_SIZE}"})
        return Response(utils.generate_custom_emoji_upload_url(
            organization_id=self._organization().id,
            content_type=content_type,
            size=size,
        ))

    def create(self, request):
        organization = self._organization()
        name = str((request.data or {}).get("name") or "").strip()
        key = str((request.data or {}).get("object_key") or "").strip()
        if not name or len(name) > 32:
            raise ValidationError({"name": "1..32 characters required"})
        if models.OrganizationEmoji.objects.filter(
            organization=organization, name__iexact=name
        ).exists():
            raise ValidationError({"name": "name already exists"})
        prefix = f"{utils.CUSTOM_EMOJI_KEY_PREFIX}{organization.id}/"
        if not key.startswith(prefix):
            raise ValidationError({"object_key": "not an upload for this organization"})
        if models.OrganizationEmoji.objects.filter(
            organization=organization, is_active=True
        ).count() >= 100:
            raise ValidationError({"detail": "maximum 100 active emojis"})
        metadata = utils.inspect_custom_emoji_object(key)
        if not metadata:
            raise ValidationError({"object_key": "invalid image, size or dimensions"})
        item = models.OrganizationEmoji.objects.create(
            organization=organization,
            name=name,
            object_key=key,
            sort_order=int((request.data or {}).get("sort_order") or 0),
            created_by=request.user,
            **metadata,
        )
        return Response(_serialize_emoji(item), status=status.HTTP_201_CREATED)

    def partial_update(self, request, pk=None):
        item = self._item(pk)
        data = request.data or {}
        if "name" in data:
            name = str(data["name"] or "").strip()
            if not name or len(name) > 32 or models.OrganizationEmoji.objects.filter(
                organization=item.organization, name__iexact=name
            ).exclude(id=item.id).exists():
                raise ValidationError({"name": "invalid or duplicate name"})
            item.name = name
        if "sort_order" in data:
            item.sort_order = max(0, int(data["sort_order"]))
        if "active" in data:
            active = bool(data["active"])
            if active and not item.is_active and models.OrganizationEmoji.objects.filter(
                organization=item.organization, is_active=True
            ).count() >= 100:
                raise ValidationError({"detail": "maximum 100 active emojis"})
            item.is_active = active
        item.save()
        return Response(_serialize_emoji(item))

    def destroy(self, request, pk=None):
        item = self._item(pk)
        item.is_active = False
        item.save(update_fields=["is_active", "updated_at"])
        return Response(status=status.HTTP_204_NO_CONTENT)
