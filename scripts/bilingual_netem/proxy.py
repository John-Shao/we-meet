"""Forward encrypted TCP unchanged inside this disposable network namespace."""

import asyncio
import os


async def forward(source, target):
    """Bound each copy buffer and let TCP provide ordering and retransmission."""
    while chunk := await source.read(65536):
        target.write(chunk)
        await target.drain()


async def handle(reader, writer):
    """Give each accepted connection an independent upstream TCP connection."""
    upstream = None
    try:
        incoming, upstream = await asyncio.open_connection(
            "host.docker.internal", int(os.environ["GATEWAY_PORT"])
        )
        tasks = [
            asyncio.create_task(forward(reader, upstream)),
            asyncio.create_task(forward(incoming, writer)),
        ]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    finally:
        writer.close()
        if upstream is not None:
            upstream.close()


async def main():
    """The host exposes this listener on a random loopback-only port."""
    async with await asyncio.start_server(handle, "0.0.0.0", 9443) as server:  # noqa: S104 -- private container
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
