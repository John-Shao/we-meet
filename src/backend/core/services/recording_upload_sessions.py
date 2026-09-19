"""Resumable, chunked direct uploads.

The whole-file presigned PUT in `uploaded_recordings` has one failure mode that
matters at GB scale: any break means starting over. Object storage's multipart
API fixes that, but only if somebody remembers the upload id and which parts
landed — and the client cannot be the one who remembers, because a cleared
browser or a new device would then have no way to resume, and a client that lies
about a part's presence would produce a corrupt object.

So the server keeps the session (``RecordingUploadSession``) and treats the
storage service as the authority on what has actually arrived: the resume list
comes from ``ListParts``, never from what a client claims it sent.

Part ETags are the other half of the contract. ``CompleteMultipartUpload`` needs
every part's ETag in order, and an ETag is only knowable from the response to
that part's own upload — so they are persisted as they arrive. Without them a
completed upload is impossible, which is also why the bucket must expose the
``ETag`` response header to a browser (see the CORS note in the plan doc).
"""

import hashlib
import math
import posixpath
import uuid
from pathlib import Path

from django.conf import settings
from django.db import transaction

from botocore.exceptions import ClientError

from core import models
from core.services.capture_storage import audio_storage
from core.services.meeting_records import RecordConflict
from core.services.uploaded_recordings import (
    EXTENSIONS,
    MEDIA_MIMES,
    VIDEO_EXTENSIONS,
    _declared_media_ok,
    _job_configuration,
    _record_job,
    _replay_guard,
    _verify_stored_header,
    active_upload_exists,
    direct_upload_available,
)

#: Object storage requires every part except the last to be at least 5 MiB, and
#: caps one upload at 10,000 parts. 64 MiB keeps a 6 GiB import to ~96 parts
#: while staying well inside both bounds.
PART_SIZE = 64 * 1024 * 1024
MIN_PART_SIZE = 5 * 1024 * 1024
MAX_PARTS = 10_000

#: How many part URLs one signing request may ask for. The whole point of
#: batching is to stay inside the endpoint's request budget: signing one part per
#: request would need ~96 requests for a 6 GiB file, which the shared
#: `UploadThrottle` (6/min) cannot carry. A batch covers 64 parts = 4 GiB.
MAX_PARTS_PER_SIGNING = 128


def _extension(name):
    extension = Path(name).suffix.lower().lstrip(".")
    if extension not in EXTENSIONS:
        raise ValueError("invalid_file")
    return extension


def part_count(size, part_size=PART_SIZE):
    """How many parts a file of this size needs, checked against the hard cap."""
    count = math.ceil(size / part_size)
    if not 1 <= count <= MAX_PARTS:
        raise ValueError("file_too_large")
    return count


def _object_key(storage, storage_name):
    return posixpath.join(storage.location, storage_name)


def _session(user, session_id):
    session = models.RecordingUploadSession.objects.filter(
        pk=session_id, owner=user
    ).first()
    if session is None:
        raise LookupError("No such upload session.")
    return session


def _parts_for(session):
    """The parts already stored, according to storage rather than the client.

    This is the resume list. A part the client believes it sent but storage never
    received must not appear here, and a part storage holds but the client forgot
    must — the point of resuming is to skip work that is genuinely done.
    """
    storage = audio_storage()
    uploaded = []
    marker = 0
    while True:
        page = storage.connection.meta.client.list_parts(
            Bucket=storage.bucket_name,
            Key=_object_key(storage, session.storage_name),
            UploadId=session.upload_id,
            PartNumberMarker=marker,
        )
        for part in page.get("Parts", []):
            uploaded.append(
                {
                    "part_number": int(part["PartNumber"]),
                    "etag": str(part["ETag"]).strip('"'),
                    "size": int(part["Size"]),
                }
            )
        if not page.get("IsTruncated"):
            break
        marker = int(page.get("NextPartNumberMarker") or 0)
        if marker <= 0:
            break
    uploaded.sort(key=lambda part: part["part_number"])
    return uploaded


def _completed_object(session):
    """Verify the exact server-assigned object after a lost Complete response."""
    storage = audio_storage()
    try:
        head = storage.connection.meta.client.head_object(
            Bucket=storage.bucket_name, Key=_object_key(storage, session.storage_name)
        )
    except ClientError as error:
        if str(error.response.get("Error", {}).get("Code")) in {
            "404",
            "NoSuchKey",
            "NotFound",
        }:
            return False
        raise
    if head.get("ContentLength") != session.size:
        raise ValueError("upload_size_mismatch")
    if head.get("ContentType") != session.content_type:
        raise ValueError("invalid_media_content")
    intent = head.get("Metadata", {}).get("upload-intent")
    # Older sessions predate this marker; their object key was also generated
    # exclusively on the server and cannot be chosen in a completion request.
    if intent is not None and intent != _session_checksum(session):
        raise RecordConflict("Upload intent changed.")
    _verify_stored_header(storage, session.storage_name, session.extension)
    return True


def _resume_parts(session):
    if session.status == models.RecordingUploadSession.Status.ABORTED:
        raise ValueError("session_aborted")
    if session.status == models.RecordingUploadSession.Status.COMPLETED:
        return None
    try:
        return _parts_for(session)
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") != "NoSuchUpload":
            raise
        if _completed_object(session):
            return None
        raise


def serialize_session(session, uploaded):
    """What a client needs to resume, and nothing that widens read access."""
    return {
        "session_id": str(session.pk),
        "storage_name": session.storage_name,
        "size": session.size,
        "part_size": session.part_size,
        "part_count": part_count(session.size, session.part_size),
        "expires_in": settings.MEETING_FILE_DIRECT_UPLOAD_TTL_SECONDS,
        # Echoed so a client can compute progress without re-deriving the plan.
        "completion_pending": uploaded is None,
        "uploaded": uploaded or [],
        "uploaded_bytes": session.size
        if uploaded is None
        else sum(part["size"] for part in uploaded),
    }


def _session_options(session):
    """The caller's own options, exactly as they were declared.

    Kept separate from `declared_name`, which is presentation rather than an
    option: folding it in here would make the same intent hash two different ways
    and quietly break the replay guard.
    """
    return dict(session.configuration)


def _session_checksum(session):
    return _upload_checksum(
        session.key,
        session.size,
        session.content_type,
        _session_options(session),
    )


def begin(user, *, name, size, content_type, key, options):  # noqa: PLR0913 -- the declaration is the request body
    """Open a multipart upload and return the plan the client should follow.

    Idempotent on ``(owner, key)``: repeating the same intent returns the same
    session, so a client that lost its own state can ask again rather than
    starting a second upload and paying for the bytes twice.
    """
    if not direct_upload_available() or not user.is_active:
        raise PermissionError("direct_upload_unavailable")
    extension = _extension(name)
    if not 0 < size <= settings.MEETING_FILE_DIRECT_UPLOAD_MAX_BYTES:
        raise ValueError("invalid_file")
    _declared_media_ok(extension, content_type)
    part_size = PART_SIZE
    part_count(size, part_size)
    # Stored raw, exactly as the whole-file path does, so the replay digest is
    # computed from the same material at `begin` and at adoption.
    configuration = dict(options)
    checksum = _upload_checksum(key, size, content_type, configuration)

    with transaction.atomic():
        models.User.objects.select_for_update().get(pk=user.pk, is_active=True)
        existing = models.RecordingUploadSession.objects.filter(
            owner=user, key=key
        ).first()
        if existing:
            # A changed declaration is a different intent, not a resume.
            if (
                existing.size != size
                or existing.content_type != content_type
                or existing.extension != extension
                or _session_options(existing) != configuration
            ):
                raise RecordConflict("Upload intent changed.")
            if existing.status == models.RecordingUploadSession.Status.ABORTED:
                raise RecordConflict("Upload session was aborted.")
            if existing.status == models.RecordingUploadSession.Status.OPEN:
                return existing, _resume_parts(existing)
            # Already completed: the job exists, so replay it rather than
            # opening a second upload for the same intent.
            previous = _replay_guard(
                user,
                key,
                _session_checksum(existing),
                _job_configuration(configuration),
            )
            if previous:
                return previous, []
            raise RecordConflict("Upload session already completed.")
        if active_upload_exists(user):
            raise RecordConflict("An upload transcription is already active.")

        storage = audio_storage()
        storage_name = f"record-uploads/{uuid.uuid4()}.{extension}"
        created = storage.connection.meta.client.create_multipart_upload(
            Bucket=storage.bucket_name,
            Key=_object_key(storage, storage_name),
            ContentType=content_type,
            ACL="private",
            Metadata={"upload-intent": checksum},
        )
        session = models.RecordingUploadSession.objects.create(
            owner=user,
            key=key,
            declared_name=name[:255],
            storage_name=storage_name,
            upload_id=str(created["UploadId"]),
            size=size,
            content_type=content_type,
            extension=extension,
            part_size=part_size,
            configuration=configuration,
        )
        return session, []


def _upload_checksum(key, size, content_type, configuration):
    """A stable digest for the replay guard, computed before any byte lands.

    The multipart path hashes the stream; this path cannot, because the bytes
    never pass through the application. The declaration stands in for it, exactly
    as `complete_direct_upload` uses the verified stored length for its own.
    """
    material = f"{key}:{size}:{content_type}:{sorted(configuration.items())}"
    return hashlib.sha256(material.encode()).hexdigest()


def sign_parts(user, session_id, part_numbers):
    """Sign one PUT per part, scoped to this session's own upload id."""
    session = _session(user, session_id)
    if session.status != models.RecordingUploadSession.Status.OPEN:
        raise ValueError("session_not_open")
    total = part_count(session.size, session.part_size)
    wanted = sorted(set(part_numbers))
    if not wanted:
        raise ValueError("invalid_part_number")
    if len(wanted) > MAX_PARTS_PER_SIGNING:
        raise ValueError("too_many_parts")
    storage = audio_storage()
    key = _object_key(storage, session.storage_name)
    signed = []
    for number in wanted:
        if not 1 <= number <= total:
            raise ValueError("invalid_part_number")
        # The last part is whatever is left over, and may be shorter than the
        # rest; every other part is exactly part_size.
        expected = session.part_size
        if number == total:
            expected = session.size - session.part_size * (total - 1)
        url = storage.connection.meta.client.generate_presigned_url(
            ClientMethod="upload_part",
            Params={
                "Bucket": storage.bucket_name,
                "Key": key,
                "UploadId": session.upload_id,
                "PartNumber": number,
            },
            ExpiresIn=settings.MEETING_FILE_DIRECT_UPLOAD_TTL_SECONDS,
        )
        signed.append({"part_number": number, "url": url, "expected_bytes": expected})
    return session, signed


def resume(user, session_id):
    """What is already stored, so a client can skip the parts it finished."""
    session = _session(user, session_id)
    return session, _resume_parts(session)


@transaction.atomic
def complete(user, session_id, parts):
    """Reassemble the object, then adopt it as a job.

    The client supplies the ETags because only it saw the responses; the *set* of
    parts is still cross-checked against storage, so a client cannot complete an
    upload while silently omitting bytes.
    """
    models.User.objects.select_for_update().get(pk=user.pk, is_active=True)
    session = _session(user, session_id)
    if session.status == models.RecordingUploadSession.Status.ABORTED:
        raise ValueError("session_aborted")
    if session.status == models.RecordingUploadSession.Status.COMPLETED:
        return adopt(user, session)
    if _completed_object(session):
        return adopt(user, session)
    stored = {part["part_number"]: part for part in _parts_for(session)}
    total = part_count(session.size, session.part_size)
    supplied = {}
    for part in parts:
        number = int(part["part_number"])
        etag = str(part["etag"]).strip('"')
        if not 1 <= number <= total or number in supplied:
            raise ValueError("invalid_part_number")
        known = stored.get(number)
        if known is None or known["etag"] != etag:
            raise ValueError("part_not_uploaded")
        supplied[number] = etag
    if len(supplied) != total:
        raise ValueError("incomplete_upload")
    if sum(part["size"] for part in stored.values()) != session.size:
        raise ValueError("upload_size_mismatch")

    storage = audio_storage()
    try:
        storage.connection.meta.client.complete_multipart_upload(
            Bucket=storage.bucket_name,
            Key=_object_key(storage, session.storage_name),
            UploadId=session.upload_id,
            MultipartUpload={
                "Parts": [
                    {"PartNumber": number, "ETag": supplied[number]}
                    for number in sorted(supplied)
                ]
            },
        )
    except Exception:
        # A timeout is uncertain: the storage service may have committed.
        if not _completed_object(session):
            raise
    else:
        if not _completed_object(session):
            raise ValueError("completed_object_missing")
    return adopt(user, session)


@transaction.atomic
def adopt(user, session):
    """Turn a completed multipart object into the job the worker will process."""
    models.User.objects.select_for_update().get(pk=user.pk, is_active=True)
    session = models.RecordingUploadSession.objects.select_for_update().get(
        pk=session.pk, owner=user
    )
    if session.status == models.RecordingUploadSession.Status.ABORTED:
        raise ValueError("session_aborted")
    if session.status == models.RecordingUploadSession.Status.COMPLETED:
        previous = _replay_guard(
            user,
            session.key,
            _session_checksum(session),
            _job_configuration(_session_options(session)),
        )
        if previous:
            return previous
        raise ValueError("session_completed")
    checksum = _session_checksum(session)
    previous = _replay_guard(
        user, session.key, checksum, _job_configuration(_session_options(session))
    )
    if previous:
        session.status = models.RecordingUploadSession.Status.COMPLETED
        session.save(update_fields=["status", "updated_at"])
        return previous
    metadata = {
        "name": Path(session.storage_name).name[:255],
        "media_type": "video" if session.extension in VIDEO_EXTENSIONS else "audio",
    }
    job = _record_job(
        user,
        session.key,
        storage_name=session.storage_name,
        checksum=checksum,
        size=session.size,
        configuration=_job_configuration(_session_options(session)),
        metadata={
            "title": Path(session.declared_name).stem
            or Path(session.storage_name).stem,
            "file": metadata,
        },
    )
    session.status = models.RecordingUploadSession.Status.COMPLETED
    session.save(update_fields=["status", "updated_at"])
    return job


@transaction.atomic
def abort(user, session_id):
    """Drop an upload in progress.

    Aborting matters beyond tidiness: object storage bills for parts of an
    incomplete upload, so a cancelled import that is merely forgotten keeps
    costing money for as long as the upload lives.
    """
    models.User.objects.select_for_update().get(pk=user.pk, is_active=True)
    session = _session(user, session_id)
    if session.status == models.RecordingUploadSession.Status.COMPLETED:
        raise ValueError("session_completed")
    if session.status == models.RecordingUploadSession.Status.OPEN:
        storage = audio_storage()
        try:
            storage.connection.meta.client.abort_multipart_upload(
                Bucket=storage.bucket_name,
                Key=_object_key(storage, session.storage_name),
                UploadId=session.upload_id,
            )
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") != "NoSuchUpload":
                raise
            # Explicit cancellation may arrive after assembly but before adoption.
            # Invalid media must also be cancellable; the server assigned this key.
            storage.delete(session.storage_name)
    session.status = models.RecordingUploadSession.Status.ABORTED
    session.save(update_fields=["status", "updated_at"])
    return session


def media_type_for(extension):
    """The MIME a reader should be told, mirroring the whole-file path."""
    return sorted(MEDIA_MIMES.get(extension, {"application/octet-stream"}))[0]
