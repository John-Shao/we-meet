"""API endpoints"""
# pylint: disable=too-many-lines

import json
import uuid
from logging import getLogger
from urllib.parse import unquote, urlparse

from django.conf import settings
from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.files.storage import default_storage
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.http import Http404, StreamingHttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.text import slugify
from django.utils.translation import gettext_lazy as _

from django_filters import rest_framework as django_filters
from rest_framework import (
    decorators,
    filters,
    mixins,
    pagination,
    viewsets,
)
from rest_framework import (
    exceptions as drf_exceptions,
)
from rest_framework import (
    renderers as drf_renderers,
)
from rest_framework import (
    response as drf_response,
)
from rest_framework import (
    status as drf_status,
)
from rest_framework.settings import api_settings

from core import enums, models, utils
from core.api.filters import ListFileFilter
from core.enums import MEDIA_STORAGE_URL_PATTERN
from core.recording.enums import FileExtension
from core.recording.event.authentication import StorageEventAuthentication
from core.recording.event.exceptions import (
    InvalidBucketError,
    InvalidFilepathError,
    InvalidFileTypeError,
    ParsingEventDataError,
)
from core.recording.event.notification import notification_service
from core.recording.event.parsers import get_parser
from core.recording.services.metadata_collector import (
    MetadataCollectorException,
    MetadataCollectorService,
)
from core.recording.worker.exceptions import (
    RecordingStartError,
    RecordingStopError,
)
from core.recording.worker.factories import (
    get_worker_service,
)
from core.recording.worker.mediator import (
    WorkerServiceMediator,
)
from core.services.deregistration import UserDeregistrationService
from core.services.invitation import InvitationService
from core.services.livekit_events import (
    LiveKitEventsService,
    LiveKitWebhookError,
)
from core.services.lobby import (
    LobbyParticipantNotFound,
    LobbyService,
)
from core.services.participants_management import (
    ParticipantNotFoundException,
    ParticipantsManagement,
    ParticipantsManagementException,
)
from core.services.room_creation import RoomCreation
from core.services.room_management import (
    RoomManagement,
    RoomManagementException,
    RoomNotFoundException,
)
from core.services.ai_agent import AIAgentException, AIAgentService
from core.services.room_ai import RoomAIService
from core.services.personal_ai import PersonalAIService
from core.services.embeddings import EmbeddingUnavailable
from core.services.llm_client import LLMUnavailable
from core.services.ai_agent_providers import (
    build_agent_metadata,
    get_ai_agent_config,
    resolve_profile_context,
    save_user_preference,
)
from core.services.subtitle import SubtitleException, SubtitleService
from core.tasks.file import process_file_deletion

from ..authentication.livekit import LiveKitTokenAuthentication
from . import permissions, serializers, throttling
from .feature_flag import FeatureFlag

# pylint: disable=too-many-ancestors

logger = getLogger(__name__)


class ServerSentEventRenderer(drf_renderers.BaseRenderer):
    """Content-negotiation shim for the SSE endpoints (Sprint 2.5).

    The frontend POSTs with ``Accept: text/event-stream``. DRF's default
    renderer set only declares ``application/json``, so content negotiation
    raised ``NotAcceptable`` (406) *before* the view body ran — meaning the
    ``StreamingHttpResponse`` never got a chance to stream. Declaring a
    renderer whose ``media_type`` matches lets negotiation succeed.

    The happy path returns a plain ``StreamingHttpResponse`` (Django, not
    DRF), so ``render`` is bypassed there. It only runs for DRF error
    responses (400 validation, 401/403 auth, 429 throttle); we JSON-encode
    those so the client's ``resp.json()`` fallback can read them.
    """

    media_type = "text/event-stream"
    format = "event-stream"
    charset = "utf-8"

    def render(self, data, accepted_media_type=None, renderer_context=None):
        if data is None:
            return b""
        if isinstance(data, bytes):
            return data
        if isinstance(data, str):
            return data.encode(self.charset)
        return json.dumps(data, ensure_ascii=False).encode(self.charset)


def _sse_response(event_iter, *, error_label: str) -> StreamingHttpResponse:
    """Wrap a service generator into an SSE ``StreamingHttpResponse``.

    Sprint 2.5 — used by both ``RoomViewSet.ask_ai_stream`` and
    ``UserViewSet.ask_personal_ai_stream``. The wrapper:

    * Serialises each yielded dict as ``data: <json>\\n\\n`` (the SSE wire
      format).
    * Catches any exception raised by the service mid-stream and emits a
      final ``error`` event so the client can render a friendly toast
      rather than dying on a half-truncated stream.
    * Sets ``X-Accel-Buffering: no`` so an nginx ingress in the path
      doesn't buffer up the chunks — critical for the "typewriter" UX.
    """

    def gen():
        try:
            for event in event_iter:
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception as exc:  # pylint: disable=broad-except
            logger.exception("%s stream failed", error_label)
            payload = {"type": "error", "message": f"{error_label} failed: {exc}"}
            yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

    resp = StreamingHttpResponse(gen(), content_type="text/event-stream")
    resp["Cache-Control"] = "no-cache"
    resp["X-Accel-Buffering"] = "no"
    return resp


class NestedGenericViewSet(viewsets.GenericViewSet):
    """
    A generic Viewset aims to be used in a nested route context.
    e.g: `/api/v1.0/resource_1/<resource_1_pk>/resource_2/<resource_2_pk>/`

    It allows to define all url kwargs and lookup fields to perform the lookup.
    """

    lookup_fields: list[str] = ["pk"]
    lookup_url_kwargs: list[str] = []

    def __getattribute__(self, file):
        """
        This method is overridden to allow to get the last lookup field or lookup url kwarg
        when accessing the `lookup_field` or `lookup_url_kwarg` attribute. This is useful
        to keep compatibility with all methods used by the parent class `GenericViewSet`.
        """
        if file in ["lookup_field", "lookup_url_kwarg"]:
            return getattr(self, file + "s", [None])[-1]

        return super().__getattribute__(file)

    def get_queryset(self):
        """
        Get the list of files for this view.

        `lookup_fields` attribute is enumerated here to perform the nested lookup.
        """
        queryset = super().get_queryset()

        # The last lookup field is removed to perform the nested lookup as it corresponds
        # to the object pk, it is used within get_object method.
        lookup_url_kwargs = (
            self.lookup_url_kwargs[:-1]
            if self.lookup_url_kwargs
            else self.lookup_fields[:-1]
        )

        filter_kwargs = {}
        for index, lookup_url_kwarg in enumerate(lookup_url_kwargs):
            if lookup_url_kwarg not in self.kwargs:
                raise KeyError(
                    f"Expected view {self.__class__.__name__} to be called with a URL "
                    f'keyword argument named "{lookup_url_kwarg}". Fix your URL conf, or '
                    "set the `.lookup_fields` attribute on the view correctly."
                )

            filter_kwargs.update(
                {self.lookup_fields[index]: self.kwargs[lookup_url_kwarg]}
            )

        return queryset.filter(**filter_kwargs)


class SerializerPerActionMixin:
    """
    A mixin to allow to define serializer classes for each action.

    This mixin is useful to avoid to define a serializer class for each action in the
    `get_serializer_class` method.
    """

    serializer_classes: dict[str, type] = {}
    default_serializer_class: type = None

    def get_serializer_class(self):
        """
        Return the serializer class to use depending on the action.
        """
        return self.serializer_classes.get(self.action, self.default_serializer_class)


class Pagination(pagination.PageNumberPagination):
    """Pagination to display no more than 100 objects per page sorted by creation date."""

    ordering = "-created_on"
    max_page_size = 100
    page_size_query_param = "page_size"


class UserViewSet(
    mixins.UpdateModelMixin, viewsets.GenericViewSet, mixins.ListModelMixin
):
    """User ViewSet"""

    permission_classes = [permissions.IsSelf]
    queryset = models.User.objects.all()
    serializer_class = serializers.UserSerializer

    def get_queryset(self):
        """
        Limit listed users by querying the email field with a trigram similarity
        search if a query is provided.
        Limit listed users by excluding users already in the document if a document_id
        is provided.
        """
        queryset = self.queryset

        if self.action == "list":
            if not settings.ALLOW_UNSECURE_USER_LISTING:
                return models.User.objects.none()

            # Filter users by email similarity
            if query := self.request.GET.get("q", ""):
                queryset = queryset.filter(email__trigram_word_similar=query)

        return queryset

    @decorators.action(
        detail=False,
        methods=["get"],
        url_name="me",
        url_path="me",
        permission_classes=[permissions.IsAuthenticated],
    )
    def get_me(self, request):
        """
        Return information on currently logged user
        """
        context = {"request": request}
        return drf_response.Response(
            self.serializer_class(request.user, context=context).data
        )

    @decorators.action(
        detail=False,
        methods=["post"],
        url_name="deregister",
        url_path="me/deregister",
        permission_classes=[permissions.IsAuthenticated],
    )
    def deregister(self, request):
        """Deregister (soft-delete and anonymize) the current user account."""
        UserDeregistrationService().deregister(request.user)
        return drf_response.Response(status=drf_status.HTTP_204_NO_CONTENT)

    # ------------------------------------------------------------------
    # Sprint 2.4 — Cross-meeting AI ("personal AI") RAG
    # ------------------------------------------------------------------

    @decorators.action(
        detail=False,
        methods=["post"],
        url_name="ask-personal-ai",
        url_path="me/ai/ask",
        permission_classes=[permissions.IsAuthenticated],
        throttle_classes=[throttling.PersonalAIRateThrottle],
    )
    def ask_personal_ai(self, request):
        """Answer one question against the user's accessible meetings.

        Body: ``{"question": "..."}``. The service strictly filters to
        rooms the current Django user is a member of and has a successful
        Summary for — no cross-user leakage. Single-turn; no history.
        """
        serializer = serializers.AskPersonalAISerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        question = serializer.validated_data["question"]

        try:
            result = PersonalAIService().ask(user=request.user, question=question)
        except (EmbeddingUnavailable, LLMUnavailable) as exc:
            return drf_response.Response(
                {"error": str(exc)},
                status=drf_status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        except Exception as exc:  # pylint: disable=broad-except
            logger.exception("personal ai failed for user %s", request.user.pk)
            return drf_response.Response(
                {"error": f"Personal AI failed: {exc}"},
                status=drf_status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        return drf_response.Response(result, status=drf_status.HTTP_200_OK)

    @decorators.action(
        detail=False,
        methods=["post"],
        url_name="ask-personal-ai-stream",
        url_path="me/ai/ask-stream",
        permission_classes=[permissions.IsAuthenticated],
        throttle_classes=[throttling.PersonalAIRateThrottle],
        renderer_classes=[ServerSentEventRenderer],
    )
    def ask_personal_ai_stream(self, request):
        """Streaming variant of :py:meth:`ask_personal_ai` (Sprint 2.5).

        Body: ``{"question": "...", "history": [{role, content}, ...]}``.
        Response: ``text/event-stream`` — see ``docs/features/streaming_chat.md``.
        Same privacy contract: every chunk that reaches the LLM context is
        filtered through ``PersonalAIService._user_room_ids``.
        """
        serializer = serializers.AskPersonalAIStreamSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        question = serializer.validated_data["question"]
        history = serializer.validated_data.get("history") or []

        event_iter = PersonalAIService().ask_stream(
            user=request.user, question=question, history=history
        )
        return _sse_response(event_iter, error_label="Personal AI")

    @decorators.action(
        detail=False,
        methods=["patch"],
        url_name="update-nickname",
        url_path="me/nickname",
        permission_classes=[permissions.IsAuthenticated],
    )
    def update_nickname(self, request):
        """Update the user's display nickname (Keycloak firstName).

        We deliberately do NOT use the Keycloak Account REST API here — it
        runs the realm's user-profile validators, and our SMS-registered
        users have blank ``lastName`` / ``email`` (both required by the
        ``user`` role), so any update via Account REST returns 400. Going
        through the Admin REST API with the service-account token bypasses
        that validation, which is what we want for "just change my display
        name" UX. The eager local sync keeps ``/users/me/`` consistent on
        the same session without waiting for the next OIDC userinfo cycle.

        Body: ``{"nickname": "<string>"}``.
        """
        # Local import to avoid the otherwise-circular reference at module
        # load time (mobile_auth imports nothing from viewsets, but importing
        # mobile_auth at the top of viewsets would still drag in DRF settings
        # before the view module is fully built — keep it lazy).
        # pylint: disable=import-outside-toplevel
        import requests

        from core.api.mobile_auth import (
            _admin_realm_url,
            _get_service_account_token,
        )

        nickname = (request.data.get("nickname") or "").strip()
        if not nickname:
            raise drf_exceptions.ValidationError(
                {"nickname": "Cannot be empty."}
            )
        if len(nickname) > 100:
            raise drf_exceptions.ValidationError(
                {"nickname": "Too long (max 100 chars)."}
            )

        user_sub = getattr(request.user, "sub", None)
        if not user_sub:
            return drf_response.Response(
                {"error": "Missing Keycloak subject on user"},
                status=drf_status.HTTP_400_BAD_REQUEST,
            )

        sa_token = _get_service_account_token()
        if not sa_token:
            return drf_response.Response(
                {"error": "服务暂时不可用，请稍后重试"},
                status=drf_status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        try:
            resp = requests.put(
                f"{_admin_realm_url()}/users/{user_sub}",
                json={"firstName": nickname},
                headers={
                    "Authorization": f"Bearer {sa_token}",
                    "Content-Type": "application/json",
                },
                timeout=10,
                verify=settings.OIDC_VERIFY_SSL,
            )
            resp.raise_for_status()
        except requests.RequestException:
            logger.exception(
                "Keycloak nickname update failed for user %s", user_sub
            )
            return drf_response.Response(
                {"error": "昵称更新失败，请稍后重试"},
                status=drf_status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        # Eagerly sync the Django row so the next /users/me/ on this session
        # reflects the change immediately. The OIDC backend will refresh from
        # userinfo on the next request anyway, but it would briefly serve
        # stale data otherwise.
        request.user.full_name = nickname
        request.user.save(update_fields=["full_name"])

        return drf_response.Response(
            self.serializer_class(request.user, context={"request": request}).data
        )

    @decorators.action(
        detail=False,
        methods=["post"],
        url_name="profile-upload-url",
        url_path="me/upload-url",
        permission_classes=[permissions.IsAuthenticated],
    )
    def request_profile_upload_url(self, request):
        """Issue a short-lived presigned PUT URL for an avatar / cover upload.

        Body: ``{"kind": "avatar"|"cover", "content_type": str, "size": int}``.
        """
        kind = request.data.get("kind")
        content_type = request.data.get("content_type")
        size = request.data.get("size")

        if kind not in utils.PROFILE_IMAGE_KIND_FIELDS:
            raise drf_exceptions.ValidationError(
                {"kind": "Must be 'avatar' or 'cover'."}
            )
        if content_type not in utils.ALLOWED_PROFILE_IMAGE_MIME_TYPES:
            raise drf_exceptions.ValidationError(
                {"content_type": "Unsupported MIME type."}
            )
        try:
            size = int(size)
        except (TypeError, ValueError) as exc:
            raise drf_exceptions.ValidationError(
                {"size": "Must be an integer."}
            ) from exc
        if size <= 0 or size > utils.MAX_PROFILE_IMAGE_SIZE:
            raise drf_exceptions.ValidationError(
                {
                    "size": f"Must be between 1 and "
                    f"{utils.MAX_PROFILE_IMAGE_SIZE} bytes."
                }
            )

        payload = utils.generate_profile_image_upload_url(
            user=request.user,
            kind=kind,
            content_type=content_type,
            size=size,
        )
        return drf_response.Response(payload)

    @decorators.action(
        detail=False,
        methods=["patch"],
        url_name="profile-image",
        url_path="me/profile-image",
        permission_classes=[permissions.IsAuthenticated],
    )
    def confirm_profile_image(self, request):
        """Persist a freshly-uploaded avatar / cover image URL on the user record.

        Body: ``{"kind": "avatar"|"cover", "object_key": str}``. Validates the
        object belongs to the caller's namespace and exists in storage with an
        allowed MIME type and size.
        """
        kind = request.data.get("kind")
        object_key = request.data.get("object_key")

        if kind not in utils.PROFILE_IMAGE_KIND_FIELDS:
            raise drf_exceptions.ValidationError(
                {"kind": "Must be 'avatar' or 'cover'."}
            )
        if not isinstance(object_key, str) or not object_key:
            raise drf_exceptions.ValidationError(
                {"object_key": "This field is required."}
            )

        # Object keys are scoped to the calling user's namespace.
        expected_prefix = f"{request.user.id}/"
        if not object_key.startswith(expected_prefix):
            raise drf_exceptions.ValidationError(
                {"object_key": "object_key does not belong to the current user."}
            )

        head = utils.head_profile_object(kind, object_key)
        if head is None:
            raise drf_exceptions.ValidationError(
                {"object_key": "Object not found in storage."}
            )
        size, content_type = head
        if size > utils.MAX_PROFILE_IMAGE_SIZE:
            raise drf_exceptions.ValidationError(
                {"object_key": "Uploaded object exceeds the 2 MiB limit."}
            )
        if (
            content_type
            and content_type not in utils.ALLOWED_PROFILE_IMAGE_MIME_TYPES
        ):
            raise drf_exceptions.ValidationError(
                {"object_key": "Uploaded object has an unsupported MIME type."}
            )

        field_name = utils.PROFILE_IMAGE_KIND_FIELDS[kind]
        old_key = getattr(request.user, field_name, "")

        setattr(request.user, field_name, object_key)
        request.user.save()

        if old_key and old_key != object_key:
            utils.delete_profile_object(kind, old_key)

        context = {"request": request}
        return drf_response.Response(
            self.serializer_class(request.user, context=context).data
        )


class RoomViewSet(
    mixins.CreateModelMixin,
    mixins.DestroyModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet,
):
    """
    API endpoints to access and perform actions on rooms.
    """

    pagination_class = Pagination
    permission_classes = [permissions.RoomPermissions]
    queryset = models.Room.objects.all()
    serializer_class = serializers.RoomSerializer

    def get_object(self):
        """Allow getting a room by its UUID or its numeric slug (meeting code)."""
        pk = self.kwargs["pk"]
        queryset = self.filter_queryset(self.get_queryset())
        try:
            uuid.UUID(pk)
        except ValueError:
            obj = get_object_or_404(queryset, slug=pk)
        else:
            obj = get_object_or_404(queryset, pk=pk)
        # May raise a permission denied
        self.check_object_permissions(self.request, obj)
        return obj

    def retrieve(self, request, *args, **kwargs):
        """
        Allow unregistered rooms when activated.
        For unregistered rooms we only return a null id and the livekit room and token.
        """
        try:
            instance = self.get_object()
        except Http404:
            if not settings.ALLOW_UNREGISTERED_ROOMS:
                raise
            slug = slugify(self.kwargs["pk"])
            username = request.query_params.get("username", None)
            data = {
                "id": None,
                "livekit": {
                    "url": settings.LIVEKIT_CONFIGURATION["url"],
                    "room": slug,
                    "token": utils.generate_token(
                        room=slug, user=request.user, username=username
                    ),
                },
            }
        else:
            data = self.get_serializer(instance).data

        return drf_response.Response(data)

    def list(self, request, *args, **kwargs):
        """Limit listed rooms to the ones related to the authenticated user."""
        user = self.request.user

        if user.is_authenticated:
            queryset = (
                self.filter_queryset(self.get_queryset()).filter(users=user).distinct()
            )
        else:
            queryset = self.get_queryset().none()

        page = self.paginate_queryset(queryset)
        if page is not None:
            serializer = self.get_serializer(page, many=True)
            return self.get_paginated_response(serializer.data)

        serializer = self.get_serializer(queryset, many=True)
        return drf_response.Response(serializer.data)

    def perform_create(self, serializer):
        """Set the current user as owner of the newly created room."""
        room = serializer.save()
        models.ResourceAccess.objects.create(
            resource=room,
            user=self.request.user,
            role=models.RoleChoices.OWNER,
        )

        if callback_id := self.request.data.get("callback_id"):
            RoomCreation().persist_callback_state(callback_id, room)

    def perform_update(self, serializer):
        """Persist the room update, then sync metadata to LiveKit."""

        old_configuration = serializer.instance.configuration
        old_access_level = serializer.instance.access_level

        room = serializer.save()

        if (
            room.configuration == old_configuration
            and room.access_level == old_access_level
        ):
            return

        metadata = {
            "configuration": room.configuration,
            "access_level": room.access_level,
        }

        try:
            RoomManagement().update_metadata(
                room_name=str(room.id),
                metadata=metadata,
            )
        except RoomNotFoundException:
            logger.info(
                "LiveKit room %s does not exist yet, skipping metadata sync",
                room.id,
            )
        except RoomManagementException:
            logger.warning(
                "Failed to sync metadata to LiveKit for room %s",
                room.id,
            )

    @decorators.action(
        detail=True,
        methods=["post"],
        url_path="start-recording",
        permission_classes=[
            permissions.HasPrivilegesOnRoom,
        ],
    )
    @FeatureFlag.require("recording")
    def start_room_recording(self, request, pk=None):  # pylint: disable=unused-argument
        """Start recording a room."""

        serializer = serializers.StartRecordingSerializer(data=request.data)

        if not serializer.is_valid():
            return drf_response.Response(
                {"detail": "Invalid request."}, status=drf_status.HTTP_400_BAD_REQUEST
            )

        mode = serializer.validated_data["mode"]
        options = serializer.validated_data.get("options")
        room = self.get_object()

        try:
            with transaction.atomic():
                recording = models.Recording.objects.create(
                    room=room,
                    mode=mode,
                    options=options.model_dump(exclude_none=True) if options else {},
                )
                models.RecordingAccess.objects.create(
                    user=self.request.user,
                    role=models.RoleChoices.OWNER,
                    recording=recording,
                )

        except (DjangoValidationError, IntegrityError):
            # DjangoValidationError covers the Python-level check (full_clean);
            # IntegrityError covers the race where two concurrent requests both
            # pass that check and the DB-level UNIQUE constraint catches the loser.
            return drf_response.Response(
                {"error": f"A recording is already in progress for room {room.slug}"},
                status=drf_status.HTTP_409_CONFLICT,
            )

        worker_service = get_worker_service(mode=recording.mode)
        worker_manager = WorkerServiceMediator(worker_service=worker_service)

        try:
            worker_manager.start(recording)
        except RecordingStartError:
            models.Recording.objects.filter(pk=recording.pk).update(
                status=models.RecordingStatusChoices.FAILED_TO_START
            )
            return drf_response.Response(
                {"error": f"Recording failed to start for room {room.slug}"},
                status=drf_status.HTTP_502_BAD_GATEWAY,
            )

        if settings.METADATA_COLLECTOR_ENABLED and (
            recording.options.get("collect_metadata", False)
        ):
            try:
                MetadataCollectorService().start(recording)
                logger.debug("Started MetadataCollectorService")
            except MetadataCollectorException:
                logger.warning("Failed to start MetadataCollectorService")

        return drf_response.Response(
            {"message": f"Recording successfully started for room {room.slug}"},
            status=drf_status.HTTP_201_CREATED,
        )

    @decorators.action(
        detail=True,
        methods=["post"],
        url_path="stop-recording",
        permission_classes=[
            permissions.HasPrivilegesOnRoom,
        ],
    )
    @FeatureFlag.require("recording")
    def stop_room_recording(self, request, pk=None):  # pylint: disable=unused-argument
        """Stop room recording."""

        room = self.get_object()

        try:
            recording = models.Recording.objects.get(
                room=room, status=models.RecordingStatusChoices.ACTIVE
            )
        except models.Recording.DoesNotExist as e:
            raise drf_exceptions.NotFound(
                "No active recording found for this room."
            ) from e

        worker_service = get_worker_service(mode=recording.mode)
        worker_manager = WorkerServiceMediator(worker_service=worker_service)

        try:
            worker_manager.stop(recording)
        except RecordingStopError:
            return drf_response.Response(
                {"error": f"Recording failed to stop for room {room.slug}"},
                status=drf_status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        return drf_response.Response(
            {"message": f"Recording stopped for room {room.slug}."}
        )

    @decorators.action(
        detail=True,
        methods=["post"],
        url_path="request-entry",
        permission_classes=[],
        throttle_classes=[
            throttling.RequestEntryAuthenticatedUserRateThrottle,
            throttling.RequestEntryAnonRateThrottle,
        ],
    )
    def request_entry(self, request, pk=None):  # pylint: disable=unused-argument
        """Request entry to a room"""

        serializer = serializers.RequestEntrySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        room = self.get_object()

        # A room ended by its owner can no longer be entered through the lobby.
        if room.is_ended:
            raise drf_exceptions.NotFound("This room has ended.")

        lobby_service = LobbyService()

        participant, livekit = lobby_service.request_entry(
            room=room,
            request=request,
            **serializer.validated_data,
        )
        response = drf_response.Response({**participant.to_dict(), "livekit": livekit})
        lobby_service.prepare_response(response, participant.id)

        return response

    @decorators.action(
        detail=True,
        methods=["post"],
        url_path="enter",
        permission_classes=[
            permissions.HasPrivilegesOnRoom,
        ],
    )
    def allow_participant_to_enter(self, request, pk=None):  # pylint: disable=unused-argument
        """Accept or deny a participant's entry request."""

        serializer = serializers.ParticipantEntrySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        room = self.get_object()

        if room.is_public:
            return drf_response.Response(
                {"message": "Room has no lobby system."},
                status=drf_status.HTTP_404_NOT_FOUND,
            )

        lobby_service = LobbyService()

        try:
            lobby_service.handle_participant_entry(
                room_id=room.id,
                participant_id=str(serializer.validated_data.get("participant_id")),
                allow_entry=serializer.validated_data.get("allow_entry"),
            )
            return drf_response.Response({"message": "Participant was updated."})

        except LobbyParticipantNotFound:
            return drf_response.Response(
                {"message": "Participant not found."},
                status=drf_status.HTTP_404_NOT_FOUND,
            )

    @decorators.action(
        detail=True,
        methods=["GET"],
        url_path="waiting-participants",
        permission_classes=[
            permissions.HasPrivilegesOnRoom,
        ],
    )
    def list_waiting_participants(self, request, pk=None):  # pylint: disable=unused-argument
        """List waiting participants."""
        room = self.get_object()

        if room.is_public:
            return drf_response.Response({"participants": []})

        lobby_service = LobbyService()

        participants = lobby_service.list_waiting_participants(room.id)
        return drf_response.Response({"participants": participants})

    @decorators.action(
        detail=False,
        methods=["post"],
        url_path="webhooks-livekit",
        permission_classes=[],
    )
    def webhooks_livekit(self, request):
        """Process webhooks from LiveKit."""

        livekit_events_service = LiveKitEventsService()

        try:
            livekit_events_service.receive(request)
            return drf_response.Response(
                {"status": "success"}, status=drf_status.HTTP_200_OK
            )
        except LiveKitWebhookError as e:
            status_code = getattr(e, "status_code", drf_status.HTTP_400_BAD_REQUEST)

            if status_code == drf_status.HTTP_500_INTERNAL_SERVER_ERROR:
                raise e

            return drf_response.Response({"status": "error"}, status=status_code)

    @decorators.action(
        detail=False,
        methods=["post"],
        url_path="creation-callback",
        permission_classes=[],
        throttle_classes=[throttling.CreationCallbackAnonRateThrottle],
    )
    def creation_callback(self, request):
        """Retrieve cached room data via an unauthenticated request with a unique ID.

        Designed for interoperability across iframes, popups, and other contexts,
        even on the same domain, bypassing browser security restrictions on direct communication.
        """

        serializer = serializers.CreationCallbackSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        room = RoomCreation().get_callback_state(
            callback_id=serializer.validated_data.get("callback_id")
        )

        return drf_response.Response(
            {"status": "success", "room": room}, status=drf_status.HTTP_200_OK
        )

    @decorators.action(
        detail=True,
        methods=["post"],
        url_path="invite",
        permission_classes=[
            permissions.HasPrivilegesOnRoom,
        ],
    )
    def invite(self, request, pk=None):  # pylint: disable=unused-argument
        """Send email invitations to join a room.

        This API endpoint allows a user with appropriate privileges to send email invitations
        to one or more recipients, inviting them to join the specified room.
        """

        room = self.get_object()

        serializer = serializers.RoomInviteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        emails = serializer.validated_data.get("emails")
        emails = list(set(emails))

        InvitationService().invite_to_room(
            room=room, sender=request.user, emails=emails
        )

        return drf_response.Response(
            {"status": "success", "message": "invitations sent"},
            status=drf_status.HTTP_200_OK,
        )

    @decorators.action(
        detail=True,
        methods=["post"],
        url_path="start-subtitle",
        permission_classes=[
            permissions.HasLiveKitRoomAccess,
        ],
        authentication_classes=[LiveKitTokenAuthentication],
    )
    @FeatureFlag.require("subtitle")
    def start_subtitle(self, request, pk=None):  # pylint: disable=unused-argument
        """Start realtime transcription for the room.

        Requires valid LiveKit token for room authorization.
        Anonymous users can start subtitles if they have room access tokens.
        """

        room = self.get_object()

        try:
            SubtitleService().start_subtitle(room)
        except SubtitleException:
            return drf_response.Response(
                {"error": f"Subtitles failed to start for room {room.slug}"},
                status=drf_status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        return drf_response.Response(
            {"status": "success"}, status=drf_status.HTTP_200_OK
        )

    # ------------------------------------------------------------------
    # Sprint 2.2.c — Meeting detail (summary / action items / transcripts)
    # ------------------------------------------------------------------

    @decorators.action(
        detail=False,
        methods=["get"],
        url_path="recent-meetings",
        permission_classes=[permissions.IsAuthenticated],
    )
    def recent_meetings(self, request):
        """List recent meetings (Rooms with a Summary) the user joined.

        Most-recent-first, capped at 20. Powers the "My recent meetings"
        section on the home page and links each entry to /meetings/<id>.
        """
        rooms = (
            self.get_queryset()
            .filter(users=request.user, summary__isnull=False)
            .distinct()
            .order_by("-summary__updated_at")[:20]
        )
        # Tiny shape — the home page only needs id / display label / when
        # the summary was last refreshed. Anything heavier loads on the
        # detail page itself.
        data = [
            {
                "id": str(room.id),
                "name": room.name,
                "slug": room.slug,
                "summary_updated_at": (
                    room.summary.updated_at.isoformat() if room.summary else None
                ),
                "summary_status": room.summary.status if room.summary else None,
            }
            for room in rooms
        ]
        return drf_response.Response(data)


    @decorators.action(
        detail=True,
        methods=["get"],
        url_path="summary",
    )
    def get_summary(self, request, pk=None):  # pylint: disable=unused-argument
        """Return the LLM-generated summary for this meeting, if any.

        404 means the meeting has no summary yet (room never ended, or
        summary generation never ran). Access control: any user who can
        retrieve the Room can retrieve its summary.
        """
        room = self.get_object()
        summary = getattr(room, "summary", None)
        if summary is None:
            raise drf_exceptions.NotFound("No summary for this meeting yet.")
        return drf_response.Response(serializers.SummarySerializer(summary).data)

    @decorators.action(
        detail=True,
        methods=["post"],
        url_path="summary/regenerate",
    )
    def regenerate_summary(self, request, pk=None):  # pylint: disable=unused-argument
        """Schedule a fresh summary generation for this meeting.

        Useful when the meeting ran longer than the auto-trigger window or
        the LLM produced a bad first pass. Returns immediately (202) — the
        actual generation is async via Celery (or synchronous fallback).
        """
        room = self.get_object()
        # Imported inline to avoid pulling celery in modules that don't
        # need it during management commands.
        from core.tasks.summary import generate_meeting_summary

        generate_meeting_summary.apply_async(args=[str(room.id)])
        return drf_response.Response(
            {"status": "scheduled"}, status=drf_status.HTTP_202_ACCEPTED
        )

    @decorators.action(
        detail=True,
        methods=["get"],
        url_path="action-items",
    )
    def get_action_items(self, request, pk=None):  # pylint: disable=unused-argument
        """List action items for this meeting."""
        room = self.get_object()
        items = room.action_items.all().order_by("sort_order", "created_at")
        return drf_response.Response(
            serializers.ActionItemSerializer(items, many=True).data
        )

    @decorators.action(
        detail=True,
        methods=["get"],
        url_path="transcripts",
    )
    def get_transcripts(self, request, pk=None):  # pylint: disable=unused-argument
        """List all FINAL transcripts for this meeting in time order."""
        room = self.get_object()
        rows = room.transcripts.all().order_by("started_at")
        return drf_response.Response(
            serializers.TranscriptSerializer(rows, many=True).data
        )

    @decorators.action(
        detail=False,
        methods=["get"],
        url_path="ai-agent-config",
        permission_classes=[],
    )
    def ai_agent_config(self, request):
        """Return the AI assistant catalog (profiles / voices / prompts).

        Public endpoint — the response contains no secrets, only choices
        the frontend needs to render the configuration panel. Default
        authentication still runs, so an authenticated user's stored
        ``UserAIPreference`` is included; anonymous callers see
        ``user_preference: null``.
        """
        return drf_response.Response(get_ai_agent_config(user=request.user))

    @decorators.action(
        detail=True,
        methods=["post"],
        url_path="start-ai-agent",
        permission_classes=[permissions.HasLiveKitRoomAccess],
        authentication_classes=[LiveKitTokenAuthentication],
    )
    def start_ai_agent(self, request, pk=None):  # pylint: disable=unused-argument
        """Dispatch the AI assistant agent into the room.

        Body: ``{"profile_code": "qwen", "voice_id": "<uuid>", "prompt_id": "<uuid>"}``.
        Voice and prompt fall back to the user's preference, then to the
        profile defaults. The full model catalog (endpoint / api_key_env /
        extra_config) is serialised into the agent metadata server-side so
        the worker never needs DB access.
        """
        room = self.get_object()

        serializer = serializers.StartAIAgentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        profile_code = serializer.validated_data["profile_code"]
        voice_id = serializer.validated_data.get("voice_id")
        prompt_id = serializer.validated_data.get("prompt_id")

        # LiveKit token identity authoritatively identifies the requester;
        # request.user comes from the Django session and is what we use
        # for persisting their preference.
        requester_identity = getattr(request.auth, "identity", "") or ""

        profile, voice, prompt = resolve_profile_context(
            profile_code=profile_code,
            voice_id=str(voice_id) if voice_id else None,
            prompt_id=str(prompt_id) if prompt_id else None,
            user=request.user,
        )
        if profile is None:
            return drf_response.Response(
                {"error": f"AI agent profile '{profile_code}' is not available."},
                status=drf_status.HTTP_400_BAD_REQUEST,
            )

        save_user_preference(
            user=request.user,
            profile_code=profile_code,
            voice_id=str(voice.id) if voice else None,
            prompt_id=str(prompt.id) if prompt else None,
        )

        metadata = build_agent_metadata(
            profile=profile,
            voice=voice,
            prompt=prompt,
            requester_identity=requester_identity,
        )

        try:
            AIAgentService().start_ai_agent(room=room, metadata=metadata)
        except AIAgentException as exc:
            return drf_response.Response(
                {"error": str(exc)},
                status=drf_status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        return drf_response.Response(
            {
                "status": "success",
                "profile_code": profile_code,
                "voice_id": str(voice.id) if voice else None,
                "prompt_id": str(prompt.id) if prompt else None,
            },
            status=drf_status.HTTP_200_OK,
        )

    @decorators.action(
        detail=True,
        methods=["post"],
        url_path="stop-ai-agent",
        permission_classes=[permissions.HasLiveKitRoomAccess],
        authentication_classes=[LiveKitTokenAuthentication],
    )
    def stop_ai_agent(self, request, pk=None):  # pylint: disable=unused-argument
        """Remove the AI assistant agent from the room."""
        room = self.get_object()

        try:
            AIAgentService().stop_ai_agent(room=room)
        except AIAgentException as exc:
            return drf_response.Response(
                {"error": str(exc)},
                status=drf_status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        return drf_response.Response(
            {"status": "success"}, status=drf_status.HTTP_200_OK
        )

    # ------------------------------------------------------------------
    # Sprint 2.3 — Room sidebar AI (single-turn QA over live transcripts)
    # ------------------------------------------------------------------

    @decorators.action(
        detail=True,
        methods=["post"],
        url_path="ask-ai",
        permission_classes=[permissions.HasLiveKitRoomAccess],
        authentication_classes=[LiveKitTokenAuthentication],
        throttle_classes=[throttling.RoomAIRateThrottle],
    )
    def ask_ai(self, request, pk=None):  # pylint: disable=unused-argument
        """Answer one question about the current meeting using its transcripts.

        Body: ``{"question": "..."}``. The auth chain proves the caller's
        LiveKit token was minted for this very room (``HasLiveKitRoomAccess``),
        so only live participants reach this code path. Single-turn — no
        history persisted; the frontend manages conversation state.
        """
        room = self.get_object()

        serializer = serializers.AskAISerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        question = serializer.validated_data["question"]

        try:
            result = RoomAIService().ask(room=room, question=question)
        except LLMUnavailable as exc:
            return drf_response.Response(
                {"error": str(exc)},
                status=drf_status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        except Exception as exc:  # pylint: disable=broad-except
            logger.exception("room ai failed for room %s", room.id)
            return drf_response.Response(
                {"error": f"Room AI failed: {exc}"},
                status=drf_status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        return drf_response.Response(result, status=drf_status.HTTP_200_OK)

    @decorators.action(
        detail=True,
        methods=["post"],
        url_path="ask-ai-stream",
        permission_classes=[permissions.HasLiveKitRoomAccess],
        authentication_classes=[LiveKitTokenAuthentication],
        throttle_classes=[throttling.RoomAIRateThrottle],
        renderer_classes=[ServerSentEventRenderer],
    )
    def ask_ai_stream(self, request, pk=None):  # pylint: disable=unused-argument
        """Streaming variant of :py:meth:`ask_ai` (Sprint 2.5).

        Body: ``{"question": "...", "history": [{role, content}, ...]}``.
        Response is ``text/event-stream``; see ``docs/features/streaming_chat.md``
        for the event sequence. Same auth / throttle as the non-streaming
        path so a single SSE connection still counts as one rate-limit hit.
        """
        room = self.get_object()

        serializer = serializers.AskAIStreamSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        question = serializer.validated_data["question"]
        history = serializer.validated_data.get("history") or []

        # ``ask_stream`` is a generator — its body (LLM init, RAG retrieval)
        # only runs once the SSE wrapper starts iterating, so any
        # ``LLMUnavailable`` lands inside ``_sse_response`` as an ``error``
        # event rather than a synchronous 503. UX-wise that's fine: the
        # frontend treats either path as "show toast, leave assistant
        # bubble in interrupted state".
        event_iter = RoomAIService().ask_stream(
            room=room, question=question, history=history
        )
        return _sse_response(event_iter, error_label="Room AI")

    @decorators.action(
        detail=True,
        methods=["post"],
        url_path="mute-participant",
        url_name="mute-participant",
        permission_classes=[permissions.CanMuteParticipant],
        authentication_classes=[
            LiveKitTokenAuthentication,
            *api_settings.DEFAULT_AUTHENTICATION_CLASSES,
        ],
    )
    def mute_participant(self, request, pk=None):  # pylint: disable=unused-argument
        """Mute a specific track for a participant in the room."""
        room = self.get_object()

        serializer = serializers.MuteParticipantSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        # TEMPORARY: a LiveKit token proves access was granted, not that the caller
        # joined. Cross-check identity against the live participant list until auth
        # is hardened. Skipped for non-LiveKit auth backends.
        caller_identity = getattr(request.auth, "identity", None)
        if caller_identity is not None:
            try:
                ParticipantsManagement().check_if_in_meeting(
                    room_name=str(room.pk),
                    identity=caller_identity,
                )
            except (ParticipantNotFoundException, ParticipantsManagementException):
                logger.warning(
                    "Failed to verify caller presence for mute in room %s; denying",
                    room.pk,
                )
                return drf_response.Response(
                    {"error": "Could not verify caller presence"},
                    status=drf_status.HTTP_403_FORBIDDEN,
                )

        try:
            ParticipantsManagement().mute(
                room_name=str(room.pk),
                identity=str(serializer.validated_data["participant_identity"]),
                track_sid=serializer.validated_data["track_sid"],
            )
        except ParticipantNotFoundException:
            return drf_response.Response(
                {"error": "Participant not found"},
                status=drf_status.HTTP_404_NOT_FOUND,
            )
        except ParticipantsManagementException:
            return drf_response.Response(
                {"error": "Failed to mute participant"},
                status=drf_status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        return drf_response.Response(
            {
                "status": "success",
            },
            status=drf_status.HTTP_200_OK,
        )

    @decorators.action(
        detail=True,
        methods=["post"],
        url_path="update-participant",
        url_name="update-participant",
        permission_classes=[permissions.HasPrivilegesOnRoom],
    )
    def update_participant(self, request, pk=None):  # pylint: disable=unused-argument
        """Update participant attributes, permissions, or metadata."""
        room = self.get_object()

        serializer = serializers.UpdateParticipantSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        permission = serializer.validated_data.get("permission")

        try:
            ParticipantsManagement().update(
                room_name=str(room.pk),
                identity=str(serializer.validated_data["participant_identity"]),
                metadata=serializer.validated_data.get("metadata"),
                attributes=serializer.validated_data.get("attributes"),
                permission=permission.model_dump() if permission else None,
                name=serializer.validated_data.get("name"),
            )
        except ParticipantNotFoundException:
            return drf_response.Response(
                {"error": "Participant not found"},
                status=drf_status.HTTP_404_NOT_FOUND,
            )
        except ParticipantsManagementException:
            return drf_response.Response(
                {"error": "Failed to update participant"},
                status=drf_status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        return drf_response.Response(
            {
                "status": "success",
            },
            status=drf_status.HTTP_200_OK,
        )

    @decorators.action(
        detail=True,
        methods=["post"],
        url_path="remove-participant",
        url_name="remove-participant",
        permission_classes=[permissions.HasPrivilegesOnRoom],
    )
    def remove_participant(self, request, pk=None):  # pylint: disable=unused-argument
        """Remove a participant from the room."""
        room = self.get_object()

        serializer = serializers.BaseParticipantsManagementSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        try:
            ParticipantsManagement().remove(
                room_name=str(room.pk),
                identity=str(serializer.validated_data["participant_identity"]),
            )
        except ParticipantNotFoundException:
            return drf_response.Response(
                {"error": "Participant not found"},
                status=drf_status.HTTP_404_NOT_FOUND,
            )
        except ParticipantsManagementException:
            return drf_response.Response(
                {"error": "Failed to remove participant"},
                status=drf_status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        return drf_response.Response(
            {"status": "success"}, status=drf_status.HTTP_200_OK
        )

    @decorators.action(
        detail=True,
        methods=["post"],
        url_path="toggle-hand",
        url_name="toggle-hand",
        permission_classes=[permissions.HasLiveKitRoomAccess],
        authentication_classes=[LiveKitTokenAuthentication],
    )
    def toggle_hand(self, request, pk=None):  # pylint: disable=unused-argument
        """Raise or lower the current participant's hand in the room."""
        room = self.get_object()

        serializer = serializers.RaiseHandSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        identity = request.auth.identity

        # LiveKit uses the handRaisedAt participant attribute to signal hand state.
        # An empty string means the hand is lowered; a non-empty ISO 8601 timestamp
        # means the hand is raised. The timestamp is used by clients to determine
        # the order in which participants raised their hands.
        hand_raised_at = (
            timezone.now().isoformat() if serializer.validated_data["raised"] else ""
        )

        try:
            ParticipantsManagement().update(
                room_name=str(room.pk),
                identity=identity,
                attributes={"handRaisedAt": hand_raised_at},
            )
        except ParticipantNotFoundException:
            return drf_response.Response(
                {"error": "Participant not found"},
                status=drf_status.HTTP_404_NOT_FOUND,
            )
        except ParticipantsManagementException:
            return drf_response.Response(
                {"error": "Failed to update participant hand state"},
                status=drf_status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        return drf_response.Response(
            {"status": "success"},
            status=drf_status.HTTP_200_OK,
        )

    @decorators.action(
        detail=True,
        methods=["post"],
        url_path="rename",
        url_name="rename",
        permission_classes=[permissions.HasLiveKitRoomAccess],
        authentication_classes=[LiveKitTokenAuthentication],
    )
    def rename(self, request, pk=None):  # pylint: disable=unused-argument
        """Rename the current participant in the room."""
        room = self.get_object()

        serializer = serializers.RenameParticipantSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        identity = request.auth.identity

        try:
            ParticipantsManagement().update(
                room_name=str(room.pk),
                identity=identity,
                name=serializer.validated_data["name"],
            )
        except ParticipantNotFoundException:
            return drf_response.Response(
                {"error": "Participant not found"},
                status=drf_status.HTTP_404_NOT_FOUND,
            )
        except ParticipantsManagementException:
            return drf_response.Response(
                {"error": "Failed to rename participant"},
                status=drf_status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        return drf_response.Response(
            {"status": "success"},
            status=drf_status.HTTP_200_OK,
        )

    @decorators.action(
        detail=True,
        methods=["post"],
        url_path="end",
        url_name="end",
        permission_classes=[permissions.HasPrivilegesOnRoom],
    )
    def end(self, request, pk=None):  # pylint: disable=unused-argument
        """End the room: kick all participants and record the end time.

        Owner-only. Once ended, the room can no longer be joined: RoomSerializer
        stops issuing LiveKit tokens for ended rooms.
        """
        room = self.get_object()

        if not room.is_owner(request.user):
            return drf_response.Response(
                {"detail": "Only the room owner can end the room."},
                status=drf_status.HTTP_403_FORBIDDEN,
            )

        if room.is_ended:
            return drf_response.Response(
                {"error": "Room is already ended."},
                status=drf_status.HTTP_400_BAD_REQUEST,
            )

        ended_at = timezone.now()
        models.Room.objects.filter(pk=room.pk).update(ended_at=ended_at)

        try:
            ParticipantsManagement().remove_all(room_name=str(room.pk))
        except ParticipantsManagementException:
            logger.warning(
                "Failed to remove all participants while ending room %s", room.pk
            )

        return drf_response.Response(
            {"status": "success", "ended_at": ended_at.isoformat()},
            status=drf_status.HTTP_200_OK,
        )


class ResourceAccessViewSet(
    mixins.CreateModelMixin,
    mixins.DestroyModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    mixins.ListModelMixin,
    viewsets.GenericViewSet,
):
    """
    API endpoints to access and perform actions on resource accesses.
    """

    permission_classes = [permissions.ResourceAccessPermission]
    queryset = models.ResourceAccess.objects.all()
    serializer_class = serializers.ResourceAccessSerializer

    def get_queryset(self):
        """Return the queryset according to the action."""

        queryset = super().get_queryset()

        # Restrict access to resources the user either has explicit
        # permissions for or administrative privileges over.
        if self.action == "list":
            user = self.request.user
            queryset = queryset.filter(
                Q(resource__accesses__user=user),
                resource__accesses__role__in=[
                    models.RoleChoices.ADMIN,
                    models.RoleChoices.OWNER,
                ],
            ).distinct()

        return queryset


class RecordingViewSet(
    mixins.DestroyModelMixin,
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    viewsets.GenericViewSet,
):
    """
    API endpoints to access and perform actions on recordings.
    """

    pagination_class = Pagination
    permission_classes = [permissions.HasAbilityPermission]
    queryset = models.Recording.objects.all()
    serializer_class = serializers.RecordingSerializer

    def get_queryset(self):
        """Restrict recordings to the user's ones."""
        user = self.request.user
        return (
            super()
            .get_queryset()
            .filter(Q(accesses__user=user) | Q(accesses__team__in=user.get_teams()))
        )

    @decorators.action(
        detail=False,
        methods=["post"],
        url_path="storage-hook",
        authentication_classes=[StorageEventAuthentication],
    )
    @FeatureFlag.require("storage_event")
    def on_storage_event_received(self, request, pk=None):  # pylint: disable=unused-argument
        """Handle incoming storage hook events for recordings."""

        parser = get_parser()

        try:
            recording_id = parser.get_recording_id(request.data)

        except ParsingEventDataError as e:
            raise drf_exceptions.PermissionDenied("Invalid request data.") from e

        except InvalidBucketError as e:
            raise drf_exceptions.PermissionDenied("Invalid bucket specified.") from e

        except InvalidFilepathError:
            return drf_response.Response(
                {"message": "Notification ignored."},
            )

        except InvalidFileTypeError:
            return drf_response.Response(
                {"message": "Notification ignored."},
            )

        try:
            recording = models.Recording.objects.get(id=recording_id)
        except models.Recording.DoesNotExist as e:
            raise drf_exceptions.NotFound("No recording found for this event.") from e

        if not recording.is_savable():
            raise drf_exceptions.PermissionDenied(
                f"Recording with ID {recording_id} cannot be saved because it is either,"
                " in an error state or has already been saved."
            )

        # Attempt to notify external services about the recording
        # This is a non-blocking operation - failures are logged but don't interrupt the flow
        notification_succeeded = notification_service.notify_external_services(
            recording
        )

        recording.status = (
            models.RecordingStatusChoices.NOTIFICATION_SUCCEEDED
            if notification_succeeded
            else models.RecordingStatusChoices.SAVED
        )
        recording.save()

        return drf_response.Response(
            {"message": "Event processed."},
        )

    def _auth_get_original_url(self, request):
        """
        Extracts and parses the original URL from the "HTTP_X_ORIGINAL_URL" header.
        Raises PermissionDenied if the header is missing.
        The original url is passed by nginx in the "HTTP_X_ORIGINAL_URL" header.
        See corresponding ingress configuration in Helm chart and read about the
        nginx.ingress.kubernetes.io/auth-url annotation to understand how the Nginx ingress
        is configured to do this.
        Based on the original url and the logged-in user, we must decide if we authorize Nginx
        to let this request go through (by returning a 200 code) or if we block it (by returning
        a 403 error). Note that we return 403 errors without any further details for security
        reasons.
        """
        # Extract the original URL from the request header
        original_url = request.META.get("HTTP_X_ORIGINAL_URL")
        if not original_url:
            logger.warning("Missing HTTP_X_ORIGINAL_URL header in subrequest")
            raise drf_exceptions.PermissionDenied()

        logger.debug("Original url: '%s'", original_url)
        return urlparse(original_url)

    def _auth_get_url_params(self, pattern, fragment):
        """
        Extracts URL parameters from the given fragment using the specified regex pattern.
        Raises PermissionDenied if parameters cannot be extracted.
        """

        match = pattern.search(fragment)

        try:
            return match.groupdict()
        except (ValueError, AttributeError) as exc:
            logger.warning("Failed to extract parameters from subrequest URL: %s", exc)
            raise drf_exceptions.PermissionDenied() from exc

    @decorators.action(detail=False, methods=["get"], url_path="media-auth")
    def media_auth(self, request, *args, **kwargs):
        """
        This view is used by an Nginx subrequest to control access to a recording's
        media file.
        When we let the request go through, we compute authorization headers that will be added to
        the request going through thanks to the nginx.ingress.kubernetes.io/auth-response-headers
        annotation. The request will then be proxied to the object storage backend who will
        respond with the file after checking the signature included in headers.
        """

        parsed_url = self._auth_get_original_url(request)

        url_params = self._auth_get_url_params(
            enums.RECORDING_STORAGE_URL_PATTERN, parsed_url.path
        )

        user = request.user
        recording_id = url_params["recording_id"]

        extension = url_params["extension"]
        if extension not in [file.value for file in FileExtension]:
            raise drf_exceptions.ValidationError({"detail": "Unsupported extension."})

        try:
            recording = models.Recording.objects.get(id=recording_id)
        except models.Recording.DoesNotExist as e:
            raise drf_exceptions.NotFound("No recording found for this event.") from e

        if extension != recording.extension:
            raise drf_exceptions.NotFound("No recording found with this extension.")

        abilities = recording.get_abilities(user)

        if not abilities["retrieve"]:
            logger.debug("User '%s' lacks permission for attachment", user.id)
            raise drf_exceptions.PermissionDenied()

        if not recording.is_saved:
            logger.debug("Recording '%s' has not been saved", recording)
            raise drf_exceptions.PermissionDenied()

        request = utils.generate_s3_authorization_headers(recording.key)

        return drf_response.Response("authorized", headers=request.headers, status=200)


# pylint: disable=too-many-public-methods
class FileViewSet(
    SerializerPerActionMixin,
    mixins.CreateModelMixin,
    mixins.DestroyModelMixin,
    mixins.UpdateModelMixin,
    mixins.ListModelMixin,
    viewsets.GenericViewSet,
):
    """
    FileViewSet API.

    This viewset provides CRUD operations and additional actions for managing files.

    ### API Endpoints:
    1. **List**: Retrieve a paginated list of files.
       Example: GET /files/?page=2
    2. **Retrieve**: Get a specific file by its ID.
       Example: GET /files/{id}/
    3. **Create**: Create a new file.
       Example: POST /files/
    4. **Update**: Update a file by its ID.
       Example: PUT /files/{id}/
    5. **Delete**: Soft delete a file by its ID.
       Example: DELETE /files/{id}/


    ### Ordering: created_at, updated_at, title

        Example:
        - Ascending: GET /api/v1.0/files/?ordering=created_at

    ### Filtering:
        - `is_creator_me=true`: Returns files created by the current user.
        - `is_creator_me=false`: Returns files created by other users.
        - `is_deleted=false`: Returns files that are not (soft) deleted

        Example:
        - GET /api/v1.0/files/?is_creator_me=true
        - GET /api/v1.0/files/?is_creator_me=false&is_deleted=false

    ### Notes:
    - Implements soft delete logic to retain file
    """

    ordering = ["-updated_at"]
    ordering_fields = ["created_at", "updated_at", "title"]
    pagination_class = Pagination
    permission_classes = [
        permissions.FilePermission,
    ]
    queryset = models.File.objects.filter(hard_deleted_at__isnull=True)
    default_serializer_class = serializers.FileSerializer
    serializer_classes = {
        "list": serializers.ListFileSerializer,
        "create": serializers.CreateFileSerializer,
    }
    filter_backends = (django_filters.DjangoFilterBackend, filters.OrderingFilter)
    filterset_class = ListFileFilter

    def get_queryset(self):
        """Get queryset that defaults to the current request user."""
        user = self.request.user
        queryset = super().get_queryset().select_related("creator")

        if not user.is_authenticated:
            return queryset.none()

        # For now, we force the filtering on the current user in all cases, might evolve later
        queryset = queryset.filter(creator=user)
        return queryset

    def get_response_for_queryset(self, queryset, context=None):
        """Return paginated response for the queryset if requested."""
        context = context or self.get_serializer_context()
        page = self.paginate_queryset(queryset)
        if page is not None:
            serializer = self.get_serializer(page, many=True, context=context)
            result = self.get_paginated_response(serializer.data)
            return result

        serializer = self.get_serializer(queryset, many=True, context=context)
        return drf_response.Response(serializer.data)

    def perform_create(self, serializer):
        """Set the current user as creator of the newly created file."""

        if settings.FILE_UPLOAD_APPLY_RESTRICTIONS:
            file_type = serializer.validated_data["type"]
            config_for_file_type = settings.FILE_UPLOAD_RESTRICTIONS[file_type]

            count = models.File.objects.filter(
                creator=self.request.user,
                deleted_at__isnull=True,
                type=file_type,
            ).count()

            if count >= config_for_file_type["max_count_by_user"]:
                logger.info(
                    "create_item: user reached max files per user for type %s",
                    file_type,
                )
                raise serializers.PermissionDenied(
                    _("You have reached the maximum number of files for this type.")
                )

        serializer.save(creator=self.request.user)

    def perform_destroy(self, instance):
        """Override to implement a soft delete instead of dumping the record in database."""
        instance.soft_delete()

    @decorators.action(detail=True, methods=["post"], url_path="upload-ended")
    @FeatureFlag.require("file_upload")
    def upload_ended(self, request, *args, **kwargs):
        """
        Check the actual uploaded file and mark it as ready.
        """

        file = self.get_object()

        if not file.is_pending_upload:
            raise drf_exceptions.ValidationError(
                {"file": "This action is only available for files in PENDING state."},
                code="file_upload_state_not_pending",
            )

        s3_client = default_storage.connection.meta.client

        head_response = s3_client.head_object(
            Bucket=default_storage.bucket_name, Key=file.file_key
        )
        file_size = head_response["ContentLength"]

        if settings.FILE_UPLOAD_APPLY_RESTRICTIONS:
            config_for_file_type = settings.FILE_UPLOAD_RESTRICTIONS[file.type]
            if file_size > config_for_file_type["max_size"]:
                self._complete_file_deletion(file)
                logger.info(
                    "upload_ended: file size (%s) for file %s higher than the allowed max size",
                    file_size,
                    file.file_key,
                )
                raise drf_exceptions.ValidationError(
                    detail="The file size is higher than the allowed max size.",
                    code="file_size_exceeded",
                )

        # python-magic recommends using at least the first 2048 bytes
        # to reduce incorrect identification.
        # This is a tradeoff between pulling in the whole file and the most likely relevant bytes
        # of the file for mime type identification.
        if file_size > 2048:
            range_response = s3_client.get_object(
                Bucket=default_storage.bucket_name,
                Key=file.file_key,
                Range="bytes=0-2047",
            )
            file_head = range_response["Body"].read()
        else:
            file_head = s3_client.get_object(
                Bucket=default_storage.bucket_name, Key=file.file_key
            )["Body"].read()

        # Use improved MIME type detection combining magic bytes and file extension
        logger.info("upload_ended: detecting mimetype for file: %s", file.file_key)
        mimetype = utils.detect_mimetype(file_head, filename=file.filename)

        if settings.FILE_UPLOAD_APPLY_RESTRICTIONS:
            config_for_file_type = settings.FILE_UPLOAD_RESTRICTIONS[file.type]
            allowed_file_mimetypes = config_for_file_type["allowed_mimetypes"]
            if mimetype not in allowed_file_mimetypes:
                self._complete_file_deletion(file)
                logger.warning(
                    "upload_ended: mimetype not allowed %s for file %s",
                    mimetype,
                    file.file_key,
                )
                raise drf_exceptions.ValidationError(
                    detail="The file type is not allowed.",
                    code="file_type_not_allowed",
                )

        file.upload_state = models.FileUploadStateChoices.READY
        file.mimetype = mimetype
        file.size = file_size

        file.save(update_fields=["upload_state", "mimetype", "size"])

        if head_response["ContentType"] != mimetype:
            logger.info(
                "upload_ended: content type mismatch between object storage and file,"
                " updating from %s to %s",
                head_response["ContentType"],
                mimetype,
            )
            s3_client.copy_object(
                Bucket=default_storage.bucket_name,
                Key=file.file_key,
                CopySource={
                    "Bucket": default_storage.bucket_name,
                    "Key": file.file_key,
                },
                ContentType=mimetype,
                Metadata=head_response["Metadata"],
                MetadataDirective="REPLACE",
            )

        # Not yet implemented
        # Change the file.upload_state when this will be done
        # malware_detection.analyse_file(file.file_key, file_id=file.id)

        serializer = self.get_serializer(file)

        return drf_response.Response(serializer.data, status=drf_status.HTTP_200_OK)

    def _complete_file_deletion(self, file):
        """Delete a file completely."""
        file.soft_delete()
        file.hard_delete()
        process_file_deletion.delay(file.id)

    def _authorize_subrequest(self, request, pattern):
        """
        Authorize access based on the original URL of an Nginx subrequest
        and user permissions. Returns a dictionary of URL parameters if authorized.

        The original url is passed by nginx in the "HTTP_X_ORIGINAL_URL" header.
        See corresponding ingress configuration in Helm chart and read about the
        nginx.ingress.kubernetes.io/auth-url annotation to understand how the Nginx ingress
        is configured to do this.

        Based on the original url and the logged in user, we must decide if we authorize Nginx
        to let this request go through (by returning a 200 code) or if we block it (by returning
        a 403 error). Note that we return 403 errors without any further details for security
        reasons.

        Parameters:
        - pattern: The regex pattern to extract identifiers from the URL.

        Returns:
        - A dictionary of URL parameters if the request is authorized.
        Raises:
        - PermissionDenied if authorization fails.
        """
        # Extract the original URL from the request header
        original_url = request.META.get("HTTP_X_ORIGINAL_URL")
        if not original_url:
            logger.warning("Missing HTTP_X_ORIGINAL_URL header in subrequest")
            raise drf_exceptions.PermissionDenied()

        parsed_url = urlparse(original_url)
        match = pattern.search(unquote(parsed_url.path))

        if not match:
            logger.warning(
                "Subrequest URL '%s' did not match pattern '%s'",
                parsed_url.path,
                pattern,
            )
            raise drf_exceptions.PermissionDenied()

        try:
            url_params = match.groupdict()
        except (ValueError, AttributeError) as exc:
            logger.warning("Failed to extract parameters from subrequest URL: %s", exc)
            raise drf_exceptions.PermissionDenied() from exc

        pk = url_params.get("pk")
        if not pk:
            logger.warning("File ID (pk) not found in URL parameters: %s", url_params)
            raise drf_exceptions.PermissionDenied()

        # Fetch the file and check if the user has access
        queryset = models.File.objects.all()
        # No suspicious analysis implemented yet
        # queryset = self._filter_suspicious_files(queryset, request.user)
        try:
            file = queryset.get(pk=pk)
        except models.File.DoesNotExist as exc:
            logger.warning("File with ID '%s' does not exist", pk)
            raise drf_exceptions.PermissionDenied() from exc

        user_abilities = file.get_abilities(request.user)
        if not user_abilities.get(self.action, False):
            logger.warning(
                "User '%s' lacks permission for file '%s'", request.user.id, pk
            )
            raise drf_exceptions.PermissionDenied()

        logger.debug(
            "Subrequest authorization successful. Extracted parameters: %s", url_params
        )
        return url_params, request.user.id, file

    @decorators.action(detail=False, methods=["get"], url_path="media-auth")
    @FeatureFlag.require("file_upload")
    def media_auth(self, request, *args, **kwargs):
        """
        This view is used by an Nginx subrequest to control access to an file's
        attachment file.

        When we let the request go through, we compute authorization headers that will be added to
        the request going through thanks to the nginx.ingress.kubernetes.io/auth-response-headers
        annotation. The request will then be proxied to the object storage backend who will
        respond with the file after checking the signature included in headers.
        """
        url_params, _, file = self._authorize_subrequest(
            request, MEDIA_STORAGE_URL_PATTERN
        )

        if file.is_pending_upload:
            logger.warning("File '%s' is not ready", file.id)
            raise drf_exceptions.PermissionDenied()

        # Generate S3 authorization headers using the extracted URL parameters
        request = utils.generate_s3_authorization_headers(f"{url_params.get('key'):s}")

        return drf_response.Response("authorized", headers=request.headers, status=200)
