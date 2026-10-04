"""Operator configuration and error diagnostics cannot expose provider payloads."""

import unittest
from unittest.mock import patch

from plugins.qwen.live_translate import TranslationError
from translation.assistant_gateway import safe_error_code
from translation.bilingual_settings import BilingualSettings


class SettingsTests(unittest.TestCase):
    """Validate tuning before opening a billable provider socket."""

    def test_default_and_overridden_limits(self):
        """Defaults preserve probe timing with shorter bounded network waits."""
        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(BilingualSettings.from_env(), BilingualSettings())
        with patch.dict(
            "os.environ",
            {
                "TRANSLATION_LID_PROBE_MS": "1000",
                "TRANSLATION_LID_RETRY_MS": "600",
                "TRANSLATION_LID_MAX_FAILURES": "2",
                "TRANSLATION_LID_TIMEOUT_MS": "3000",
                "TRANSLATION_TURN_SILENCE_MS": "600",
            },
            clear=True,
        ):
            self.assertEqual(
                BilingualSettings.from_env(), BilingualSettings(1000, 600, 2, 3, 600)
            )

    def test_invalid_turn_silence_is_rejected(self):
        """The server window stays inside the range the gateway can silence."""
        for value in ("private", "299", "2001"):
            with patch.dict("os.environ", {"TRANSLATION_TURN_SILENCE_MS": value}):
                with self.assertRaisesRegex(
                    ValueError, "^Invalid TRANSLATION_TURN_SILENCE_MS$"
                ):
                    BilingualSettings.from_env()

    def test_invalid_tuning_fails_without_echoing_value(self):
        """Do not echo arbitrary environment content in errors."""
        for value in ("private", "nan", "-1", "0", "9000", "1.5"):
            with patch.dict("os.environ", {"TRANSLATION_LID_PROBE_MS": value}):
                with self.assertRaisesRegex(
                    ValueError, "^Invalid TRANSLATION_LID_PROBE_MS$"
                ):
                    BilingualSettings.from_env()

    def test_error_codes_are_allowlisted(self):
        """Provider text, exception names and credentials never become client codes."""
        self.assertEqual(
            safe_error_code(TranslationError("language_detection_unavailable")),
            "language_detection_unavailable",
        )
        for error in (TranslationError("private upstream text"), ValueError("private")):
            self.assertEqual(safe_error_code(error), "translation_failed")
