"""OpenAI-compatible LLM client wrapping Volcengine Ark.

We use the official ``openai`` SDK pointed at Ark's OpenAI-compatible
endpoint (``https://ark.cn-beijing.volces.com/api/v3``). Same wire format,
Doubao billing. Settings:

* ``ARK_API_KEY``          — Ark API key
* ``DOUBAO_LLM_ENDPOINT``  — Ark endpoint id (``ep-...``) used as ``model``
* ``ARK_BASE_URL``         — overridable (default Ark CN-Beijing)

This module is intentionally synchronous: callers are Celery tasks and
management commands, neither benefits from an async client.
"""

from __future__ import annotations

import logging
from typing import Optional

from django.conf import settings

logger = logging.getLogger(__name__)


_DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"


class LLMUnavailable(RuntimeError):
    """Raised when the LLM client cannot be constructed (missing config)."""


class LLMClient:
    """Thin wrapper around ``openai.OpenAI`` for chat completion + embedding."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        base_url: str = _DEFAULT_BASE_URL,
        timeout: float = 60.0,
    ) -> None:
        # Imported lazily so the rest of the app keeps booting even when
        # the openai package is unavailable in a partial dev setup.
        from openai import OpenAI

        self._client = OpenAI(api_key=api_key, base_url=base_url, timeout=timeout)
        self._model = model

    @classmethod
    def from_settings(cls) -> "LLMClient":
        api_key = getattr(settings, "ARK_API_KEY", None) or ""
        model = getattr(settings, "DOUBAO_LLM_ENDPOINT", None) or ""
        base_url = (
            getattr(settings, "ARK_BASE_URL", None) or _DEFAULT_BASE_URL
        )
        if not api_key or not model:
            raise LLMUnavailable(
                "ARK_API_KEY / DOUBAO_LLM_ENDPOINT not configured. "
                "See helm values for backend.envVars."
            )
        return cls(api_key=api_key, model=model, base_url=base_url)

    @property
    def model(self) -> str:
        return self._model

    def chat(
        self,
        *,
        system: str,
        user: str,
        temperature: float = 0.3,
        max_tokens: Optional[int] = None,
        response_format: Optional[dict] = None,
    ) -> str:
        """Single-turn chat completion. Returns the assistant message text."""
        kwargs: dict = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
        }
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        if response_format is not None:
            kwargs["response_format"] = response_format

        resp = self._client.chat.completions.create(**kwargs)
        return (resp.choices[0].message.content or "").strip()

    def chat_json(
        self,
        *,
        system: str,
        user: str,
        temperature: float = 0.2,
    ) -> str:
        """Chat completion forcing ``response_format=json_object``.

        Returns the raw JSON text; callers must ``json.loads()`` it. We do
        not parse here because some Ark endpoints don't honour the
        ``response_format`` flag and we want the caller to handle the
        garbage gracefully.
        """
        return self.chat(
            system=system,
            user=user,
            temperature=temperature,
            response_format={"type": "json_object"},
        )
