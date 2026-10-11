"""Pre-ASR mono input preparation; private local paths, no provider submission.

The caller must hold a current upload/source authorization lease and later bind
the selected ASR object and identity query to the same immutable receipt. This
context neither extends the source lifetime nor establishes a voiceprint.
"""

import os
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

from core.services import voiceprint_media as media
from core.services.voiceprint_media_process import MediaError, invoke


@dataclass(frozen=True)
class PreparedImport:
    source: media.MediaFile = field(repr=False)
    info: media.MediaInfo = field(repr=False)
    derived: bool
    original_duration_ms: int
    time_offset_ms: int = 0


@contextmanager
def prepare(source, *, config, expires, authorized, seconds=180):
    """Probe one stream, and if needed stream a canonical 24 kHz mono WAV.

    Files larger than the existing 512 MiB private source limit and durations
    over two hours are rejected, without affecting ordinary ASR. The original
    file remains caller-owned; only this context's derivative is removed.
    """
    info = media.probe(source, config=config, expires=expires, authorized=authorized)
    if info.channels == 1:
        yield PreparedImport(source, info, False, info.duration_ms)
        return
    output = Path(source.payload()["root"]) / "diarization.wav"
    try:
        descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError:
        raise MediaError("media_derivative_unavailable") from None
    try:
        stat = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    identity = (stat.st_dev, stat.st_ino)
    try:
        invoke(
            {
                "source": source.payload(),
                "config": config.payload(),
                "expires": expires,
                "duration_ms": info.duration_ms,
                "audio_index": info.audio_index,
                "output_identity": list(identity),
            },
            maximum=32,
            expires=expires,
            authorized=authorized,
            seconds=seconds,
            purpose="import",
        )
        if source.stat() != info.source_stat:
            raise MediaError("media_source_changed")
        derivative = media.MediaFile(str(output), source.payload()["root"])
        if derivative.stat()[:2] != identity:
            raise MediaError("media_derivative_unavailable")
        prepared = media.probe(
            derivative, config=config, expires=expires, authorized=authorized
        )
        if (
            prepared.channels != 1
            or prepared.sample_rate != 24000
            or abs(prepared.duration_ms - info.duration_ms) > 1
            or prepared.source_stat[:2] != identity
            or derivative.stat() != prepared.source_stat
        ):
            raise MediaError("media_time_mapping_unavailable")
        yield PreparedImport(derivative, prepared, True, info.duration_ms)
    finally:
        # Never remove an unrelated replacement or follow a substituted link.
        try:
            current = output.lstat()
            if not output.is_symlink() and (current.st_dev, current.st_ino) == identity:
                output.unlink()
        except FileNotFoundError:
            pass  # The independent source lease may already have removed it.
