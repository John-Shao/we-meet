"""Bounded LiveKit video transport with exact source/output evidence."""

import asyncio
import json
import re
from contextlib import suppress
from dataclasses import dataclass

from asgiref.sync import async_to_sync
from livekit import api

from core import utils
from core.recording.worker.factories import WorkerServiceConfig
from core.recording.worker.storage import file_upload_options

MAX_PAGES = 3
MAX_ITEMS = 1000
CALL_TIMEOUT = 8
LOOKUP_TIMEOUT = 20


class CloudEgressUnknown(Exception):
    """No trustworthy outcome; callers must not repeat a start automatically."""


class CloudEgressSourceChanged(Exception):
    """A preflight proves the intended room occurrence is no longer current."""


@dataclass(frozen=True)
class CloudEgressObservation:
    """Only non-secret worker evidence crosses the provider boundary."""

    worker_id: str
    room_sid: str
    status: str


STATUS = {
    api.EgressStatus.EGRESS_STARTING: "starting",
    api.EgressStatus.EGRESS_ACTIVE: "active",
    api.EgressStatus.EGRESS_ENDING: "ending",
    api.EgressStatus.EGRESS_COMPLETE: "complete",
    api.EgressStatus.EGRESS_FAILED: "failed",
    api.EgressStatus.EGRESS_ABORTED: "aborted",
    api.EgressStatus.EGRESS_LIMIT_REACHED: "limit_reached",
}


class CloudEgressClient:
    """A retry inspects the original filename/worker; it never sends another start."""

    def __init__(self, config=None):
        self.config = config or WorkerServiceConfig.from_settings()

    def filepath(self, recording):
        """Same private MP4 key as the existing video composite worker."""
        return f"{self.config.output_folder}/{recording.pk}.mp4"

    @async_to_sync
    async def update_notice(self, room_id, expected_sid, metadata):
        """Merge only recording notice fields after checking the live occurrence."""
        response = await self._call(
            "room", "list_rooms", api.ListRoomsRequest(names=[room_id])
        )
        rooms = [room for room in response.rooms if room.name == room_id]
        if len(rooms) != 1 or rooms[0].sid != expected_sid:
            return
        current = json.loads(rooms[0].metadata) if rooms[0].metadata else {}
        for key in ("recording_mode", "recording_status"):
            current.pop(key, None)
        current.update(metadata)
        await self._call(
            "room",
            "update_room_metadata",
            api.UpdateRoomMetadataRequest(room=room_id, metadata=json.dumps(current)),
        )

    async def _call(self, service, method, request):
        client = None
        try:
            async with asyncio.timeout(CALL_TIMEOUT):
                client = utils.create_livekit_client(self.config.server_configurations)
                return await getattr(getattr(client, service), method)(request)
        except Exception:  # noqa: BLE001 - redact all provider errors at this boundary
            # Provider payloads may contain credentials, signed URLs and private titles.
            raise CloudEgressUnknown(
                "Cloud recording outcome could not be verified."
            ) from None
        finally:
            if client is not None:
                # A close error must not cause a second recording request.
                with suppress(Exception):
                    await asyncio.wait_for(client.aclose(), timeout=2)

    def verify_source(self, recording):
        """Read the actual LiveKit occurrence immediately before a new start."""
        # Resolve a potentially lazy ORM relation before crossing the async boundary.
        return self._verify_source(
            str(recording.room_id), recording.session.livekit_room_sid
        )

    @async_to_sync
    async def _verify_source(self, room_id, expected_sid):
        response = await self._call(
            "room", "list_rooms", api.ListRoomsRequest(names=[room_id])
        )
        rooms = [room for room in response.rooms if room.name == room_id]
        if len(rooms) != 1 or rooms[0].sid != expected_sid:
            raise CloudEgressSourceChanged("The meeting occurrence has changed.")

    def _paths(self, info):
        request = info.room_composite
        paths = {output.filepath for output in request.file_outputs}
        if request.HasField("file"):
            paths.add(request.file.filepath)
        paths.discard("")
        return paths or {item.filename for item in info.file_results if item.filename}

    def _observation(self, info, recording, *, require_file):
        paths = self._paths(info)
        if (require_file and not paths) or (
            paths and paths != {self.filepath(recording)}
        ):
            raise CloudEgressUnknown("Cloud recording output identity is inconsistent.")
        if (
            not re.fullmatch(r"EG_[A-Za-z0-9_-]{1,252}", info.egress_id)
            or not re.fullmatch(r"RM_[A-Za-z0-9_-]{1,61}", info.room_id)
            or info.room_name != str(recording.room_id)
            or info.status not in STATUS
        ):
            raise CloudEgressUnknown("Cloud recording source identity is incomplete.")
        return CloudEgressObservation(info.egress_id, info.room_id, STATUS[info.status])

    @async_to_sync
    async def start(self, recording):
        """Send one MP4 composite request; callers own the durable single-execution fence."""
        output = api.EncodedFileOutput(
            file_type=api.EncodedFileType.MP4,
            filepath=self.filepath(recording),
            **file_upload_options(self.config.bucket_args),
        )
        options = {
            "room_name": str(recording.room_id),
            "file_outputs": [output],
            "layout": "speaker-light",
        }
        if self.config.encoding_options:
            options["advanced"] = api.EncodingOptions(**self.config.encoding_options)
        info = await self._call(
            "egress",
            "start_room_composite_egress",
            api.RoomCompositeEgressRequest(**options),
        )
        return self._observation(info, recording, require_file=False)

    @async_to_sync
    async def stop(self, recording, worker_id):
        """Only an internally verified worker ID may be passed by the coordinator."""
        if not re.fullmatch(r"EG_[A-Za-z0-9_-]{1,252}", worker_id):
            raise CloudEgressUnknown("Cloud recording worker identity is invalid.")
        info = await self._call(
            "egress", "stop_egress", api.StopEgressRequest(egress_id=worker_id)
        )
        observed = self._observation(info, recording, require_file=False)
        if observed.worker_id != worker_id:
            raise CloudEgressUnknown("Cloud recording worker identity changed.")
        return observed

    @async_to_sync
    async def lookup(self, recording):
        """Search bounded pages for the unique original output, including finished jobs."""
        matches = {}
        visited = set()
        token = ""
        count = 0
        try:
            async with asyncio.timeout(LOOKUP_TIMEOUT):
                for _ in range(MAX_PAGES):
                    request_options = {
                        "room_name": str(recording.room_id),
                        "egress_id": recording.worker_id or "",
                    }
                    if "page_token" in api.ListEgressRequest.DESCRIPTOR.fields_by_name:
                        request_options["page_token"] = api.TokenPagination(token=token)
                    elif token:
                        raise CloudEgressUnknown(
                            "Installed LiveKit SDK cannot follow egress pagination."
                        )
                    response = await self._call(
                        "egress",
                        "list_egress",
                        api.ListEgressRequest(**request_options),
                    )
                    count += len(response.items)
                    if count > MAX_ITEMS:
                        raise CloudEgressUnknown(
                            "Cloud recording lookup exceeded its bound."
                        )
                    for info in response.items:
                        if self.filepath(recording) not in self._paths(info):
                            continue
                        observed = self._observation(info, recording, require_file=True)
                        if (
                            recording.worker_id
                            and observed.worker_id != recording.worker_id
                        ):
                            raise CloudEgressUnknown(
                                "Cloud recording worker identity changed."
                            )
                        previous = matches.get(observed.worker_id)
                        if previous and previous != observed:
                            raise CloudEgressUnknown(
                                "Cloud recording lookup is inconsistent."
                            )
                        matches[observed.worker_id] = observed
                    token = getattr(
                        getattr(response, "next_page_token", None), "token", ""
                    )
                    if not token:
                        if len(matches) > 1:
                            raise CloudEgressUnknown(
                                "More than one cloud worker matches this output."
                            )
                        return next(iter(matches.values()), None)
                    if token in visited or len(token) > 2048:
                        raise CloudEgressUnknown(
                            "Cloud recording pagination is inconsistent."
                        )
                    visited.add(token)
        except TimeoutError:
            raise CloudEgressUnknown("Cloud recording lookup timed out.") from None
        raise CloudEgressUnknown("Cloud recording lookup requires too many pages.")
