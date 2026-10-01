"""Idle-only, bounded transport recovery for the bilingual assistant."""

import asyncio
import logging
import time

from websockets.exceptions import ConnectionClosed, InvalidStatus

from plugins.qwen.live_translate import (
    TranslationError,
    TranslationEvents,
    TranslationSession,
    retryable_transport,
)

logger = logging.getLogger("bilingual-session")
RECONNECT_DELAYS = (0.2, 0.5, 1.0)
RECONNECT_TIMEOUT = 6.0


class BilingualTranslationSession(TranslationSession):
    """Recover silence-only disconnects without replaying any accepted speech."""

    def __init__(self, config, consume, **kwargs):
        """Keep recovery isolated from capture and push-to-talk sessions."""
        super().__init__(config, self._consume, **kwargs)
        self._deliver = consume
        self._speaking = False
        self._awaiting_response = False
        self._overlapping_turns = False
        self._first_audio_at = None
        self._attempts = 0
        self._recovery_task = None
        self._transport_ready = asyncio.Event()
        self._transport_ready.set()
        self.output_idle = lambda: True

    async def send_speech(self, pcm):
        """Mark speech before writing, including all-zero frames in an utterance."""
        async with self._send_lock:
            if not self._speaking and self._awaiting_response:
                # A response can finish after the next utterance was sent. Its
                # completion cannot prove that all later input was translated.
                self._overlapping_turns = True
            if not self._speaking and not self._awaiting_response:
                self._first_audio_at = time.monotonic()
            self._speaking = self._awaiting_response = True
        await self.send_audio(pcm)

    async def end_turn(self):
        """A sent VAD boundary does not imply a delivered translation."""
        self._speaking = False

    async def _consume(self, event):
        await self._deliver(event)
        if event["type"] == "audio" and self._first_audio_at is not None:
            logger.info(
                "translation_first_audio source=%s target=%s elapsed_ms=%d",
                self.config.source,
                self.config.target,
                round((time.monotonic() - self._first_audio_at) * 1000),
            )
            self._first_audio_at = None
        if event["type"] == "response_completed" and not self._speaking:
            self._awaiting_response = False

    def _idle(self):
        return not (
            self._speaking
            or self._awaiting_response
            or self._overlapping_turns
            or self.events.pending
            or self._closed
            or self._ending
            or self._finish_requested
            or self.error_code
            or not self.output_idle()
        )

    async def _recover_transport(self, socket, *, send_locked=False):
        if self._closed or self._ending or self._finish_requested:
            return False
        if send_locked:
            return await self._recover_locked(socket)
        async with self._send_lock:
            return await self._recover_locked(socket)

    async def _wait_transport(self):
        if self._recovery_task and self._recovery_task is not asyncio.current_task():
            # A finish caller may hold the send lock while draining the receiver.
            # Waiting on that lock here would deadlock the finish handshake.
            await self._transport_ready.wait()
            if self.error_code or self._closed:
                raise TranslationError("translation_transport_closed")

    async def _recover_locked(self, socket):  # noqa: PLR0911 -- explicit fail-closed gates
        if socket is not self.socket:
            return not self.error_code and not self._closed
        if not self._idle() or self._attempts >= len(RECONNECT_DELAYS):
            return False
        self._recovery_task = asyncio.current_task()
        self._transport_ready.clear()
        try:
            async with asyncio.timeout(RECONNECT_TIMEOUT):
                while self._attempts < len(RECONNECT_DELAYS):
                    delay = RECONNECT_DELAYS[self._attempts]
                    self._attempts += 1
                    await self._discard_socket()
                    await asyncio.sleep(delay)
                    if not self._idle():
                        return False
                    logger.info("translation_reconnecting attempt=%d", self._attempts)
                    try:
                        self.socket = await self.connector(
                            self.config.url,
                            additional_headers={
                                "Authorization": f"Bearer {self.config.api_key}"
                            },
                            proxy=None,
                            open_timeout=2,
                            close_timeout=0.5,
                            max_size=128000,
                            max_queue=4,
                        )
                        if not self._idle():
                            return False
                        await self._expect("session.created")
                        await self._send(
                            "session.update", session=self.config.session()
                        )
                        await self._expect("session.updated")
                    except (OSError, ConnectionClosed, TimeoutError) as error:
                        if not retryable_transport(error):
                            return False
                        continue
                    except InvalidStatus as error:
                        if error.response.status_code in (429, 500, 502, 503, 504):
                            continue
                        return False
                    except TranslationError:
                        return False
                    self.events = TranslationEvents()
                    logger.info("translation_reconnected attempt=%d", self._attempts)
                    return True
        except TimeoutError:
            logger.info("translation_reconnect_timeout")
        finally:
            self._recovery_task = None
            self._transport_ready.set()
        return False

    async def close(self):
        """Cancel recovery even when it is owned by the silence sender."""
        self._closed = True
        task = self._recovery_task
        if task is not None and task is not asyncio.current_task():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await super().close()

    async def _discard_socket(self):
        socket, self.socket = self.socket, None
        if socket is not None:
            try:
                await asyncio.wait_for(socket.close(), 0.5)
            except Exception:
                logger.debug("translation_recovery_socket_close_failed")
