"""Exercise real HTTP reuse, cancellation and worker-owned cleanup."""

import asyncio
import os
import unittest
from unittest import mock

from aiohttp import web

from capture import worker
from plugins.qwen.http_pool import filetrans_http_client, filetrans_http_pool


class HttpPoolTests(unittest.IsolatedAsyncioTestCase):
    """Use a local fake provider; no model calls or provider credentials."""

    async def asyncSetUp(self):
        """Start a keep-alive endpoint which records routing and credentials."""
        self.seen = []
        self.started = asyncio.Event()

        async def handle(request):
            self.seen.append(
                (
                    request.transport.get_extra_info("peername")[1],
                    request.headers.get("Authorization"),
                    request.headers.get("Cookie"),
                )
            )
            if request.path == "/wait":
                self.started.set()
                await asyncio.sleep(0.2)
            response = web.json_response({"index": request.query.get("index")})
            response.set_cookie("private", "must-not-cross-tasks")
            return response

        app = web.Application()
        app.router.add_route("*", "/{path:.*}", handle)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"

    async def asyncTearDown(self):
        """Drain and close the fake provider."""
        await self.runner.cleanup()

    async def test_cross_task_reuse_keeps_auth_and_cookies_private(self):
        """Paid requests and unauthenticated result downloads share only sockets."""
        async with filetrans_http_pool():
            clients = []
            for auth in ("Bearer a", None, "Bearer b"):
                async with filetrans_http_client() as client:
                    clients.append(client)
                    async with client.get(
                        self.url, headers={"Authorization": auth} if auth else {}
                    ) as response:
                        await response.read()
            self.assertTrue(all(client is clients[0] for client in clients))
            self.assertFalse(clients[0].closed)
        self.assertTrue(clients[0].closed)
        self.assertEqual(len({row[0] for row in self.seen}), 1)
        self.assertEqual([row[1] for row in self.seen], ["Bearer a", None, "Bearer b"])
        self.assertTrue(all(row[2] is None for row in self.seen))

    async def test_cancelled_request_does_not_close_other_tasks_pool(self):
        """Cancelled responses release their connection without stopping the worker."""
        async with filetrans_http_pool():
            async with filetrans_http_client() as client:
                task = asyncio.create_task(client.get(self.url + "/wait"))
                await self.started.wait()
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            async with filetrans_http_client() as same:
                self.assertIs(same, client)
                async with same.get(self.url) as response:
                    self.assertEqual(response.status, 200)
                    await response.read()
        self.assertTrue(client.closed)

    async def test_inherited_pool_cannot_cross_process_or_owner_lifetime(self):
        """Inherited context must not borrow a parent's or a closed worker's pool."""
        release = asyncio.Event()

        async def late_child():
            await release.wait()
            with self.assertRaisesRegex(RuntimeError, "worker_lifetime"):
                async with filetrans_http_client():
                    pass

        async with filetrans_http_pool():
            with mock.patch("plugins.qwen.http_pool.os.getpid", return_value=-1):
                with self.assertRaisesRegex(RuntimeError, "worker_lifetime"):
                    async with filetrans_http_client():
                        pass
            task = asyncio.create_task(late_child())
        release.set()
        await task

    async def test_concurrent_calls_are_bounded_and_response_isolated(self):
        """Concurrent tasks share a bounded connector and retain individual results."""

        async def call(index):
            async with filetrans_http_client() as client:
                async with client.get(self.url, params={"index": index}) as response:
                    self.assertEqual((await response.json())["index"], str(index))

        async with filetrans_http_pool():
            await asyncio.gather(*(call(index) for index in range(64)))
        self.assertLessEqual(len({row[0] for row in self.seen}), 16)
        self.assertEqual(len(self.seen), 64)

    async def test_standalone_and_worker_exit_close_connections(self):
        """Worker cancellation closes shared state; standalone callers own sessions."""
        async with filetrans_http_client() as standalone:
            pass
        self.assertTrue(standalone.closed)
        clients = []

        class Attempt:
            def __init__(self, *_args):
                pass

            async def execute(self):
                async with filetrans_http_client() as client:
                    clients.append(client)

        backend = mock.Mock()
        backend.request = mock.AsyncMock(
            side_effect=[
                {"job": {"id": "first"}},
                {"job": {"id": "second"}},
                asyncio.CancelledError(),
            ]
        )
        with (
            mock.patch.dict(os.environ, {"DASHSCOPE_API_KEY": "fake"}),
            mock.patch.object(worker, "CaptureBackend", return_value=backend),
        ):
            with self.assertRaises(asyncio.CancelledError):
                await worker.serve(attempt_type=Attempt)
        self.assertIs(clients[0], clients[1])
        self.assertTrue(clients[0].closed)
