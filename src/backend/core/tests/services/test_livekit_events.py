"""
Test LiveKitEvents service.
"""
# pylint: disable=W0621,W0613, W0212, E0611

import uuid
from datetime import timedelta
from unittest import mock

from django.utils import timezone

import pytest
from livekit.api import EgressStatus

from core import models
from core.factories import (
    MeetingSessionFactory,
    RecordingFactory,
    RoomFactory,
    UserFactory,
)
from core.recording.services.recording_events import RecordingEventsService
from core.services.livekit_events import (
    ActionFailedError,
    AuthenticationError,
    InvalidPayloadError,
    LiveKitEventsService,
    UnsupportedEventTypeError,
    api,
)
from core.services.lobby import LobbyService
from core.services.telephony import TelephonyException, TelephonyService
from core.utils import MetadataUpdateException, NotificationError

pytestmark = pytest.mark.django_db


@pytest.fixture
def mock_livekit_config(settings):
    """Mock LiveKit configuration."""
    settings.LIVEKIT_CONFIGURATION = {
        "api_key": "test_api_key",
        "api_secret": "test_api_secret",
        "url": "https://test-livekit.example.com/",
    }
    return settings.LIVEKIT_CONFIGURATION


@pytest.fixture
def service(mock_livekit_config):
    """Initialize LiveKitEventsService."""
    return LiveKitEventsService()


@mock.patch("livekit.api.TokenVerifier")
@mock.patch("livekit.api.WebhookReceiver")
def test_initialization(
    mock_webhook_receiver, mock_token_verifier, mock_livekit_config
):
    """Should correctly initialize the service with required dependencies."""

    api_key = mock_livekit_config["api_key"]
    api_secret = mock_livekit_config["api_secret"]

    service = LiveKitEventsService()

    mock_token_verifier.assert_called_once_with(api_key, api_secret)
    mock_webhook_receiver.assert_called_once_with(mock_token_verifier.return_value)
    assert isinstance(service.lobby_service, LobbyService)
    assert isinstance(service.telephony_service, TelephonyService)
    assert isinstance(service.recording_events, RecordingEventsService)


@pytest.mark.parametrize(
    ("mode", "notification_type"),
    (
        ("screen_recording", "screenRecordingLimitReached"),
        ("transcript", "transcriptionLimitReached"),
    ),
)
@mock.patch("core.utils.notify_participants")
@mock.patch("core.utils.update_room_metadata")
def test_handle_egress_ended_success(
    mock_update_room_metadata, mock_notify, mode, notification_type, service
):
    """Should successfully stop recording and notifies all participant."""

    recording = RecordingFactory(worker_id="worker-1", mode=mode, status="active")
    mock_data = mock.MagicMock()
    mock_data.egress_info.egress_id = recording.worker_id
    mock_data.egress_info.status = EgressStatus.EGRESS_LIMIT_REACHED

    service._handle_egress_ended(mock_data)

    mock_notify.assert_called_once_with(
        room_name=str(recording.room.id), notification_data={"type": notification_type}
    )
    mock_update_room_metadata.assert_called_once_with(
        str(recording.room.id), {}, ["recording_mode", "recording_status"]
    )

    recording.refresh_from_db()
    assert recording.status == "stopped"


@pytest.mark.parametrize(
    ("egress_status", "status"),
    (
        (EgressStatus.EGRESS_ACTIVE, "started"),
        (EgressStatus.EGRESS_ENDING, "saving"),
        (EgressStatus.EGRESS_ABORTED, "aborted"),
    ),
)
@mock.patch("core.utils.update_room_metadata")
def test_handle_egress_updated_success(
    mock_update_room_metadata, egress_status, status, service
):
    """Should successfully update room's metadata."""

    recording = RecordingFactory(worker_id="worker-1", status="initiated")
    mock_data = mock.MagicMock()
    mock_data.egress_info.egress_id = recording.worker_id
    mock_data.egress_info.status = egress_status

    service._handle_egress_updated(mock_data)

    mock_update_room_metadata.assert_called_once_with(
        str(recording.room.id), {"recording_status": status}
    )


@mock.patch("core.utils.update_room_metadata")
def test_handle_egress_updated_binds_recording_by_livekit_room_sid(
    mock_update_room_metadata, service
):
    """The egress room_id should correct Recording ownership to its session."""

    room = RoomFactory()
    session = MeetingSessionFactory(room=room, livekit_room_sid="RM_egress")
    recording = RecordingFactory(
        room=room,
        session=None,
        worker_id="worker-session-bind",
        status="initiated",
    )
    data = mock.MagicMock()
    data.created_at = int(timezone.now().timestamp())
    data.egress_info.egress_id = recording.worker_id
    data.egress_info.room_id = session.livekit_room_sid
    data.egress_info.status = EgressStatus.EGRESS_ACTIVE

    service._handle_egress_updated(data)

    recording.refresh_from_db()
    assert recording.session == session
    mock_update_room_metadata.assert_called_once()


@pytest.mark.parametrize(
    "egress_status",
    (
        EgressStatus.EGRESS_FAILED,
        EgressStatus.EGRESS_LIMIT_REACHED,
    ),
)
@mock.patch("core.utils.update_room_metadata")
def test_handle_egress_updated_non_handled(
    mock_update_room_metadata, egress_status, service
):
    """Should ignore certain egress status and don't trigger metadata updates."""

    recording = RecordingFactory(worker_id="worker-1", status="initiated")
    mock_data = mock.MagicMock()
    mock_data.egress_info.egress_id = recording.worker_id
    mock_data.egress_info.status = egress_status

    service._handle_egress_updated(mock_data)

    mock_update_room_metadata.assert_not_called()


@pytest.mark.parametrize(
    ("mode", "notification_type"),
    (
        ("screen_recording", "screenRecordingLimitReached"),
        ("transcript", "transcriptionLimitReached"),
    ),
)
@mock.patch("core.utils.notify_participants")
@mock.patch("core.utils.update_room_metadata")
def test_handle_egress_ended_metadata_update_fails(
    mock_update_room_metadata, mock_notify, mode, notification_type, service
):
    """Should successfully stop recording when metadata's update fails."""

    recording = RecordingFactory(worker_id="worker-1", mode=mode, status="active")
    mock_data = mock.MagicMock()
    mock_data.egress_info.egress_id = recording.worker_id
    mock_data.egress_info.status = EgressStatus.EGRESS_LIMIT_REACHED

    mock_update_room_metadata.side_effect = MetadataUpdateException("Error notifying")

    service._handle_egress_ended(mock_data)

    mock_notify.assert_called_once_with(
        room_name=str(recording.room.id), notification_data={"type": notification_type}
    )
    recording.refresh_from_db()
    assert recording.status == "stopped"


@mock.patch("core.utils.notify_participants")
@mock.patch("core.utils.update_room_metadata")
def test_handle_egress_ended_notification_fails(
    mock_update_room_metadata, mock_notify, service
):
    """Should raise ActionFailedError when notification fails but still stop recording."""

    recording = RecordingFactory(worker_id="worker-1", status="active")
    mock_data = mock.MagicMock()
    mock_data.egress_info.egress_id = recording.worker_id
    mock_data.egress_info.status = EgressStatus.EGRESS_LIMIT_REACHED

    mock_notify.side_effect = NotificationError("Error notifying")

    with pytest.raises(
        ActionFailedError,
        match=r"Failed to process limit reached event for recording .+",
    ):
        service._handle_egress_ended(mock_data)

    recording.refresh_from_db()
    assert recording.status == "stopped"

    mock_update_room_metadata.assert_called_once_with(
        str(recording.room.id), {}, ["recording_mode", "recording_status"]
    )


@mock.patch("core.utils.notify_participants")
@mock.patch("core.utils.update_room_metadata")
def test_handle_egress_ended_recording_not_found(
    mock_update_room_metadata, mock_notify, service
):
    """Should raise ActionFailedError when recording doesn't exist."""

    recording = RecordingFactory(worker_id="worker-1", status="active")
    mock_data = mock.MagicMock()
    mock_data.egress_info.egress_id = "worker-2"
    mock_data.egress_info.status = EgressStatus.EGRESS_LIMIT_REACHED

    with pytest.raises(
        ActionFailedError, match=r"Recording with worker ID .+ does not exist"
    ):
        service._handle_egress_ended(mock_data)

    mock_notify.assert_not_called()
    mock_update_room_metadata.assert_not_called()

    recording.refresh_from_db()
    assert recording.status == "active"


@mock.patch("core.utils.notify_participants")
@mock.patch("core.utils.update_room_metadata")
def test_handle_egress_ended_recording_not_active(
    mock_update_room_metadata, mock_notify, service
):
    """Should ignore non-active recordings."""

    recording = RecordingFactory(worker_id="worker-1", status="failed_to_stop")
    mock_data = mock.MagicMock()
    mock_data.egress_info.egress_id = "worker-1"
    mock_data.egress_info.status = EgressStatus.EGRESS_LIMIT_REACHED

    service._handle_egress_ended(mock_data)

    mock_notify.assert_not_called()
    mock_update_room_metadata.assert_called_once_with(
        str(recording.room.id), {}, ["recording_mode", "recording_status"]
    )

    recording.refresh_from_db()
    assert recording.status == "failed_to_stop"


@mock.patch("core.utils.notify_participants")
@mock.patch("core.utils.update_room_metadata")
def test_handle_egress_ended_recording_not_limit_reached(
    mock_update_room_metadata, mock_notify, service
):
    """Should ignore egress non-limit-reached statuses."""

    recording = RecordingFactory(worker_id="worker-1", status="stopped")
    mock_data = mock.MagicMock()
    mock_data.egress_info.egress_id = "worker-1"
    mock_data.egress_info.status = EgressStatus.EGRESS_COMPLETE

    service._handle_egress_ended(mock_data)

    mock_notify.assert_not_called()
    mock_update_room_metadata.assert_called_once_with(
        str(recording.room.id), {}, ["recording_mode", "recording_status"]
    )
    assert recording.status == "stopped"


@mock.patch("core.services.livekit_events.MetadataCollectorService")
@mock.patch("core.utils.update_room_metadata")
def test_handle_egress_ended_calls_metadata_collector_stop_when_conditions_are_met(
    mock_update_room_metadata, mock_collector_class, service, settings
):
    """Should call MetadataCollectorService.stop when it exists."""
    settings.METADATA_COLLECTOR_ENABLED = True

    recording = RecordingFactory(
        worker_id="worker-1",
        status="active",
        options={"metadata_collector_dispatch_id": "dispatch-123"},
    )
    mock_data = mock.MagicMock()
    mock_data.egress_info.egress_id = recording.worker_id
    mock_data.egress_info.status = EgressStatus.EGRESS_COMPLETE

    mock_collector = mock.Mock()
    mock_collector_class.return_value = mock_collector

    service._handle_egress_ended(mock_data)

    mock_collector.stop.assert_called_once_with(recording)


@pytest.mark.parametrize(
    "metadata_enabled,options",
    [
        (True, {}),
        (False, {}),
    ],
)
@mock.patch("core.services.livekit_events.MetadataCollectorService")
@mock.patch("core.utils.update_room_metadata")
def test_handle_egress_ended_does_not_call_metadata_collector_stop_when_conditions_not_met(
    _, mock_collector_class, metadata_enabled, options, service, settings
):  # pylint: disable=too-many-arguments,too-many-positional-arguments
    """Should not call MetadataCollectorService.stop when it does not exist."""
    settings.METADATA_COLLECTOR_ENABLED = metadata_enabled

    recording = RecordingFactory(
        worker_id="worker-1",
        status="active",
        options=options,
    )
    mock_data = mock.MagicMock()
    mock_data.egress_info.egress_id = recording.worker_id
    mock_data.egress_info.status = EgressStatus.EGRESS_COMPLETE

    mock_collector = mock.Mock()
    mock_collector_class.return_value = mock_collector

    service._handle_egress_ended(mock_data)

    mock_collector.stop.assert_not_called()


@mock.patch.object(LobbyService, "clear_room_cache")
@mock.patch.object(TelephonyService, "delete_dispatch_rule")
def test_handle_room_finished_clears_cache_and_deletes_dispatch_rule(
    mock_delete_dispatch_rule, mock_clear_cache, service, settings
):
    """Should clear lobby cache and delete telephony dispatch rule when room finishes."""
    settings.ROOM_TELEPHONY_ENABLED = True
    mock_room_name = uuid.uuid4()
    mock_data = mock.MagicMock()
    mock_data.room.name = str(mock_room_name)

    service._handle_room_finished(mock_data)

    mock_delete_dispatch_rule.assert_called_once_with(mock_room_name)
    mock_clear_cache.assert_called_once_with(mock_room_name)


@mock.patch.object(LobbyService, "clear_room_cache")
@mock.patch.object(TelephonyService, "delete_dispatch_rule")
def test_handle_room_finished_skips_telephony_when_disabled(
    mock_delete_dispatch_rule, mock_clear_cache, service, settings
):
    """Should clear lobby cache but skip dispatch rule deletion when telephony is disabled."""
    settings.ROOM_TELEPHONY_ENABLED = False
    mock_room_name = uuid.uuid4()
    mock_data = mock.MagicMock()
    mock_data.room.name = str(mock_room_name)

    service._handle_room_finished(mock_data)

    mock_delete_dispatch_rule.assert_not_called()
    mock_clear_cache.assert_called_once_with(mock_room_name)


@mock.patch.object(
    LobbyService, "clear_room_cache", side_effect=Exception("Test error")
)
@mock.patch.object(TelephonyService, "delete_dispatch_rule")
def test_handle_room_finished_raises_error_when_cache_clearing_fails(
    mock_delete_dispatch_rule, mock_clear_cache, service, settings
):
    """Should raise ActionFailedError when lobby cache clearing fails when room finishes."""
    settings.ROOM_TELEPHONY_ENABLED = True
    mock_data = mock.MagicMock()
    mock_data.room.name = "00000000-0000-0000-0000-000000000000"

    expected_error = (
        "Failed to clear room cache for room 00000000-0000-0000-0000-000000000000"
    )

    with pytest.raises(ActionFailedError, match=expected_error):
        service._handle_room_finished(mock_data)

    mock_delete_dispatch_rule.assert_called_once_with(
        uuid.UUID("00000000-0000-0000-0000-000000000000")
    )


@mock.patch.object(LobbyService, "clear_room_cache")
@mock.patch.object(
    TelephonyService,
    "delete_dispatch_rule",
    side_effect=TelephonyException("Test error"),
)
def test_handle_room_finished_raises_error_when_telephony_deletion_fails(
    mock_delete_dispatch_rule, mock_clear_cache, service, settings
):
    """Should raise ActionFailedError when dispatch rule deletion fails when room finishes."""
    settings.ROOM_TELEPHONY_ENABLED = True
    mock_data = mock.MagicMock()
    mock_data.room.name = "00000000-0000-0000-0000-000000000000"

    expected_error = (
        "Failed to delete telephony dispatch rule for room "
        "00000000-0000-0000-0000-000000000000"
    )

    with pytest.raises(ActionFailedError, match=expected_error):
        service._handle_room_finished(mock_data)

    mock_clear_cache.assert_not_called()


def test_handle_room_finished_raises_error_for_invalid_room_name(service):
    """Should raise ActionFailedError when room name format is invalid when room finishes."""
    mock_data = mock.MagicMock()
    mock_data.room.name = "invalid"

    with pytest.raises(
        ActionFailedError, match="Failed to process room finished event"
    ):
        service._handle_room_finished(mock_data)


@mock.patch.object(TelephonyService, "create_dispatch_rule")
def test_handle_room_started_creates_dispatch_rule_successfully(
    mock_create_dispatch_rule, service, settings
):
    """Should create telephony dispatch rule when room starts successfully."""
    settings.ROOM_TELEPHONY_ENABLED = True
    room = RoomFactory()
    mock_data = mock.MagicMock()
    mock_data.room.name = str(room.id)
    mock_data.room.sid = "RM_started_telephony"

    service._handle_room_started(mock_data)

    mock_create_dispatch_rule.assert_called_once_with(room)
    assert models.MeetingSession.objects.filter(
        room=room, livekit_room_sid="RM_started_telephony"
    ).exists()


@mock.patch.object(TelephonyService, "create_dispatch_rule")
def test_handle_room_started_skips_dispatch_rule_when_telephony_disabled(
    mock_create_dispatch_rule, service, settings
):
    """Should skip creating telephony dispatch rule when telephony is disabled during room start."""
    settings.ROOM_TELEPHONY_ENABLED = False
    room = RoomFactory()
    mock_data = mock.MagicMock()
    mock_data.room.name = str(room.id)
    mock_data.room.sid = "RM_started_no_telephony"

    service._handle_room_started(mock_data)

    mock_create_dispatch_rule.assert_not_called()


def test_handle_participant_events_create_and_close_participation(service, settings):
    """Participant webhooks should project one idempotent connection interval."""

    settings.ROOM_TELEPHONY_ENABLED = False
    room = RoomFactory()
    user = UserFactory(sub="participant-user")
    started_at = timezone.now().replace(microsecond=0)
    joined_at = started_at + timedelta(seconds=2)
    left_at = joined_at + timedelta(minutes=3)
    livekit_room = api.Room(
        name=str(room.id),
        sid="RM_participants",
        creation_time=int(started_at.timestamp()),
    )
    participant = api.ParticipantInfo(
        sid="PA_participant",
        identity=user.sub,
        name="Participant User",
        kind=api.ParticipantInfo.STANDARD,
        joined_at=int(joined_at.timestamp()),
    )
    joined_event = api.WebhookEvent(
        id="EV_join",
        event="participant_joined",
        created_at=int(joined_at.timestamp()),
        room=livekit_room,
        participant=participant,
    )
    left_event = api.WebhookEvent(
        id="EV_left",
        event="participant_left",
        created_at=int(left_at.timestamp()),
        room=livekit_room,
        participant=participant,
    )

    service._handle_participant_joined(joined_event)
    service._handle_participant_joined(joined_event)
    service._handle_participant_left(left_event)
    service._handle_participant_left(left_event)

    participation = models.MeetingParticipation.objects.get()
    assert participation.user == user
    assert participation.joined_at == joined_at
    assert participation.left_at == left_at


@mock.patch.object(LobbyService, "clear_room_cache")
def test_handle_room_finished_closes_session_and_open_participations(
    mock_clear_cache, service, settings
):
    """room_finished should close both the session and dangling attendance."""

    settings.ROOM_TELEPHONY_ENABLED = False
    room = RoomFactory()
    started_at = timezone.now().replace(microsecond=0) - timedelta(minutes=10)
    ended_at = started_at + timedelta(minutes=8)
    data = api.WebhookEvent(
        id="EV_finish",
        event="room_finished",
        created_at=int(ended_at.timestamp()),
        room=api.Room(
            name=str(room.id),
            sid="RM_finished",
            creation_time=int(started_at.timestamp()),
        ),
    )
    session, _ = service.meeting_sessions.start_from_livekit_room(
        room=room, livekit_room=data.room, event_at=started_at
    )
    participation = models.MeetingParticipation.objects.create(
        session=session,
        livekit_participant_sid="PA_open",
        identity="open-user",
        joined_at=started_at + timedelta(minutes=1),
    )

    with mock.patch(
        "core.tasks.summary.generate_meeting_summary.apply_async"
    ) as mock_summary:
        service._handle_room_finished(data)

    session.refresh_from_db()
    participation.refresh_from_db()
    assert session.status == models.MeetingSession.Status.ENDED
    assert session.end_reason == models.MeetingSession.EndReason.ROOM_FINISHED
    assert session.ended_at == ended_at
    assert participation.left_at == ended_at
    mock_clear_cache.assert_called_once_with(room.id)
    mock_summary.assert_called_once_with(args=[str(session.id)], countdown=30)


def test_handle_room_started_raises_error_for_invalid_room_name(service):
    """Should raise ActionFailedError when room name format is invalid  when room starts."""
    mock_data = mock.MagicMock()
    mock_data.room.name = "invalid"

    with pytest.raises(ActionFailedError, match="Failed to process room started event"):
        service._handle_room_started(mock_data)


def test_handle_room_started_raises_error_for_nonexistent_room(service):
    """Should raise ActionFailedError when a room starts that doesn't exist in the database."""
    mock_data = mock.MagicMock()
    mock_data.room.name = str(uuid.uuid4())

    expected_error = f"Room with ID {mock_data.room.name} does not exist"

    with pytest.raises(ActionFailedError, match=expected_error):
        service._handle_room_started(mock_data)


@mock.patch.object(
    api.WebhookReceiver, "receive", side_effect=Exception("Invalid payload")
)
def test_receive_invalid_payload(mock_receive, service):
    """Should raise InvalidPayloadError for invalid payloads."""
    mock_request = mock.MagicMock()
    mock_request.headers = {"Authorization": "test_token"}
    mock_request.body = b"{}"

    with pytest.raises(InvalidPayloadError, match="Invalid webhook payload"):
        service.receive(mock_request)


def test_receive_missing_auth(service):
    """Should raise AuthenticationError when auth header is missing."""
    mock_request = mock.MagicMock()
    mock_request.headers = {}

    with pytest.raises(AuthenticationError, match="Authorization header missing"):
        service.receive(mock_request)


@mock.patch.object(api.WebhookReceiver, "receive")
def test_receive_unsupported_event(mock_receive, service):
    """Should raise LiveKitWebhookError for unsupported events."""
    mock_request = mock.MagicMock()
    mock_request.headers = {"Authorization": "test_token"}
    mock_request.body = b"{}"

    # Mock returned data with unsupported event type
    mock_data = mock.MagicMock()
    mock_data.event = "unsupported_event"
    mock_receive.return_value = mock_data

    with pytest.raises(
        UnsupportedEventTypeError, match="Unknown webhook type: unsupported_event"
    ):
        service.receive(mock_request)


@mock.patch.object(api.WebhookReceiver, "receive")
@mock.patch.object(LiveKitEventsService, "_handle_room_started")
def test_receive_no_filter_processes_all_events(
    mock_handle_room_started, mock_receive, mock_livekit_config, settings
):
    """Should process all events when filter regex is not configured."""
    settings.LIVEKIT_WEBHOOK_EVENTS_FILTER_REGEX = None

    mock_request = mock.MagicMock()
    mock_request.headers = {"Authorization": "test_token"}
    mock_request.body = b"{}"

    mock_data = mock.MagicMock()
    mock_data.room.name = "!JIfCxVLcKKkWrmVBOb:your-domain.com"
    mock_data.event = "room_started"
    mock_receive.return_value = mock_data

    service = LiveKitEventsService()
    service.receive(mock_request)

    mock_handle_room_started.assert_called_once()


@mock.patch.object(api.WebhookReceiver, "receive")
@mock.patch.object(LiveKitEventsService, "_handle_room_started")
def test_receive_invalid_filter_regex_processes_all_events(
    mock_handle_room_started, mock_receive, mock_livekit_config, settings
):
    """Should process all events when filter regex is invalid (fail-safe)."""
    settings.LIVEKIT_WEBHOOK_EVENTS_FILTER_REGEX = "(abc"

    mock_request = mock.MagicMock()
    mock_request.headers = {"Authorization": "test_token"}
    mock_request.body = b"{}"

    mock_data = mock.MagicMock()
    mock_data.room.name = "!JIfCxVLcKKkWrmVBOb:your-domain.com"
    mock_data.event = "room_started"
    mock_receive.return_value = mock_data

    service = LiveKitEventsService()
    service.receive(mock_request)

    mock_handle_room_started.assert_called_once()


@mock.patch.object(api.WebhookReceiver, "receive")
@mock.patch.object(LiveKitEventsService, "_handle_room_started")
def test_receive_filter_drops_non_matching_events(
    mock_handle_room_started, mock_receive, mock_livekit_config, settings
):
    """Should drop events when room name does not match filter regex."""
    settings.LIVEKIT_WEBHOOK_EVENTS_FILTER_REGEX = (
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    )

    mock_request = mock.MagicMock()
    mock_request.headers = {"Authorization": "test_token"}
    mock_request.body = b"{}"

    mock_data = mock.MagicMock()
    mock_data.room.name = "!JIfCxVLcKKkWrmVBOb:your-domain.com"
    mock_data.event = "room_started"
    mock_receive.return_value = mock_data

    service = LiveKitEventsService()
    service.receive(mock_request)

    mock_handle_room_started.assert_not_called()


@mock.patch.object(api.WebhookReceiver, "receive")
@mock.patch.object(LiveKitEventsService, "_handle_room_started")
def test_receive_filter_processes_matching_events(
    mock_handle_room_started, mock_receive, mock_livekit_config, settings
):
    """Should process events when room name matches filter regex."""
    settings.LIVEKIT_WEBHOOK_EVENTS_FILTER_REGEX = (
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    )

    mock_request = mock.MagicMock()
    mock_request.headers = {"Authorization": "test_token"}
    mock_request.body = b"{}"

    mock_data = mock.MagicMock()
    mock_data.room.name = str(uuid.uuid4())
    mock_data.event = "room_started"
    mock_receive.return_value = mock_data

    service = LiveKitEventsService()
    service.receive(mock_request)

    mock_handle_room_started.assert_called_once()
