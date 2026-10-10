"""Bounded SDK lifecycle and aggregate HTTP/logging without room or user labels."""

import asyncio
import json
import logging
import signal
import sys
from functools import partial

from aiohttp import web
from livekit.agents import (
    AgentServer,
    JobExecutorType,
    WorkerOptions,
    WorkerPermissions,
)

from voiceprint.client import SamplingError
from voiceprint.configuration import Configuration

DRAIN_SECONDS = 45
CLOSE_SECONDS = 10


class AggregateFormatter(logging.Formatter):
    """SDK records may contain identity, URLs, tokens and private extra fields."""

    def format(self, record):
        """Only a fixed event and severity leave this dedicated process."""
        severity = (
            "error"
            if record.levelno >= logging.ERROR
            else "warning"
            if record.levelno >= logging.WARNING
            else "info"
        )
        return json.dumps({"event": "sampling_sdk_event", "level": severity})


def configure_logging():
    """Use our handler, not the generic SDK CLI's message/extra formatter."""
    handler = logging.StreamHandler()
    handler.setFormatter(AggregateFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(logging.INFO)
    for logger in logging.Logger.manager.loggerDict.values():
        if isinstance(logger, logging.Logger):
            logger.handlers.clear()
            logger.propagate = True


def room_load(server, *, maximum):
    """The pinned SDK additionally reserves pending availability slots."""
    return min(1.0, len(server.active_jobs) / maximum)


def options(configuration):
    """Avoid idle pools, host-CPU-based job budgets and media publication."""
    from voiceprint.sampler import (  # noqa: PLC0415 -- Avoid the executable/runtime import cycle.
        accept_job,
        entrypoint,
    )

    return WorkerOptions(
        entrypoint_fnc=entrypoint,
        request_fnc=accept_job,
        agent_name=configuration.agent_name,
        ws_url=configuration.livekit_url,
        api_key=configuration.api_key,
        api_secret=configuration.api_secret,
        http_proxy=None,
        job_executor_type=JobExecutorType.PROCESS,
        num_idle_processes=0,
        load_fnc=partial(room_load, maximum=configuration.max_rooms),
        load_threshold=1.0,
        job_memory_warn_mb=configuration.job_memory_mb * 0.75,
        job_memory_limit_mb=configuration.job_memory_mb,
        drain_timeout=DRAIN_SECONDS,
        shutdown_process_timeout=5,
        initialize_process_timeout=15,
        host="127.0.0.1",
        port=8081,
        permissions=WorkerPermissions(
            can_publish=False,
            can_publish_data=False,
            can_update_metadata=False,
            hidden=False,
        ),
    )


def ready(server):
    """Fail closed if the pinned SDK changes its connection-health contract."""
    return (
        server.id != "unregistered"
        and not server.draining
        and getattr(server, "_connecting", True) is False
        and getattr(server, "_connection_failed", True) is False
        and getattr(server, "_closed", True) is False
    )


def health_application(server, configuration):
    """The public listener has no SDK job/room enumeration or private fields."""
    app = web.Application(client_max_size=1024)

    async def live(_request):
        return web.json_response(
            {"status": "alive"}, headers={"Cache-Control": "no-store"}
        )

    async def readiness(_request):
        available = ready(server)
        return web.json_response(
            {"status": "ready" if available else "warming"},
            status=200 if available else 503,
            headers={"Cache-Control": "no-store"},
        )

    async def metrics(_request):
        return web.Response(
            text=(
                f"voiceprint_sampler_ready {int(ready(server))}\n"
                f"voiceprint_sampler_active_rooms {len(server.active_jobs)}\n"
                f"voiceprint_sampler_room_capacity {configuration.max_rooms}\n"
                f"voiceprint_sampler_enabled {int(configuration.enabled)}\n"
            ),
            content_type="text/plain",
            headers={"Cache-Control": "no-store"},
        )

    app.add_routes(
        [
            web.get("/health/live", live),
            web.get("/health/ready", readiness),
            web.get("/metrics", metrics),
        ]
    )
    return app


async def serve(configuration):
    """SIGTERM stops accepting work, then drains and closes with fixed deadlines."""
    server = AgentServer.from_server_options(options(configuration))
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    installed = []
    restored = []

    def stop(_signal, _frame):
        loop.call_soon_threadsafe(stopped.set)

    runner = web.AppRunner(health_application(server, configuration), access_log=None)
    worker = None
    waiter = None
    try:
        for event in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(event, stopped.set)
                installed.append(event)
            except NotImplementedError:
                previous = signal.getsignal(event)
                signal.signal(event, stop)
                restored.append((event, previous))
        await runner.setup()
        waiter = asyncio.create_task(stopped.wait())
        # A private aggregate listener, protected by deployment NetworkPolicy.
        await web.TCPSite(runner, "0.0.0.0", 8094).start()  # noqa: S104
        worker = asyncio.create_task(server.run(devmode=False))
        done, _ = await asyncio.wait(
            (worker, waiter), return_when=asyncio.FIRST_COMPLETED
        )
        if worker in done:
            await worker
        else:
            try:
                await asyncio.wait_for(
                    server.drain(timeout=DRAIN_SECONDS), timeout=DRAIN_SECONDS + 1
                )
            except TimeoutError:
                pass
    finally:
        try:
            await asyncio.wait_for(server.aclose(), timeout=CLOSE_SECONDS)
        finally:
            try:
                tasks = [task for task in (worker, waiter) if task is not None]
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                await runner.cleanup()
            finally:
                for event in installed:
                    loop.remove_signal_handler(event)
                for event, handler in restored:
                    signal.signal(event, handler)


def main():
    """Support server/check modes only; the generic SDK console opens microphones."""
    try:
        mode = sys.argv[1:] or ["start"]
        if mode not in (["start"], ["--check"]):
            raise SamplingError("sampling_execution_mode_invalid")
        configuration = Configuration.from_env()
        if mode == ["--check"]:
            print(  # noqa: T201 -- Fixed aggregate offline result only.
                json.dumps(
                    {
                        "status": "ready",
                        "max_rooms": configuration.max_rooms,
                        "enabled": configuration.enabled,
                    }
                )
            )
            return
        configure_logging()
        asyncio.run(serve(configuration))
    except Exception:  # Private SDK/configuration errors must not escape in tracebacks.
        print(  # noqa: T201 -- Fixed private error boundary.
            json.dumps(
                {"status": "unavailable", "code": "sampling_runtime_unavailable"}
            ),
            file=sys.stderr,
        )
        raise SystemExit(1) from None
