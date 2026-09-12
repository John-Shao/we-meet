"""Managed capture metadata and a lease watchdog independent of cloud recording."""

import asyncio
import json
import time
import uuid


def capture_metadata(raw):
    """Unknown ordinary metadata is legacy; malformed managed metadata fails closed."""
    if not raw:
        return None
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("Invalid capture metadata")
    if "online_capture" not in data:
        return None
    capture = data["online_capture"]
    if not isinstance(capture, dict) or set(capture) != {
        "delivery_id",
        "livekit_room_sid",
    }:
        raise ValueError("Invalid capture metadata")
    if not isinstance(capture["delivery_id"], str):
        raise ValueError("Invalid capture delivery")
    uuid.UUID(capture["delivery_id"])
    if not isinstance(capture["livekit_room_sid"], str) or not capture[
        "livekit_room_sid"
    ].startswith("RM_"):
        raise ValueError("Invalid capture session")
    return capture


async def watch_capture(writer, close, shutdown, *, interval=2, loss_budget=15):
    """Renew during drain and shut down after attempting the final manifest."""
    last_success = time.monotonic()
    draining = None
    try:
        while True:
            state = await writer.capture_state()
            if state is not None:
                last_success = time.monotonic()
            lost = time.monotonic() - last_success >= loss_budget
            if state in ("stopped", "incomplete") or lost:
                writer.mark_incomplete()
            if draining is None and (
                lost or state in ("stopping", "stopped", "incomplete")
            ):
                draining = asyncio.create_task(close())
            if draining is not None and draining.done():
                await draining
                shutdown("online capture finished")
                return
            await asyncio.sleep(interval)
    finally:
        if draining is not None:
            # Cancellation of the watchdog must not cancel tail delivery.
            await asyncio.shield(draining)
