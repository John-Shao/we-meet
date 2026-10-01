"""Speech language policy is scoped to the bilingual assistant."""

import os
import unittest
from unittest.mock import patch

from plugins.qwen.live_translate import (
    AUDIO_LANGUAGES,
    TranslationConfig,
    audio_language_pair,
)


class LanguagePolicyTests(unittest.TestCase):
    def test_assistant_enables_all_speech_languages_without_widening_other_products(
        self,
    ):
        env = {
            "DASHSCOPE_API_KEY": "test",
            "DASHSCOPE_WORKSPACE_ID": "workspace",
            "QWEN_TRANSLATION_LANGUAGES": "zh,en",
        }
        with patch.dict(os.environ, env, clear=True):
            for language in AUDIO_LANGUAGES:
                other = "en" if language != "en" else "zh"
                config = TranslationConfig.from_env(
                    target=language, source=other, enabled_languages=AUDIO_LANGUAGES
                )
                self.assertEqual(config.session()["translation"]["language"], language)
                self.assertEqual(
                    config.session()["output_modalities"], ["text", "audio"]
                )
            with self.assertRaises(ValueError):
                TranslationConfig.from_env(target="ja")

    def test_documented_audio_list_excludes_text_only_languages(self):
        expected = "zh en ar de fr es pt id it ko ru th vi ja tr hi ms nl ur nb sv da he fi pl is cs fil fa".split()
        self.assertEqual(AUDIO_LANGUAGES, set(expected))
        for language in "yue el af ast be bg bn bs ca ceb et gl gu hr hu jv kk kn ky lv mk ml mr pa ro sk sl sw tg az uk".split():
            with self.subTest(language=language), self.assertRaises(ValueError):
                audio_language_pair(("en", language))
