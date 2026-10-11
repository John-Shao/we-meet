"""Short, private local media reads. Object download/authorization is separate."""

import io
import json
import math
import wave
from dataclasses import dataclass, field
from pathlib import Path

from core.services.voiceprint_media_process import MediaError, invoke

MAX_SOURCE_BYTES = 512 * 1024 * 1024
MAX_DURATION_MS = 7200000
FORMATS = "aac,aiff,amr,asf,flac,matroska,webm,mov,mp3,mpeg,mpegts,ogg,wav"


@dataclass(frozen=True)
class MediaConfiguration:
    ffmpeg: str = field(repr=False)
    ffprobe: str = field(repr=False)

    def validate(self):
        try:
            if any(
                not isinstance(value, str)
                or len(value) > 2048
                or not Path(value).is_absolute()
                or not Path(value).is_file()
                for value in (self.ffmpeg, self.ffprobe)
            ):
                raise ValueError
        except (ValueError, OSError):
            raise MediaError("media_configuration_invalid") from None
        return self

    def payload(self):
        return {"ffmpeg": self.ffmpeg, "ffprobe": self.ffprobe}


@dataclass(frozen=True)
class MediaFile:
    path: str = field(repr=False)
    root: str = field(repr=False)

    def stat(self):
        try:
            if any(
                not isinstance(value, str) or len(value) > 2048
                for value in (self.path, self.root)
            ):
                raise ValueError
            original = Path(self.path)
            path, root = (
                original.resolve(strict=True),
                Path(self.root).resolve(strict=True),
            )
            if (
                not root.is_dir()
                or not path.is_relative_to(root)
                or original.is_symlink()
                or not path.is_file()
            ):
                raise ValueError
            stat = path.stat()
            if not 0 < stat.st_size <= MAX_SOURCE_BYTES:
                raise ValueError
            return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)
        except (ValueError, OSError):
            raise MediaError("media_source_unavailable") from None

    def payload(self):
        self.stat()
        return {
            "path": str(Path(self.path).resolve()),
            "root": str(Path(self.root).resolve()),
        }


@dataclass(frozen=True)
class MediaInfo:
    duration_ms: int
    audio_index: int
    channels: int
    sample_rate: int
    source_stat: tuple = field(repr=False)


@dataclass(frozen=True)
class DecodedClip:
    start_ms: int
    end_ms: int
    wav: bytes = field(repr=False)


def number(value):
    if not isinstance(value, str) or len(value) > 64:
        raise MediaError("media_probe_invalid")
    try:
        result = float(value)
        if not math.isfinite(result) or abs(result) > 7200:
            raise ValueError
        return result
    except ValueError:
        raise MediaError("media_probe_invalid") from None


def parse_probe(encoded, source_stat):
    try:
        body = json.loads(encoded)
        metadata, streams = body["format"], body["streams"]
        if (
            not isinstance(metadata, dict)
            or not isinstance(streams, list)
            or len(streams) > 32
        ):
            raise ValueError
        duration = number(metadata["duration"])
        if round(duration * 1000) < 1:
            raise ValueError
        audio = [
            stream
            for stream in streams
            if isinstance(stream, dict) and stream.get("codec_type") == "audio"
        ]
        if len(audio) != 1:
            raise MediaError("media_audio_stream_unsupported")
        stream = audio[0]
        if (
            type(stream["index"]) is not int
            or not 0 <= stream["index"] <= 1024
            or type(stream["channels"]) is not int
            or not 1 <= stream["channels"] <= 8
        ):
            raise ValueError
        rate = stream["sample_rate"]
        if (
            not isinstance(rate, str)
            or not rate.isascii()
            or not rate.isdigit()
            or not 8000 <= int(rate) <= 192000
        ):
            raise ValueError
        # Provider source-clock mapping is not proven for delayed audio tracks.
        if (
            abs(
                number(stream.get("start_time", metadata.get("start_time", "0")))
                - number(metadata.get("start_time", "0"))
            )
            > 0.001
        ):
            raise MediaError("media_time_mapping_unavailable")
        return MediaInfo(
            round(duration * 1000),
            stream["index"],
            stream["channels"],
            int(rate),
            source_stat,
        )
    except (ValueError, KeyError, TypeError, RecursionError, OverflowError) as error:
        if isinstance(error, MediaError):
            raise
        raise MediaError("media_probe_invalid") from None


def probe(media, *, config, expires, authorized, seconds=10):
    config.validate()
    before = media.stat()
    encoded = invoke(
        {
            "operation": "probe",
            "config": config.payload(),
            "source": media.payload(),
            "expires": expires,
        },
        maximum=65536,
        expires=expires,
        authorized=authorized,
        seconds=seconds,
    )
    if media.stat() != before:
        raise MediaError("media_source_changed")
    return parse_probe(encoded, before)


def decode(media, info, *, config, start_ms, end_ms, expires, authorized, seconds=20):  # noqa: PLR0913 -- Explicit private input interval and live lease.
    config.validate()
    if (
        not isinstance(info, MediaInfo)
        or type(start_ms) is not int
        or type(end_ms) is not int
        or not 0 <= start_ms < end_ms <= info.duration_ms
        or not 3000 <= end_ms - start_ms <= 10000
    ):
        raise MediaError("media_interval_invalid")
    if media.stat() != info.source_stat:
        raise MediaError("media_source_changed")
    pcm = invoke(
        {
            "operation": "decode",
            "config": config.payload(),
            "source": media.payload(),
            "expires": expires,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "audio_index": info.audio_index,
        },
        maximum=(end_ms - start_ms) * 48,
        expires=expires,
        authorized=authorized,
        seconds=seconds,
    )
    if media.stat() != info.source_stat:
        raise MediaError("media_source_changed")
    if len(pcm) % 2:
        raise MediaError("media_audio_incomplete")
    # Drop at most one partial millisecond. Never pad missing media as speech.
    pcm = pcm[: len(pcm) // 48 * 48]
    duration = len(pcm) // 48
    if not 3000 <= duration <= end_ms - start_ms:
        raise MediaError("media_audio_incomplete")
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(24000)
        audio.writeframes(pcm)
    return DecodedClip(start_ms, start_ms + duration, output.getvalue())
