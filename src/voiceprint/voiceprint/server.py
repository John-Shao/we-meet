"""Internal-only WAV encoder. No identity, URL fetching, or persistent request data."""

import argparse
import asyncio
import hmac
import os
import ssl
import time
from pathlib import Path

from aiohttp import web

from voiceprint.audio import AudioRejected, decode_wav
from voiceprint.isolated_encoder import IsolatedEncoder
from voiceprint.permits import (
    PermitRejected,
    UsedPermits,
    validate_payload,
    validate_permit,
)
from voiceprint.process_protocol import EncoderProcessError
from voiceprint.spec import MAX_BODY_BYTES


class EncoderService:
    def __init__(self, encoder, token: bytes, permit_key: bytes):
        if (
            not isinstance(token, bytes)
            or not 32 <= len(token) <= 256
            or any(byte < 33 or byte > 126 for byte in token)
            or not isinstance(permit_key, bytes)
            or not 32 <= len(permit_key) <= 4096
            or token == permit_key
        ):
            raise ValueError("service_credentials_invalid")
        self.encoder = encoder
        self.token = token
        self.permit_key = permit_key
        self.nonces = UsedPermits()
        self.active: asyncio.Task | None = None
        self.uploads = 0
        self.recovery: asyncio.Task | None = None
        self.next_recovery = 0.0
        self.closing = False

    @property
    def ready(self):
        return not self.closing and (
            not isinstance(self.encoder, IsolatedEncoder) or self.encoder.ready
        )

    async def warm(self):
        try:
            await asyncio.to_thread(self.encoder.start)
        except Exception:
            # Keep readiness false without logging model paths or native errors.
            return

    def restore(self):
        if (
            not self.closing
            and isinstance(self.encoder, IsolatedEncoder)
            and not self.encoder.ready
            and (self.recovery is None or self.recovery.done())
            and time.monotonic() >= self.next_recovery
        ):
            self.next_recovery = time.monotonic() + 10
            self.recovery = asyncio.create_task(self.warm())

    def finished(self, task):
        # Release references even if the caller disconnected; never allow a
        # second model call while the shielded extraction is still running.
        if self.active is task:
            self.active = None
        if not task.cancelled():
            task.exception()  # Consume abandoned errors without logging payloads.
        self.restore()


SERVICE = web.AppKey("encoder_service", EncoderService)


def response(body: dict, *, status: int = 200):
    return web.json_response(
        body, status=status, headers={"Cache-Control": "private, no-store"}
    )


async def health(_request):
    ready = _request.app[SERVICE].ready
    return response(
        {"status": "ready" if ready else "warming"}, status=200 if ready else 503
    )


async def live(_request):
    return response({"status": "alive"})


async def startup(app):
    if isinstance(app[SERVICE].encoder, IsolatedEncoder):
        await asyncio.to_thread(app[SERVICE].encoder.start)


async def cleanup(app):
    service = app[SERVICE]
    service.closing = True
    if isinstance(service.encoder, IsolatedEncoder):
        await asyncio.to_thread(service.encoder.close)
        pending = [
            task for task in (service.active, service.recovery) if task is not None
        ]
        if pending:
            await asyncio.wait_for(
                asyncio.gather(*pending, return_exceptions=True), timeout=4
            )


async def embedding(request: web.Request):
    service = request.app[SERVICE]
    try:
        auth = request.headers.get("Authorization", "").encode("ascii")
    except UnicodeError:
        return response({"code": "unauthorized"}, status=401)
    if not hmac.compare_digest(auth, b"Bearer " + service.token):
        return response({"code": "unauthorized"}, status=401)
    permit = request.headers.get("X-Voiceprint-Permit", "")
    try:
        claims = validate_permit(permit, service.permit_key, service.encoder.space)
    except PermitRejected as error:
        return response({"code": str(error)}, status=403)
    if not service.ready:
        service.restore()
        return response({"code": "encoder_unavailable"}, status=503)
    if request.content_type != "audio/wav":
        return response({"code": "content_type_invalid"}, status=415)
    if request.content_length is not None and request.content_length != claims["bytes"]:
        return response({"code": "permit_payload_mismatch"}, status=403)
    if service.active is not None and not service.active.done():
        return response({"code": "encoder_busy"}, status=503)
    if service.uploads >= 2:
        return response({"code": "encoder_busy"}, status=503)
    service.uploads += 1
    try:
        try:
            async with asyncio.timeout(10):
                body = await request.read()
        finally:
            service.uploads -= 1
        # Reject expiry during upload before consuming any model resources.
        claims = validate_permit(permit, service.permit_key, service.encoder.space)
        validate_payload(claims, body)
        clip = decode_wav(body)
        # Reading the HTTP body yielded; another valid request may have begun.
        if service.active is not None and not service.active.done():
            return response({"code": "encoder_busy"}, status=503)
        service.nonces.reserve(claims)
    except web.HTTPRequestEntityTooLarge:
        return response({"code": "audio_size_invalid"}, status=413)
    except TimeoutError:
        return response({"code": "audio_upload_timeout"}, status=408)
    except PermitRejected as error:
        return response(
            {"code": str(error)},
            status={"permit_replayed": 409, "permit_capacity_exceeded": 503}.get(
                str(error), 403
            ),
        )
    except AudioRejected as error:
        return response({"code": str(error)}, status=422)
    service.active = task = asyncio.create_task(
        asyncio.to_thread(service.encoder.extract, clip)
    )
    task.add_done_callback(service.finished)
    try:
        result = await asyncio.shield(task)
        # A grant that expired during inference cannot release an embedding.
        validate_permit(permit, service.permit_key, service.encoder.space)
        return response({**result, "input_sha256": claims["sha256"]})
    except PermitRejected as error:
        return response({"code": str(error)}, status=403)
    except EncoderProcessError as error:
        code = (
            "encoder_timeout"
            if str(error) == "encoder_timeout"
            else "encoder_unavailable"
        )
        return response({"code": code}, status=503)
    except Exception:  # Model errors must never include audio, vectors or names.
        return response({"code": "encoder_unavailable"}, status=503)


def create_app(encoder, *, token: bytes, permit_key: bytes):
    app = web.Application(client_max_size=MAX_BODY_BYTES)
    app[SERVICE] = EncoderService(encoder, token, permit_key)
    app.router.add_get("/health/ready", health)
    app.router.add_get("/health/live", live)
    app.router.add_post("/v1/embeddings", embedding)
    app.on_startup.append(startup)
    app.on_cleanup.append(cleanup)
    return app


def read_secret_file(variable: str) -> bytes:
    path = Path(os.environ[variable])
    with path.open("rb") as stream:
        raw = stream.read(4097)
    if len(raw) > 4096:
        raise ValueError("service_credentials_invalid")
    value = raw.strip()
    if len(value) < 32:
        raise ValueError("service_credentials_invalid")
    return value


def server_tls(host: str):
    cert = os.environ.get("VOICEPRINT_TLS_CERT_FILE")
    key = os.environ.get("VOICEPRINT_TLS_KEY_FILE")
    if bool(cert) != bool(key):
        raise ValueError("service_tls_configuration_invalid")
    if not cert:
        if host not in ("127.0.0.1", "::1", "localhost"):
            raise ValueError("service_tls_required")
        return None
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(cert, key)
    return context


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8093, type=int)
    args = parser.parse_args()
    tls = server_tls(args.host)
    encoder = IsolatedEncoder(
        Path(os.environ["VOICEPRINT_MODEL_DIR"]),
        expected_sha256=os.environ["VOICEPRINT_ENCODER_SHA256"],
        threads=int(os.environ.get("VOICEPRINT_CPU_THREADS", "2")),
    )
    app = create_app(
        encoder,
        token=read_secret_file("VOICEPRINT_API_TOKEN_FILE"),
        permit_key=read_secret_file("VOICEPRINT_PERMIT_KEY_FILE"),
    )
    web.run_app(
        app,
        host=args.host,
        port=args.port,
        ssl_context=tls,
        access_log=None,
        print=None,
    )


if __name__ == "__main__":
    main()
