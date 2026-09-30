"""Claim capture jobs and run the selected live or sealed implementation."""

import asyncio
import logging
import os
import signal

from capture.common import CaptureBackend, CaptureError
from capture.sealed import CaptureAttempt
from plugins.qwen.asr import QwenASRConfig
from plugins.qwen.filetrans import QwenFileASRConfig

logger = logging.getLogger("capture-transcriber")


async def serve(*, live=False, attempt_type=CaptureAttempt):
    """A separate process polls explicitly authorized jobs; it creates none itself."""
    if not os.getenv("DASHSCOPE_API_KEY"):
        raise CaptureError("dashscope_api_key_missing")
    if live and not os.getenv("DASHSCOPE_WORKSPACE_ID"):
        raise CaptureError("dashscope_workspace_id_missing")
    try:
        config = QwenASRConfig.from_env() if live else QwenFileASRConfig.from_env()
    except ValueError:
        raise CaptureError("qwen_asr_configuration_invalid") from None
    backend = CaptureBackend(
        os.getenv("AGENT_BACKEND_API_URL", ""),
        os.getenv("AGENT_INTERNAL_API_TOKEN", ""),
    )
    current = asyncio.current_task()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, current.cancel)
        except NotImplementedError:
            pass  # Linux container uses handlers; Windows Runner handles Ctrl-C.
    while True:
        response = await backend.request(
            "claim/",
            {
                "model": config.model,
                "region": config.region,
                **({"live": True} if live else {}),
            },
        )
        job = response["job"]
        if job:
            await attempt_type(backend, config, job).execute()
        else:
            await asyncio.sleep(5)


def run_worker(*, live=False, attempt_type=CaptureAttempt):
    """Report only allowlisted diagnostics, never exception bodies or secrets."""
    logging.basicConfig(level=logging.INFO)
    try:
        asyncio.run(serve(live=live, attempt_type=attempt_type))
    except (KeyboardInterrupt, asyncio.CancelledError):
        return 0
    except Exception as exc:
        allowed = {
            "dashscope_api_key_missing",
            "dashscope_workspace_id_missing",
            "qwen_asr_configuration_invalid",
            "backend_configuration_required",
            "invalid_backend_origin",
            "backend_execution_rejected",
            "backend_receipt_unknown",
        }
        reason = (
            str(exc)
            if isinstance(exc, CaptureError) and str(exc) in allowed
            else "worker_execution_failed"
        )
        logger.error(
            "Transcription worker stopped: mode=%s reason=%s",
            "live" if live else "sealed",
            reason,
        )
        return 1
    return 0
