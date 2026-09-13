"""Local protobuf/fake-transport tests; no LiveKit, credentials or media requests."""

import asyncio
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from livekit import api

from core.recording.worker.factories import WorkerServiceConfig
from core.services import cloud_egress as service


@pytest.fixture
def fixture():
    recording = SimpleNamespace(
        pk=uuid.uuid4(),
        room_id=uuid.uuid4(),
        worker_id=None,
        session=SimpleNamespace(livekit_room_sid="RM_fixture"),
    )
    transport = service.CloudEgressClient(
        WorkerServiceConfig(
            output_folder="recordings",
            server_configurations={},
            bucket_args={"bucket": "fixture"},
        )
    )
    client = SimpleNamespace(
        room=SimpleNamespace(
            list_rooms=AsyncMock(
                return_value=api.ListRoomsResponse(
                    rooms=[api.Room(name=str(recording.room_id), sid="RM_fixture")]
                )
            )
        ),
        egress=SimpleNamespace(
            start_room_composite_egress=AsyncMock(),
            stop_egress=AsyncMock(),
            list_egress=AsyncMock(),
        ),
        aclose=AsyncMock(),
    )
    with patch(
        "core.services.cloud_egress.utils.create_livekit_client", return_value=client
    ):
        yield recording, transport, client


def info(  # noqa: PLR0913 - independent wire identity fixture fields
    recording,
    transport,
    *,
    worker="EG_fixture",
    sid="RM_fixture",
    status=api.EgressStatus.EGRESS_ACTIVE,
    filename=None,
):
    return api.EgressInfo(
        egress_id=worker,
        room_name=str(recording.room_id),
        room_id=sid,
        status=status,
        room_composite=api.RoomCompositeEgressRequest(
            file_outputs=[
                api.EncodedFileOutput(
                    filepath=filename or transport.filepath(recording)
                )
            ]
        ),
    )


def test_preflight_checks_actual_room_sid_without_starting_audio(fixture):
    recording, transport, client = fixture
    transport.verify_source(recording)
    request = client.room.list_rooms.call_args.args[0]
    assert list(request.names) == [str(recording.room_id)]
    client.egress.start_room_composite_egress.assert_not_called()
    client.aclose.assert_awaited_once()


@pytest.mark.parametrize(
    "rooms", [[], [api.Room(name="other", sid="RM_fixture")], [api.Room(sid="RM_new")]]
)
def test_changed_or_missing_livekit_occurrence_is_not_a_new_start(fixture, rooms):
    recording, transport, client = fixture
    if rooms and not rooms[0].name:
        rooms[0].name = str(recording.room_id)
    client.room.list_rooms.return_value = api.ListRoomsResponse(rooms=rooms)
    with pytest.raises(service.CloudEgressSourceChanged):
        transport.verify_source(recording)
    client.egress.start_room_composite_egress.assert_not_called()


def test_starting_status_zero_is_valid_but_not_active(fixture):
    recording, transport, client = fixture
    client.egress.start_room_composite_egress.return_value = info(
        recording, transport, status=api.EgressStatus.EGRESS_STARTING
    )
    result = transport.start(recording)
    assert result.status == "starting" and result.room_sid == "RM_fixture"
    request = client.egress.start_room_composite_egress.call_args.args[0]
    assert request.room_name == str(recording.room_id) and not request.audio_only
    assert request.file_outputs[0].filepath == transport.filepath(recording)
    assert request.file_outputs[0].file_type == api.EncodedFileType.MP4
    assert request.file_outputs[0].s3.bucket == "fixture"
    client.egress.start_room_composite_egress.assert_awaited_once()


@pytest.mark.parametrize(
    "status,expected",
    [
        (api.EgressStatus.EGRESS_ENDING, "ending"),
        (api.EgressStatus.EGRESS_COMPLETE, "complete"),
        (api.EgressStatus.EGRESS_ABORTED, "aborted"),
    ],
)
def test_stop_accepts_observed_terminal_states_without_inventing_saved_file(
    fixture, status, expected
):
    recording, transport, client = fixture
    client.egress.stop_egress.return_value = info(recording, transport, status=status)
    assert transport.stop(recording, "EG_fixture").status == expected
    assert client.egress.stop_egress.call_args.args[0].egress_id == "EG_fixture"


def test_stop_wrong_worker_and_invalid_start_source_remain_unknown(fixture):
    recording, transport, client = fixture
    client.egress.stop_egress.return_value = info(
        recording, transport, worker="EG_other"
    )
    with pytest.raises(service.CloudEgressUnknown):
        transport.stop(recording, "EG_fixture")
    client.egress.start_room_composite_egress.return_value = info(
        recording, transport, sid=""
    )
    with pytest.raises(service.CloudEgressUnknown):
        transport.start(recording)


def test_lost_start_response_is_redacted_closed_and_never_retried(fixture):
    recording, transport, client = fixture
    client.egress.start_room_composite_egress.side_effect = RuntimeError(
        "private signed URL and credentials"
    )
    with pytest.raises(service.CloudEgressUnknown) as failure:
        transport.start(recording)
    assert "credentials" not in str(failure.value)
    client.egress.start_room_composite_egress.assert_awaited_once()
    client.aclose.assert_awaited_once()


def test_start_timeout_remains_unknown_without_second_dispatch(fixture, monkeypatch):
    recording, transport, client = fixture
    monkeypatch.setattr(service, "CALL_TIMEOUT", 0.001)

    async def delayed(_request):
        await asyncio.sleep(1)

    client.egress.start_room_composite_egress.side_effect = delayed
    with pytest.raises(service.CloudEgressUnknown):
        transport.start(recording)
    client.egress.start_room_composite_egress.assert_awaited_once()
    client.aclose.assert_awaited_once()


def test_lookup_follows_pages_and_matches_original_output_only(fixture):
    recording, transport, client = fixture
    unrelated = info(
        recording, transport, worker="EG_other", filename="recordings/other.mp4"
    )
    expected = info(recording, transport)
    expected.file_results.append(api.FileInfo(filename="/worker/local/temporary.mp4"))
    client.egress.list_egress.side_effect = [
        api.ListEgressResponse(
            items=[unrelated], next_page_token=api.TokenPagination(token="page2")
        ),
        api.ListEgressResponse(items=[expected]),
    ]
    result = transport.lookup(recording)
    assert result.worker_id == "EG_fixture"
    assert [
        call.args[0].page_token.token
        for call in client.egress.list_egress.call_args_list
    ] == ["", "page2"]
    client.egress.start_room_composite_egress.assert_not_called()
    assert client.aclose.await_count == 2


def test_absent_worker_does_not_prove_a_failed_start_or_trigger_retry(fixture):
    recording, transport, client = fixture
    client.egress.list_egress.return_value = api.ListEgressResponse()
    assert transport.lookup(recording) is None
    client.egress.start_room_composite_egress.assert_not_called()


def test_multiple_workers_for_one_output_are_not_arbitrarily_selected(fixture):
    recording, transport, client = fixture
    client.egress.list_egress.return_value = api.ListEgressResponse(
        items=[
            info(recording, transport),
            info(recording, transport, worker="EG_second"),
        ]
    )
    with pytest.raises(service.CloudEgressUnknown):
        transport.lookup(recording)


def test_known_worker_id_is_checked_and_completed_filename_can_prove_identity(fixture):
    recording, transport, client = fixture
    recording.worker_id = "EG_fixture"
    completed = info(recording, transport, status=api.EgressStatus.EGRESS_COMPLETE)
    completed.ClearField("room_composite")
    completed.file_results.append(api.FileInfo(filename=transport.filepath(recording)))
    client.egress.list_egress.return_value = api.ListEgressResponse(items=[completed])
    assert transport.lookup(recording).status == "complete"
    assert client.egress.list_egress.call_args.args[0].egress_id == "EG_fixture"
    completed.egress_id = "EG_other"
    client.egress.list_egress.return_value = api.ListEgressResponse(items=[completed])
    with pytest.raises(service.CloudEgressUnknown):
        transport.lookup(recording)


def test_changed_source_is_reported_for_quarantine_without_rebinding(fixture):
    recording, transport, client = fixture
    client.egress.list_egress.return_value = api.ListEgressResponse(
        items=[info(recording, transport, sid="RM_new")]
    )
    result = transport.lookup(recording)
    assert result.room_sid == "RM_new"
    assert recording.session.livekit_room_sid == "RM_fixture"
    client.egress.stop_egress.assert_not_called()


@pytest.mark.parametrize("case", ["cycle", "pages", "items"])
def test_lookup_bounds_are_unknown_not_empty_success(fixture, monkeypatch, case):
    recording, transport, client = fixture
    if case == "items":
        monkeypatch.setattr(service, "MAX_ITEMS", 1)
        client.egress.list_egress.return_value = api.ListEgressResponse(
            items=[info(recording, transport), info(recording, transport)]
        )
    elif case == "cycle":
        client.egress.list_egress.return_value = api.ListEgressResponse(
            next_page_token=api.TokenPagination(token="same")
        )
    else:
        client.egress.list_egress.side_effect = [
            api.ListEgressResponse(next_page_token=api.TokenPagination(token=str(i)))
            for i in range(3)
        ]
    with pytest.raises(service.CloudEgressUnknown):
        transport.lookup(recording)
    assert client.egress.list_egress.await_count <= 3
    client.egress.start_room_composite_egress.assert_not_called()
