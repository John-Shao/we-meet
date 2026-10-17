"""Run an isolated TLS gateway until its parent closes stdin; no deployment writes."""

import asyncio
import json
import logging
import ssl
import sys

from websockets.asyncio.server import serve

from translation.capture_gateway import CaptureTranslationGateway


class DelayedSocket:
    """Model propagation latency with a bounded FIFO, retaining frame ordering."""

    def __init__(self, socket, delay, telemetry):
        """A network delay permits pipelining; it is not per-message rate limiting."""
        self.socket, self.delay, self.telemetry = socket, delay, telemetry
        self.pending = asyncio.Queue(maxsize=64)
        self.sender = asyncio.create_task(self._send())

    def __getattr__(self, name):
        """Delegate receive and connection metadata to the actual TLS socket."""
        return getattr(self.socket, name)

    async def recv(self):
        """Count PCM bytes without retaining audio or authentication messages."""
        message = await self.socket.recv()
        if isinstance(message, bytes):
            self.telemetry["input_pcm_bytes"] += len(message)
        return message

    async def send(self, message):
        """Record only event categories and safe gateway error codes."""
        if self.sender.done():
            self.sender.result()
        event = json.loads(message)
        self.telemetry["output_message_bytes"] += len(message.encode("utf-8"))
        kind = event.get("type", "unknown")
        self.telemetry["events"][kind] = self.telemetry["events"].get(kind, 0) + 1
        if kind == "error":
            self.telemetry["error_codes"].append(event.get("code", "unknown"))
        await self.pending.put(
            (asyncio.get_running_loop().time() + self.delay, message)
        )

    async def _send(self):
        while True:
            deadline, message = await self.pending.get()
            try:
                await asyncio.sleep(
                    max(0, deadline - asyncio.get_running_loop().time())
                )
                await self.socket.send(message)
            finally:
                self.pending.task_done()

    async def close_output(self):
        """Drain terminal events before allowing the server to close the socket."""
        try:
            await asyncio.wait_for(self.pending.join(), 5)
        finally:
            self.sender.cancel()
            await asyncio.gather(self.sender, return_exceptions=True)

    async def close(self, *args, **kwargs):
        """A close frame must follow all earlier data frames on the same stream."""
        await asyncio.wait_for(self.pending.join(), 5)
        await self.socket.close(*args, **kwargs)


async def main():
    """Use production routing, admission, VAD and provider transports."""
    config = json.loads(sys.stdin.readline())
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(config["certificate"], config["key"])
    gateway = CaptureTranslationGateway(origins=["https://localhost"])
    delay = config.get("downstream_delay_ms", 0) / 1000
    telemetry = {
        "events": {},
        "error_codes": [],
        "input_pcm_bytes": 0,
        "output_message_bytes": 0,
    }

    async def handle(socket):
        started = asyncio.get_running_loop().time()
        delayed = DelayedSocket(socket, delay, telemetry)
        try:
            await gateway.handle(delayed)
        finally:
            await delayed.close_output()
            telemetry.setdefault("connection_duration_ms", []).append(
                round((asyncio.get_running_loop().time() - started) * 1000)
            )

    async with serve(
        handle,
        "127.0.0.1",
        0,
        ssl=tls,
        max_size=8192,
        max_queue=4,
        compression=None,
    ) as server:
        sys.stdout.write(
            json.dumps({"port": server.sockets[0].getsockname()[1]}) + "\n"
        )
        sys.stdout.flush()
        await asyncio.to_thread(sys.stdin.readline)
    sys.stdout.write(json.dumps({"gateway": telemetry}) + "\n")


if __name__ == "__main__":
    logging.basicConfig(level=logging.CRITICAL)
    asyncio.run(main())
