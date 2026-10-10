"""Fixed local decoder launcher; no storage URLs, credentials or user filters."""

import json
import os
import subprocess
import sys
import time

from core.services.voiceprint_media import (
    FORMATS,
    MediaConfiguration,
    MediaFile,
)
from core.services.voiceprint_media_lifetime import contain_parent_exit


def command(value):
    if not isinstance(value, dict):
        raise ValueError
    common = {"operation", "config", "source", "expires"}
    if value.get("operation") == "probe":
        required = common
    elif value.get("operation") == "decode":
        required = common | {"start_ms", "end_ms", "audio_index"}
    else:
        raise ValueError
    if set(value) != required:
        raise ValueError
    if type(value["expires"]) is not int or value["expires"] <= time.time():
        raise ValueError
    if not isinstance(value["config"], dict) or set(value["config"]) != {
        "ffmpeg",
        "ffprobe",
    }:
        raise ValueError
    if not isinstance(value["source"], dict) or set(value["source"]) != {
        "path",
        "root",
    }:
        raise ValueError
    config = MediaConfiguration(**value["config"]).validate()
    source = MediaFile(**value["source"])
    source.stat()
    path = source.payload()["path"]
    limits = [
        "-hide_banner",
        "-v",
        "error",
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
    ]
    if value["operation"] == "probe":
        return [
            config.ffprobe,
            *limits,
            "-show_entries",
            "format=duration,start_time:stream=index,codec_type,channels,sample_rate,start_time",
            "-of",
            "json",
            path,
        ]
    start, end, index = value["start_ms"], value["end_ms"], value["audio_index"]
    if (
        type(start) is not int
        or type(end) is not int
        or not 0 <= start < end <= 7200000
        or not 3000 <= end - start <= 10000
        or type(index) is not int
        or not 0 <= index <= 1024
    ):
        raise ValueError
    return [
        config.ffmpeg,
        "-nostdin",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        *limits,
        "-ss",
        f"{start / 1000:.3f}",
        "-i",
        path,
        "-t",
        f"{(end - start) / 1000:.3f}",
        "-map",
        f"0:{index}",
        "-vn",
        "-sn",
        "-dn",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-af",
        f"aresample=24000,atrim=end_sample={(end - start) * 24},asetpts=PTS-STARTPTS",
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


def main():
    try:
        contain_parent_exit(int(sys.argv[1]))
        encoded = sys.stdin.buffer.read(8193)
        if len(encoded) > 8192:
            raise ValueError
        value = json.loads(encoded)
        args = command(value)
        # The native parser receives no application credentials or provider keys.
        env = {"LANG": "C", "LC_ALL": "C"}
        if sys.platform == "win32":
            env.update(
                {
                    key: os.environ[key]
                    for key in ("SYSTEMROOT", "WINDIR")
                    if key in os.environ
                }
            )
            # Native children inherit the already attached parent job, including
            # memory/CPU limits and kill-on-close. Output streams to the parent.
            return subprocess.call(  # noqa: S603 -- Validated, fixed native argv; no shell.
                args,
                stdin=subprocess.DEVNULL,
                stdout=sys.stdout.buffer,
                stderr=subprocess.DEVNULL,
                env=env,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        import resource  # noqa: PLC0415 -- POSIX-only limits before replacing this process.

        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
        resource.setrlimit(resource.RLIMIT_CPU, (25, 25))
        # Keep the same PID and kernel parent-death signal; do not leave a native
        # grandchild alive when the parent lease timer terminates this process.
        os.execve(args[0], args, env)  # noqa: S606 -- Fixed allowlisted decoder and local file.
    except (
        ValueError,
        TypeError,
        KeyError,
        IndexError,
        OSError,
        UnicodeError,
        RecursionError,
    ):
        return 1
    return 1


if __name__ == "__main__":
    sys.exit(main())
