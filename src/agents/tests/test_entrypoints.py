"""Check executable entrypoints without connecting workers to external services."""

import importlib
import runpy
import unittest
from unittest import mock


class EntrypointTests(unittest.TestCase):
    """Preserve worker selection and lifecycle hooks after moving source files."""

    def test_livekit_entrypoints_register_their_original_runtime(self):
        """Module execution passes each runtime's callbacks to the LiveKit CLI."""
        workers = {
            "multi_user_transcriber": "transcription.runtime",
            "ai_assistant": "assistant.runtime",
            "qwen_translation_agent": "translation.private",
            "qwen_interpretation_agent": "translation.interpretation",
            "metadata_collector": "metadata.collector",
        }
        for entrypoint, module in workers.items():
            with self.subTest(entrypoint=entrypoint):
                runtime = importlib.import_module(module)
                with mock.patch.object(runtime.cli, "run_app") as run:
                    runpy.run_module("entrypoints." + entrypoint, run_name="__main__")
                run.assert_called_once()
                options = run.call_args.args[0]
                if entrypoint == "metadata_collector":
                    self.assertIs(options, runtime.server)
                else:
                    self.assertIs(options.entrypoint_fnc, runtime.entrypoint)

    def test_capture_entrypoints_select_separate_execution_modes(self):
        """Live capture uses its implementation; sealed capture keeps the default."""
        from capture.live import LiveCaptureAttempt  # noqa: PLC0415 -- isolate imports

        for entrypoint, expected in [
            ("capture_transcriber", {}),
            (
                "capture_live_transcriber",
                {"live": True, "attempt_type": LiveCaptureAttempt},
            ),
        ]:
            with self.subTest(entrypoint=entrypoint):
                with mock.patch("capture.worker.run_worker", return_value=0) as run:
                    with self.assertRaises(SystemExit) as stopped:
                        runpy.run_module(
                            "entrypoints." + entrypoint, run_name="__main__"
                        )
                self.assertEqual(stopped.exception.code, 0)
                run.assert_called_once_with(**expected)

    def test_gateway_entrypoint_runs_the_async_gateway(self):
        """Execute the gateway entrypoint with its network listener replaced."""
        with mock.patch("translation.capture_gateway.main", mock.AsyncMock()) as main:
            runpy.run_module(
                "entrypoints.capture_translation_gateway", run_name="__main__"
            )
        main.assert_awaited_once_with()
