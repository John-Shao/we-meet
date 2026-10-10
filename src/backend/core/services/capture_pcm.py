"""Pure bounded PCM validation shared by ingestion and private media assembly."""

import io
import wave

MAX_BYTES = 320044
SAMPLE_RATE = 16000


def frames(data):
    if not isinstance(data, bytes) or len(data) > MAX_BYTES:
        raise ValueError("Audio chunk exceeds the byte limit.")
    try:
        with wave.open(io.BytesIO(data), "rb") as audio:
            if (
                audio.getnchannels(),
                audio.getsampwidth(),
                audio.getframerate(),
                audio.getcomptype(),
            ) != (1, 2, SAMPLE_RATE, "NONE"):
                raise ValueError("Unsupported PCM audio format.")
            count = audio.getnframes()
            pcm = audio.readframes(count)
            if count < 16 or count > 160000 or count % 16 or len(pcm) != count * 2:
                raise ValueError("Invalid or incomplete audio frames.")
            return pcm
    except (wave.Error, EOFError) as exc:
        raise ValueError("Invalid WAV file.") from exc
