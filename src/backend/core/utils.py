"""
Utils functions used in the core app
"""

# pylint: disable=R0913, R0917
# ruff: noqa:S311, PLR0913

import hashlib
import json
import logging
import mimetypes
import random
import secrets
import string
from typing import List, Optional
from uuid import uuid4

from django.conf import settings
from django.core.files.storage import default_storage

import aiohttp
import boto3
import botocore
import magic
from asgiref.sync import async_to_sync
from livekit.api import (  # pylint: disable=E0611
    AccessToken,
    ListRoomsRequest,
    LiveKitAPI,
    SendDataRequest,
    TwirpError,
    UpdateRoomMetadataRequest,
    VideoGrants,
)

logger = logging.getLogger(__name__)


def generate_color(identity: str) -> str:
    """Generates a consistent HSL color based on a given identity string.

    The function seeds the random generator with the identity's hash,
    ensuring consistent color output. The HSL format allows fine-tuned control
    over saturation and lightness, empirically adjusted to produce visually
    appealing and distinct colors. HSL is preferred over hex to constrain the color
    range and ensure predictability.
    """

    # ruff: noqa:S324
    identity_hash = hashlib.sha1(identity.encode("utf-8"))
    # Keep only hash's last 16 bits, collisions are not a concern
    seed = int(identity_hash.hexdigest(), 16) & 0xFFFF
    random.seed(seed)
    hue = random.randint(0, 360)
    saturation = random.randint(50, 75)
    lightness = random.randint(25, 60)

    return f"hsl({hue}, {saturation}%, {lightness}%)"


def generate_token(
    room: str,
    user,
    username: Optional[str] = None,
    color: Optional[str] = None,
    sources: Optional[List[str]] = None,
    is_admin_or_owner: bool = False,
    participant_id: Optional[str] = None,
) -> str:
    """Generate a LiveKit access token for a user in a specific room.

    Args:
        room (str): The name of the room.
        user (User): The user which request the access token.
        username (Optional[str]): The username to be displayed in the room.
                         If none, a default value will be used.
        color (Optional[str]): The color to be displayed in the room.
                         If none, a value will be generated
        sources: (Optional[List[str]]): List of media sources the user can publish
                         If none, defaults to LIVEKIT_DEFAULT_SOURCES.
        is_admin_or_owner (bool): Whether user has admin privileges
        participant_id (Optional[str]): Stable identifier for anonymous users;
                         used as identity when user.is_anonymous.

    Returns:
        str: The LiveKit JWT access token.
    """

    if is_admin_or_owner:
        sources = settings.LIVEKIT_DEFAULT_SOURCES

    if sources is None:
        sources = settings.LIVEKIT_DEFAULT_SOURCES

    video_grants = VideoGrants(
        room=room,
        room_join=True,
        room_admin=is_admin_or_owner,
        can_update_own_metadata=False,
        can_publish=bool(sources),
        can_publish_sources=sources,
        can_subscribe=True,
    )

    if user.is_anonymous:
        identity = participant_id or str(uuid4())
        default_username = "Anonymous"
    else:
        identity = str(user.sub)
        default_username = str(user)

    if color is None:
        color = generate_color(identity)

    display_name = username or default_username

    token = (
        AccessToken(
            api_key=settings.LIVEKIT_CONFIGURATION["api_key"],
            api_secret=settings.LIVEKIT_CONFIGURATION["api_secret"],
        )
        .with_grants(video_grants)
        .with_identity(identity)
        .with_name(display_name)
        # Mirror the display name into participant attributes too:
        # livekit-rtc on the agent side exposes attributes more reliably
        # than the JWT-claim-only ``name`` field on RemoteParticipant.
        # The transcriber agent reads this to populate Transcript.speaker_name.
        .with_attributes(
            {
                "color": color,
                "room_admin": "true" if is_admin_or_owner else "false",
                "name": display_name,
            }
        )
    )

    return token.to_jwt()


def generate_livekit_config(
    room_id: str,
    user,
    username: str,
    is_admin_or_owner: bool,
    color: Optional[str] = None,
    configuration: Optional[dict] = None,
    participant_id: Optional[str] = None,
) -> dict:
    """Generate LiveKit configuration for room access.

    Args:
        room_id: Room identifier
        user: User instance requesting access
        username: Display name in room
        is_admin_or_owner (bool): Whether the user has admin/owner privileges for this room.
        color (Optional[str]): Optional color to associate with the participant.
        configuration (Optional[dict]): Room configuration dict that can override default settings.
        participant_id (Optional[str]): Stable identifier for anonymous users;
                         used as identity when user.is_anonymous.

    Returns:
        dict: LiveKit configuration with URL, room and access token
    """

    sources = None
    if configuration is not None:
        sources = configuration.get("can_publish_sources", None)

    return {
        "url": settings.LIVEKIT_CONFIGURATION["url"],
        "room": room_id,
        "token": generate_token(
            room=room_id,
            user=user,
            username=username,
            color=color,
            sources=sources,
            is_admin_or_owner=is_admin_or_owner,
            participant_id=participant_id,
        ),
    }


def generate_s3_authorization_headers(key):
    """
    Generate authorization headers for an s3 object.
    These headers can be used as an alternative to signed urls with many benefits:
    - the urls of our files never expire and can be stored in our recording' metadata
    - we don't leak authorized urls that could be shared (file access can only be done
      with cookies)
    - access control is truly realtime
    - the object storage service does not need to be exposed on internet
    """

    url = default_storage.unsigned_connection.meta.client.generate_presigned_url(
        "get_object",
        ExpiresIn=0,
        Params={"Bucket": default_storage.bucket_name, "Key": key},
    )

    request = botocore.awsrequest.AWSRequest(method="get", url=url)

    s3_client = default_storage.connection.meta.client
    # pylint: disable=protected-access
    credentials = s3_client._request_signer._credentials  # noqa: SLF001
    frozen_credentials = credentials.get_frozen_credentials()
    region = s3_client.meta.region_name
    auth = botocore.auth.S3SigV4Auth(frozen_credentials, "s3", region)
    auth.add_auth(request)

    return request


def create_livekit_client(custom_configuration=None):
    """Create and return a configured LiveKit API client."""

    custom_session = None

    if not settings.LIVEKIT_VERIFY_SSL:
        connector = aiohttp.TCPConnector(ssl=False)
        custom_session = aiohttp.ClientSession(connector=connector)

    # Use default configuration if none provided
    configuration = custom_configuration or settings.LIVEKIT_CONFIGURATION

    return LiveKitAPI(session=custom_session, **configuration)


class NotificationError(Exception):
    """Notification delivery to room participants fails."""


@async_to_sync
async def notify_participants(room_name: str, notification_data: dict):
    """Send notification data to all participants in a LiveKit room."""

    lkapi = create_livekit_client()

    try:
        room_response = await lkapi.room.list_rooms(
            ListRoomsRequest(
                names=[room_name],
            )
        )

        # Check if the room exists
        if not room_response.rooms:
            return

        await lkapi.room.send_data(
            SendDataRequest(
                room=room_name,
                data=json.dumps(notification_data).encode("utf-8"),
                kind="RELIABLE",
            )
        )
    except TwirpError as e:
        raise NotificationError("Failed to notify room participants") from e
    finally:
        await lkapi.aclose()


class MetadataUpdateException(Exception):
    """Room's metadata update fails."""


@async_to_sync
async def update_room_metadata(
    room_name: str, metadata: dict, remove_keys: Optional[list[str]] = None
):
    """Update LiveKit room metadata by merging new values with existing metadata.

    Args:
        room_name: Name of the room to update
        metadata: Dictionary of metadata key-values to add/update
        remove_keys: Optional list of keys to remove from existing metadata.
    """

    lkapi = create_livekit_client()

    try:
        response = await lkapi.room.list_rooms(
            ListRoomsRequest(
                names=[room_name],
            )
        )

        if not response.rooms:
            return

        room = response.rooms[0]

        existing_metadata = json.loads(room.metadata) if room.metadata else {}

        if remove_keys:
            for key in remove_keys:
                existing_metadata.pop(key, None)

        updated_metadata = {**existing_metadata, **metadata}

        await lkapi.room.update_room_metadata(
            UpdateRoomMetadataRequest(
                room=room_name, metadata=json.dumps(updated_metadata).encode("utf-8")
            )
        )
    except TwirpError as e:
        raise MetadataUpdateException(
            f"Failed to update metadata for room {room_name}: {e}"
        ) from e
    finally:
        await lkapi.aclose()


ALPHANUMERIC_CHARSET = string.ascii_letters + string.digits


def generate_secure_token(length: int = 30, charset: str = ALPHANUMERIC_CHARSET) -> str:
    """Generate a cryptographically secure random token.

    Uses SystemRandom for proper entropy, suitable for OAuth tokens
    and API credentials that must be non-guessable.

    Inspired by: https://github.com/oauthlib/oauthlib/blob/master/oauthlib/common.py

    Args:
        length: Token length in characters (default: 30)
        charset: Character set to use for generation

    Returns:
        Cryptographically secure random token
    """
    return "".join(secrets.choice(charset) for _ in range(length))


def generate_client_id() -> str:
    """Generate a unique client ID for application authentication.

    Returns:
        Random client ID string
    """
    return generate_secure_token(settings.APPLICATION_CLIENT_ID_LENGTH)


def generate_client_secret() -> str:
    """Generate a secure client secret for application authentication.

    Returns:
        Cryptographically secure client secret
    """
    return generate_secure_token(settings.APPLICATION_CLIENT_SECRET_LENGTH)


def generate_room_slug():
    """Generate a random room slug in the format 'xxx-xxxx-xxx'."""

    sizes = [3, 4, 3]
    parts = [
        "".join(secrets.choice(string.ascii_lowercase) for _ in range(size))
        for size in sizes
    ]
    return "-".join(parts)


def detect_mimetype(file_buffer: bytes, filename: str | None = None) -> str:
    """
    Detect MIME type using multiple methods for better accuracy.

    This function combines:
    1. Magic bytes detection (python-magic) - most reliable for actual file content
    2. File extension detection (mimetypes) - useful as fallback or for validation

    Args:
        file_buffer: The file content buffer (first bytes of the file)
        filename: Optional filename to extract extension from

    Returns:
        str: The detected MIME type

    Notes:
        Originally from https://github.com/suitenumerique/drive/blob/564822d31f071c6dfacd112ef4b7146c73077cd9/src/backend/core/api/utils.py#L166 # pylint:disable=line-too-long
    """
    # Initialize magic detector
    mime_detector = magic.Magic(mime=True)

    # Method 1: Detect from file content (magic bytes) - most reliable
    mimetype_from_content = mime_detector.from_buffer(file_buffer)

    # If we have a filename, try extension-based detection as well
    mimetype_from_extension = None
    if filename:
        # Use mimetypes module to guess from extension
        # Use guess_file_type (Python 3.13+) instead of deprecated guess_type
        mimetype_from_extension, _ = mimetypes.guess_file_type(filename, strict=False)

    logger.debug("detect_mimetype: mimetype_from_content: %s", mimetype_from_content)
    logger.debug(
        "detect_mimetype: mimetype_from_extension: %s", mimetype_from_extension
    )

    # Strategy: Prefer content-based detection, but use extension if:
    # 1. Content detection returns generic types (application/octet-stream, text/plain)
    # 2. Content detection fails or returns None
    # 3. Extension detection provides a more specific type

    # Generic/unreliable MIME types that we should try to improve
    generic_types = {
        "application/octet-stream",
        "application/x-ole-storage",  # used by .xls, .doc and .ppt
        "application/zip",
        "text/plain",
    }

    # If content detection gives us a generic type and we have extension info
    if mimetype_from_content in generic_types and mimetype_from_extension:
        # Use extension-based detection if it's more specific
        if mimetype_from_extension not in generic_types:
            return mimetype_from_extension

    # If content detection failed, returned None or is a generic type, use extension if available
    if not mimetype_from_content or mimetype_from_content in generic_types:
        if mimetype_from_extension:
            return mimetype_from_extension

    # Default to content-based detection (most reliable)
    return mimetype_from_content or "application/octet-stream"


def generate_upload_policy(file):
    """
    Generate a S3 upload policy for a given file.

    Notes:
        Originally taken from https://github.com/suitenumerique/drive/blob/564822d31f071c6dfacd112ef4b7146c73077cd9/src/backend/core/api/utils.py#L102  # pylint: disable=line-too-long
    """

    key = file.file_key

    # This settings should be used if the backend application and the frontend application
    # can't connect to the object storage with the same domain. This is the case in the
    # docker compose stack used in development. The frontend application will use localhost
    # to connect to the object storage while the backend application will use the object storage
    # service name declared in the docker compose stack.
    # This is needed because the domain name is used to compute the signature. So it can't be
    # changed dynamically by the frontend application.
    if settings.AWS_S3_DOMAIN_REPLACE:
        s3_client = boto3.client(
            "s3",
            aws_access_key_id=settings.AWS_S3_ACCESS_KEY_ID,
            aws_secret_access_key=settings.AWS_S3_SECRET_ACCESS_KEY,
            endpoint_url=settings.AWS_S3_DOMAIN_REPLACE,
            config=botocore.client.Config(
                region_name=settings.AWS_S3_REGION_NAME,
                signature_version=settings.AWS_S3_SIGNATURE_VERSION,
            ),
        )
    else:
        s3_client = default_storage.connection.meta.client

    # Generate the policy
    policy = s3_client.generate_presigned_url(
        ClientMethod="put_object",
        Params={"Bucket": default_storage.bucket_name, "Key": key, "ACL": "private"},
        ExpiresIn=settings.AWS_S3_UPLOAD_POLICY_EXPIRATION,
    )

    return policy


# ---------------------------------------------------------------------------
# Mobile app — profile image uploads (avatar / cover)
#
# Each kind lives in its own PRIVATE bucket. Upload uses a presigned PUT
# (client PUTs bytes straight to object storage, then confirms the object_key
# back to the API). Reads use a short-lived presigned GET URL generated on
# demand — no object is ever publicly readable. A dedicated boto3 client is
# used so the global `default_storage` backend keeps its own configuration.
# ---------------------------------------------------------------------------

# Max size of an uploaded avatar / cover image (2 MiB).
MAX_PROFILE_IMAGE_SIZE = 2 * 1024 * 1024

# Lifetime of a presigned profile-image PUT URL (upload).
PROFILE_UPLOAD_URL_TTL_SECONDS = 300

# Lifetime of a presigned profile-image GET URL (handed to clients on read).
PROFILE_IMAGE_GET_URL_TTL_SECONDS = 3600

# Allowed profile image MIME types → file extension.
ALLOWED_PROFILE_IMAGE_MIME_TYPES = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}

# Maps an upload "kind" to the User model field storing its object key.
PROFILE_IMAGE_KIND_FIELDS = {
    "avatar": "avatar_key",
    "cover": "cover_key",
}


def get_profile_kind_bucket(kind: str) -> str:
    """Return the storage bucket configured for a given profile image kind."""
    if kind == "avatar":
        return settings.AWS_STORAGE_BUCKET_NAME_AVATAR
    if kind == "cover":
        return settings.AWS_STORAGE_BUCKET_NAME_COVER
    raise ValueError(f"Unknown profile image kind: {kind!r}")


def _profile_s3_client():
    """Build a boto3 S3 client for the profile image buckets.

    Uses virtual-hosted addressing. Built independently from
    ``default_storage`` so the global storage backend keeps its own config.
    """
    return boto3.client(
        "s3",
        aws_access_key_id=settings.AWS_S3_ACCESS_KEY_ID,
        aws_secret_access_key=settings.AWS_S3_SECRET_ACCESS_KEY,
        endpoint_url=settings.AWS_S3_ENDPOINT_URL,
        region_name=settings.AWS_S3_REGION_NAME,
        config=botocore.client.Config(
            signature_version=settings.AWS_S3_SIGNATURE_VERSION,
            s3={"addressing_style": "virtual"},
        ),
    )


def build_profile_object_key(user_id, content_type: str) -> str:
    """Build the S3 key for a profile image: ``{user_id}/{short-uuid}.{ext}``.

    The bucket already partitions by kind, so the key only needs the user
    namespace; the short uuid keeps it collision-free and unguessable.
    """
    extension = ALLOWED_PROFILE_IMAGE_MIME_TYPES[content_type]
    return f"{user_id}/{uuid4().hex[:16]}.{extension}"


def generate_profile_image_upload_url(
    *, user, kind: str, content_type: str, size: int
) -> dict:
    """Issue a short-lived presigned PUT URL for a profile image upload.

    The caller MUST validate ``kind``, ``content_type`` and ``size`` first —
    the request is signed as-is.
    """
    bucket = get_profile_kind_bucket(kind)
    object_key = build_profile_object_key(user.id, content_type)
    upload_url = _profile_s3_client().generate_presigned_url(
        "put_object",
        Params={
            "Bucket": bucket,
            "Key": object_key,
            "ContentType": content_type,
            "ContentLength": size,
        },
        ExpiresIn=PROFILE_UPLOAD_URL_TTL_SECONDS,
        HttpMethod="PUT",
    )
    return {
        "upload_url": upload_url,
        "object_key": object_key,
        "expires_in": PROFILE_UPLOAD_URL_TTL_SECONDS,
        "headers": {"Content-Type": content_type},
    }


def generate_profile_image_get_url(kind: str, object_key: str) -> str:
    """Return a short-lived presigned GET URL for a profile image.

    Returns an empty string when ``object_key`` is unset. The buckets are
    private, so this signed URL is the only way to read the image; clients
    must treat it as expiring and re-fetch the profile to refresh it.
    """
    if not object_key:
        return ""
    bucket = get_profile_kind_bucket(kind)
    return _profile_s3_client().generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": object_key},
        ExpiresIn=PROFILE_IMAGE_GET_URL_TTL_SECONDS,
        HttpMethod="GET",
    )


# ---------------------------------------------------------------------------
# Chat images (IM 图片消息) — same presigned pattern as profile images, but a
# dedicated bucket and its own (looser) MIME / size limits. The object key is
# carried in the IM message body (content_type='image'); the message text lives
# in jusi-light-im, so no we-meet table is needed.
# ---------------------------------------------------------------------------

# Max size of an uploaded chat image (10 MiB).
MAX_CHAT_IMAGE_SIZE = 10 * 1024 * 1024

# Allowed chat image MIME types → file extension (adds gif over profile images).
ALLOWED_CHAT_IMAGE_MIME_TYPES = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
}

# Every chat-image key starts with this prefix; resolve only signs these.
CHAT_IMAGE_KEY_PREFIX = "chat/"


def build_chat_image_object_key(user_id, content_type: str) -> str:
    """Build the S3 key for a chat image: ``chat/{user_id}/{short-uuid}.{ext}``.

    The ``chat/`` prefix lets the resolve endpoint refuse to sign arbitrary
    keys; the short uuid keeps it collision-free and unguessable.
    """
    extension = ALLOWED_CHAT_IMAGE_MIME_TYPES[content_type]
    return f"{CHAT_IMAGE_KEY_PREFIX}{user_id}/{uuid4().hex[:16]}.{extension}"


def generate_chat_image_upload_url(*, user, content_type: str, size: int) -> dict:
    """Issue a short-lived presigned PUT URL for a chat image upload.

    The caller MUST validate ``content_type`` and ``size`` first — the request
    is signed as-is.
    """
    object_key = build_chat_image_object_key(user.id, content_type)
    upload_url = _profile_s3_client().generate_presigned_url(
        "put_object",
        Params={
            "Bucket": settings.AWS_STORAGE_BUCKET_NAME_CHAT_IMAGE,
            "Key": object_key,
            "ContentType": content_type,
            "ContentLength": size,
        },
        ExpiresIn=PROFILE_UPLOAD_URL_TTL_SECONDS,
        HttpMethod="PUT",
    )
    return {
        "upload_url": upload_url,
        "object_key": object_key,
        "expires_in": PROFILE_UPLOAD_URL_TTL_SECONDS,
        "headers": {"Content-Type": content_type},
    }


# Chat file attachments live in their own bucket under this key prefix; the
# prefix is how the resolve endpoint routes a key to the right bucket.
CHAT_FILE_KEY_PREFIX = "file/"


# Chat voice messages live in their own bucket under this key prefix.
CHAT_AUDIO_KEY_PREFIX = "audio/"


def _chat_bucket_for_key(object_key: str) -> str | None:
    """Pick the storage bucket for a chat object key by its prefix, or None."""
    if object_key.startswith(CHAT_IMAGE_KEY_PREFIX):
        return settings.AWS_STORAGE_BUCKET_NAME_CHAT_IMAGE
    if object_key.startswith(CHAT_FILE_KEY_PREFIX):
        return settings.AWS_STORAGE_BUCKET_NAME_CHAT_FILE
    if object_key.startswith(CHAT_AUDIO_KEY_PREFIX):
        return settings.AWS_STORAGE_BUCKET_NAME_CHAT_AUDIO
    return None


def generate_chat_object_get_url(object_key: str) -> str:
    """Return a short-lived presigned GET URL for a chat object (image or file).

    Routes by key prefix: ``chat/`` → image bucket, ``file/`` → file bucket,
    ``audio/`` → voice bucket.
    Returns '' for an unset key or any other prefix — the endpoint refuses to
    sign arbitrary keys, and the private buckets make the signed URL the only
    way to read the object; clients treat it as expiring and re-resolve.
    """
    if not object_key:
        return ""
    bucket = _chat_bucket_for_key(object_key)
    if bucket is None:
        return ""
    return _profile_s3_client().generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": object_key},
        ExpiresIn=PROFILE_IMAGE_GET_URL_TTL_SECONDS,
        HttpMethod="GET",
    )


# Max size of an uploaded chat FILE attachment (50 MiB).
MAX_CHAT_FILE_SIZE = 50 * 1024 * 1024


def _safe_ext(filename: str) -> str:
    """Lower-cased, alnum-only file extension (≤10 chars) from a filename, or ''.

    Only cosmetic — the real filename is carried in the message body; this just
    keeps the storage key tidy.
    """
    if not filename or "." not in filename:
        return ""
    ext = filename.rsplit(".", 1)[-1].lower()
    ext = "".join(c for c in ext if c.isalnum())[:10]
    return ext


def build_chat_file_object_key(user_id, filename: str) -> str:
    """Build the S3 key for a chat file: ``file/{user_id}/{short-uuid}[.ext]``.

    The ``file/`` prefix routes resolve to the dedicated file bucket; the
    original filename lives in the message body.
    """
    ext = _safe_ext(filename)
    name = uuid4().hex[:16]
    suffix = f".{ext}" if ext else ""
    return f"{CHAT_FILE_KEY_PREFIX}{user_id}/{name}{suffix}"


def generate_chat_file_upload_url(
    *, user, content_type: str, size: int, filename: str
) -> dict:
    """Issue a short-lived presigned PUT URL for a chat file attachment.

    Any content type is allowed (it is echoed back as the object's Content-Type);
    the caller MUST validate ``size`` first. Stored in the dedicated private
    chat-file bucket, read back via the shared resolve endpoint.
    """
    object_key = build_chat_file_object_key(user.id, filename)
    upload_url = _profile_s3_client().generate_presigned_url(
        "put_object",
        Params={
            "Bucket": settings.AWS_STORAGE_BUCKET_NAME_CHAT_FILE,
            "Key": object_key,
            "ContentType": content_type,
            "ContentLength": size,
        },
        ExpiresIn=PROFILE_UPLOAD_URL_TTL_SECONDS,
        HttpMethod="PUT",
    )
    return {
        "upload_url": upload_url,
        "object_key": object_key,
        "expires_in": PROFILE_UPLOAD_URL_TTL_SECONDS,
        "headers": {"Content-Type": content_type},
    }


# Max size of an uploaded chat VOICE clip (20 MiB — 60s of audio is far less).
MAX_CHAT_AUDIO_SIZE = 20 * 1024 * 1024


def build_chat_audio_object_key(user_id, filename: str) -> str:
    """Build the S3 key for a chat voice clip: ``audio/{user_id}/{short-uuid}[.ext]``.

    The ``audio/`` prefix routes resolve to the dedicated voice bucket.
    """
    ext = _safe_ext(filename)
    name = uuid4().hex[:16]
    suffix = f".{ext}" if ext else ""
    return f"{CHAT_AUDIO_KEY_PREFIX}{user_id}/{name}{suffix}"


def generate_chat_audio_upload_url(
    *, user, content_type: str, size: int, filename: str
) -> dict:
    """Issue a short-lived presigned PUT URL for a chat voice clip.

    Any (audio) content type is allowed — echoed back as the object's
    Content-Type; the caller MUST validate ``size`` first. Stored in the
    dedicated private voice bucket, read back via the shared resolve endpoint.
    """
    object_key = build_chat_audio_object_key(user.id, filename)
    upload_url = _profile_s3_client().generate_presigned_url(
        "put_object",
        Params={
            "Bucket": settings.AWS_STORAGE_BUCKET_NAME_CHAT_AUDIO,
            "Key": object_key,
            "ContentType": content_type,
            "ContentLength": size,
        },
        ExpiresIn=PROFILE_UPLOAD_URL_TTL_SECONDS,
        HttpMethod="PUT",
    )
    return {
        "upload_url": upload_url,
        "object_key": object_key,
        "expires_in": PROFILE_UPLOAD_URL_TTL_SECONDS,
        "headers": {"Content-Type": content_type},
    }


def head_profile_object(kind: str, object_key: str):
    """HEAD an S3 object; return ``(size, content_type)`` or ``None`` if missing."""
    bucket = get_profile_kind_bucket(kind)
    try:
        head = _profile_s3_client().head_object(Bucket=bucket, Key=object_key)
    except botocore.exceptions.ClientError as exc:
        logger.info("HEAD profile object %s/%s failed: %s", bucket, object_key, exc)
        return None
    return head.get("ContentLength", 0), head.get("ContentType", "")


def delete_profile_object(kind: str, object_key: str) -> None:
    """Best-effort delete of a profile image object by its key.

    Failure is logged and swallowed so storage GC errors never block a
    profile update.
    """
    if not object_key:
        return
    bucket = get_profile_kind_bucket(kind)
    try:
        _profile_s3_client().delete_object(Bucket=bucket, Key=object_key)
    except botocore.exceptions.ClientError as exc:
        logger.warning(
            "Failed to delete profile object %s/%s: %s", bucket, object_key, exc
        )
