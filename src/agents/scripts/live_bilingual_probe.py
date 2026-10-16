"""Exercise isolated WebSocket/VAD/provider sessions using synthetic PCM fixtures.

Requires configured provider credentials. Does not use or mutate production admission,
users, database rows, routes or deployments. Reports contain only counts and timings.
"""

import argparse
import asyncio
import base64
import json
import logging
import random
import struct
import sys
import time
from pathlib import Path

from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from translation.assistant_gateway import (
    AssistantTranslationConnection,
    safe_error_code,
)
from translation.assistant_gateway import (
    claim as backend_claim,
)
from translation.assistant_gateway import (
    lease as backend_lease,
)


async def probe(  # noqa: PLR0912, PLR0913, PLR0915 -- bounded acceptance scenarios
    assets,
    fixed,
    *,
    admission=None,
    voice="Tina",
    hold_seconds=0,
    idle_noise=False,
    idle_seconds=60,
):
    """Run one bounded business connection against actual upstream model sockets."""
    result = {
        "mode": "idle_noise" if idle_noise else "fixed" if fixed else "automatic",
        "rows": [],
        "passed": False,
    }
    leases = []
    connections = []
    errors = []
    outputs = {}
    done = asyncio.Event()
    started = time.monotonic()
    ticket_value = admission["ticket"] if admission else "isolated-synthetic-probe"

    async def claim(ticket):
        if admission:
            grant = await backend_claim(ticket)
            if grant["voice"] != voice or grant["fixed_source"] != fixed:
                raise ValueError("grant_choices_changed")
            result["granted_idle_seconds"] = grant["idle_seconds"]
            result["granted_max_seconds"] = grant["max_seconds"]
            return grant
        if ticket != ticket_value:
            raise ValueError("invalid_fixture_ticket")
        return {
            "protocol_version": 2,
            "session_id": "isolated-synthetic-probe",
            "source_language": "zh",
            "target_language": "en",
            "fixed_source": fixed,
            "voice": voice,
            "max_seconds": 120,
            "remaining_seconds": 120,
            "idle_seconds": 60,
            "heartbeat_seconds": 20,
        }

    async def lease(session_id, operation):
        leases.append(operation)
        if admission:
            return await backend_lease(session_id, operation)
        return {"status": "active" if operation == "heartbeat" else "closed"}

    async def handler(socket):
        connection = AssistantTranslationConnection(
            socket, claim_ticket=claim, update_lease=lease
        )
        connections.append(connection)
        await connection.run(json.loads(await socket.recv()))

    async with serve(
        handler, "127.0.0.1", 0, max_size=8192, max_queue=4, compression=None
    ) as server:
        url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}/capture-translation"
        async with connect(
            url, proxy=None, compression=None, close_timeout=3
        ) as socket:
            await socket.send(
                json.dumps(
                    {
                        "type": "assistant_translation",
                        "ticket": ticket_value,
                    }
                )
            )
            first = json.loads(await asyncio.wait_for(socket.recv(), 40))
            if first["type"] != "ready":
                result["error"] = first.get("code", "not_ready")
                return result
            result["ready_ms"] = round((time.monotonic() - started) * 1000)

            async def receive():
                async for raw in socket:
                    event = json.loads(raw)
                    kind = event["type"]
                    if kind in {"audio", "translation", "audio_end"}:
                        item = outputs.setdefault(
                            event["id"], {"audio_bytes": 0, "audio_ended": False}
                        )
                        if kind == "audio":
                            item["audio_bytes"] += len(base64.b64decode(event["audio"]))
                        elif kind == "audio_end":
                            item["audio_ended"] = True
                        else:
                            item.update(
                                source_language=event["source_language"],
                                target_language=event["target_language"],
                                source_chars=len(event["source"]),
                                target_chars=len(event["text"]),
                            )
                    elif kind == "error":
                        errors.append(event["code"])
                        done.set()
                    elif kind == "finished":
                        done.set()
                    elif kind == "expired":
                        result["expired_reason"] = event["reason"]
                        result["expired_at_ms"] = round(
                            (time.monotonic() - started) * 1000
                        )
                        done.set()

            receive_task = asyncio.create_task(receive())
            try:
                sources = [] if idle_noise else ["zh"] if fixed else ["zh", "en"]
                for source in sources:
                    name = "aoq-chinese.pcm" if source == "zh" else "aoq-english.pcm"
                    pcm = (assets / name).read_bytes()
                    expected = (
                        len(
                            [
                                item
                                for item in outputs.values()
                                if item.get("source_language") == source
                                and item["audio_ended"]
                            ]
                        )
                        + 1
                    )
                    for offset in range(0, len(pcm), 3200):
                        await socket.send(pcm[offset : offset + 3200])
                        await asyncio.sleep(0.1)
                    end = time.monotonic() + 25
                    while time.monotonic() < end and not errors:
                        await socket.send(bytes(3200))
                        await asyncio.sleep(0.1)
                        completed = [
                            item
                            for item in outputs.values()
                            if item.get("source_language") == source
                            and item["audio_ended"]
                        ]
                        if len(completed) >= expected:
                            break
                    else:
                        errors.append("missing_complete_direction")
                    if errors:
                        break
                if hold_seconds and not errors:
                    for _ in range(hold_seconds * 10):
                        await socket.send(bytes(3200))
                        await asyncio.sleep(0.1)
                if idle_noise:
                    generator = random.Random(16)  # noqa: S311 -- synthetic PCM only
                    noise = struct.pack(
                        "<1600h", *(generator.randint(-100, 100) for _ in range(1600))
                    )
                    for _ in range((idle_seconds + 35) * 10):
                        if done.is_set():
                            break
                        await socket.send(noise)
                        await asyncio.sleep(0.1)
                else:
                    await socket.send('{"type":"finish"}')
                await asyncio.wait_for(done.wait(), 30)
                # Like Android, retire our socket after the terminal event. On
                # idle expiry, unread in-flight PCM may otherwise delay the
                # server's close handshake until its close timeout.
                await socket.close()
                await asyncio.wait_for(receive_task, 5)
            finally:
                receive_task.cancel()
                await asyncio.gather(receive_task, return_exceptions=True)
    result["rows"] = list(outputs.values())
    result["duration_ms"] = round((time.monotonic() - started) * 1000)
    result["provider_connections"] = sum(
        len(connection.sessions) for connection in connections
    )
    result["lease_closed"] = leases.count("close") == 1
    result["heartbeats"] = leases.count("heartbeat")
    result["voice"] = voice
    result["input_bytes"] = sum(connection.input_bytes for connection in connections)
    result["output_bytes"] = sum(connection.output_bytes for connection in connections)
    result["errors"] = errors
    expected_sources = set() if idle_noise else {"zh"} if fixed else {"zh", "en"}
    result["passed"] = (
        not errors
        and result["lease_closed"]
        and (
            result.get("expired_reason") == "idle"
            if idle_noise
            else bool(result["rows"])
        )
        and {row.get("source_language") for row in result["rows"]} == expected_sources
        and all(
            row["audio_ended"]
            and row["audio_bytes"] > 0
            and row.get("target_chars", 0) > 0
            for row in result["rows"]
        )
    )
    return result


async def main():
    """Print only a sanitized acceptance report; model content remains transient."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, required=True)
    args = parser.parse_args()
    report = {
        "scope": "isolated gateway with real provider; admission is a fixture",
        "cases": [],
    }
    for fixed in ("zh", None):
        try:
            async with asyncio.timeout(120):
                report["cases"].append(await probe(args.assets, fixed))
        except Exception as error:
            report["cases"].append(
                {
                    "mode": "fixed" if fixed else "automatic",
                    "passed": False,
                    "error": safe_error_code(error),
                    "error_class": type(error).__name__,
                }
            )
    sys.stdout.write(json.dumps(report, indent=2) + "\n")
    return 0 if all(case["passed"] for case in report["cases"]) else 1


if __name__ == "__main__":
    logging.basicConfig(level=logging.CRITICAL)
    raise SystemExit(asyncio.run(main()))
