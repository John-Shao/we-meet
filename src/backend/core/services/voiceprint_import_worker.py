"""Bounded mono derivative writer: fixed argv, streamed PCM, no credentials."""

import json
import os
import subprocess
import sys
import wave
from pathlib import Path

from core.services.voiceprint_media import (
    FORMATS,
    MAX_DURATION_MS,
    MediaConfiguration,
    MediaFile,
)
from core.services.voiceprint_media_lifetime import contain_parent_exit


def configuration(value):
    if not isinstance(value, dict) or set(value) != {
        "source",
        "config",
        "expires",
        "duration_ms",
        "audio_index",
        "output_identity",
    }:
        raise ValueError
    if not isinstance(value["source"], dict) or set(value["source"]) != {
        "path",
        "root",
    }:
        raise ValueError
    if not isinstance(value["config"], dict) or set(value["config"]) != {
        "ffmpeg",
        "ffprobe",
    }:
        raise ValueError
    import time  # noqa: PLC0415 -- Standalone worker clock.

    if (
        type(value["expires"]) is not int
        or value["expires"] <= time.time()
        or type(value["duration_ms"]) is not int
        or not 1 <= value["duration_ms"] <= MAX_DURATION_MS
        or type(value["audio_index"]) is not int
        or not 0 <= value["audio_index"] <= 1024
        or not isinstance(value["output_identity"], list)
        or len(value["output_identity"]) != 2
        or any(type(item) is not int or item < 0 for item in value["output_identity"])
    ):
        raise ValueError
    config = MediaConfiguration(**value["config"]).validate()
    source = MediaFile(**value["source"])
    snapshot = source.stat()
    path = source.payload()
    output = Path(path["root"]) / "diarization.wav"
    if output.is_symlink() or output == Path(path["path"]):
        raise ValueError
    return config, source, snapshot, output


def command(config, source, *, duration_ms, audio_index):
    return [
        config.ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-v",
        "error",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-max_alloc",
        "67108864",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        FORMATS,
        "-probesize",
        "1048576",
        "-analyzeduration",
        "5000000",
        "-copyts",
        "-start_at_zero",
        "-i",
        source.payload()["path"],
        "-t",
        f"{duration_ms / 1000:.3f}",
        "-map",
        f"0:{audio_index}",
        "-vn",
        "-sn",
        "-dn",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-af",
        f"aresample=24000:async=1:first_pts=0,atrim=end_sample={duration_ms * 24}",
        "-ac",
        "1",
        "-ar",
        "24000",
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        "pipe:1",
    ]


def derive(value):
    config, source, snapshot, output = configuration(value)
    descriptor = os.open(
        output, os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    )
    try:
        stat = os.fstat(descriptor)
        if [stat.st_dev, stat.st_ino] != value["output_identity"] or stat.st_size != 0:
            raise ValueError
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = None
            with wave.open(stream, "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(24000)
                env = {"LANG": "C", "LC_ALL": "C"}
                if sys.platform == "win32":
                    env.update(
                        {
                            key: os.environ[key]
                            for key in ("SYSTEMROOT", "WINDIR")
                            if key in os.environ
                        }
                    )
                parent = os.getpid()
                process = subprocess.Popen(  # noqa: S603 -- Fixed local decoder, bounded output to one reserved file.
                    command(
                        config,
                        source,
                        duration_ms=value["duration_ms"],
                        audio_index=value["audio_index"],
                    ),
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    env=env,
                    creationflags=subprocess.CREATE_NO_WINDOW
                    if sys.platform == "win32"
                    else 0,
                    preexec_fn=None  # noqa: PLW1509 -- This standalone worker has no threads; install the native child's kernel parent-death signal.
                    if sys.platform == "win32"
                    else lambda: contain_parent_exit(parent),
                )
                try:
                    count = 0
                    while part := process.stdout.read(65536):
                        count += len(part)
                        if count > value["duration_ms"] * 48 or len(part) % 2:
                            raise ValueError
                        audio.writeframesraw(part)
                    if (
                        process.wait(timeout=2) != 0
                        or not 0 <= value["duration_ms"] * 48 - count <= 48
                    ):
                        raise ValueError
                finally:
                    process.stdout.close()
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=2)
        if source.stat() != snapshot:
            raise ValueError
    finally:
        if descriptor is not None:
            os.close(descriptor)


def main():
    try:
        contain_parent_exit(int(sys.argv[1]))
        encoded = sys.stdin.buffer.read(8193)
        if len(encoded) > 8192:
            raise ValueError
        value = json.loads(encoded)
        if sys.platform != "win32":
            import resource  # noqa: PLC0415 -- POSIX process limits.

            resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
            resource.setrlimit(resource.RLIMIT_CPU, (180, 180))
            resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_DURATION_MS * 48 + 44,) * 2)
        derive(value)
        return 0
    except (
        ValueError,
        TypeError,
        KeyError,
        IndexError,
        OSError,
        UnicodeError,
        RecursionError,
        subprocess.TimeoutExpired,
        wave.Error,
    ):
        return 1


if __name__ == "__main__":
    sys.exit(main())
