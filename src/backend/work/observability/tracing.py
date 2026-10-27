"""Minimal span boundary; E7 wires it to the OTel SDK in deployment."""

import logging
import time
from contextlib import contextmanager

logger = logging.getLogger("work.tracing")


@contextmanager
def span(name: str, **attributes):
    started = time.monotonic()
    try:
        yield
    finally:
        logger.info(
            "span=%s duration_ms=%d attributes=%s",
            name,
            (time.monotonic() - started) * 1000,
            attributes,
        )
