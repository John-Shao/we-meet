"""Whole-file ASR for sealed captures; never replay PCM through realtime ASR."""

import asyncio
import inspect
import json
import os
import tempfile
import uuid
import wave
from dataclasses import dataclass, field
from datetime import timedelta
from http import HTTPStatus
from urllib.parse import urlsplit

import aiohttp
from minio import Minio

from asr_diagnostics import stage
from plugins.qwen_asr import ASRSentence

MODEL = "qwen-audio-3.0-asr-flash-filetrans"
MAX_RESULT_BYTES = 32 * 1024 * 1024


def storage_client(endpoint):
    """Use bucket hostnames and an explicit signing region for Alibaba OSS."""
    endpoint = endpoint.removeprefix("https://").removeprefix("http://").rstrip("/")
    is_oss = (urlsplit("https://" + endpoint).hostname or "").endswith(".aliyuncs.com")
    region = os.getenv("AWS_S3_REGION_NAME") or None
    style = os.getenv("AWS_S3_ADDRESSING_STYLE") or ("virtual" if is_oss else "auto")
    if style not in {"virtual", "path", "auto"}:
        raise ValueError("invalid_file_asr_storage_addressing")
    # MinIO's location discovery forces path addressing even in virtual mode.
    if is_oss and (not region or style != "virtual"):
        raise ValueError("file_asr_oss_region_and_virtual_style_required")
    client = Minio(
        endpoint,
        access_key=os.environ["AWS_S3_ACCESS_KEY_ID"],
        secret_key=os.environ["AWS_S3_SECRET_ACCESS_KEY"],
        secure=os.getenv("AWS_S3_SECURE_ACCESS", "true").lower() == "true",
        region=region,
    )
    if style == "virtual":
        client.enable_virtual_style_endpoint()
    elif style == "path":
        client.disable_virtual_style_endpoint()
    return client


@dataclass(frozen=True)
class QwenFileASRConfig:
    """File ASR settings are independent from the realtime model."""

    api_key: str = field(repr=False)
    region: str = "cn-beijing"
    model: str = MODEL
    base_url: str = ""

    def __post_init__(self):
        """Reject accidental use of a streaming model in a non-realtime worker."""
        if (
            not self.api_key
            or self.model != MODEL
            or self.region not in {"cn-beijing", "ap-southeast-1"}
        ):
            raise ValueError("invalid_file_asr_configuration")
        if self.base_url and (
            urlsplit(self.base_url).scheme != "https"
            or urlsplit(self.base_url).username
        ):
            raise ValueError("invalid_file_asr_endpoint")

    @property
    def url(self):
        """Use the configured workspace URL, or the matching regional endpoint."""
        return (
            self.base_url.rstrip("/")
            if self.base_url
            else (
                "https://dashscope.aliyuncs.com/api/v1"
                if self.region == "cn-beijing"
                else "https://dashscope-intl.aliyuncs.com/api/v1"
            )
        )

    @classmethod
    def from_env(cls):
        """Load the same dedicated file-ASR configuration as the backend."""
        return cls(
            api_key=os.getenv("DASHSCOPE_API_KEY", ""),
            region=os.getenv("QWEN_FILE_ASR_REGION", "cn-beijing"),
            model=os.getenv("QWEN_FILE_ASR_MODEL", MODEL),
            base_url=os.getenv("QWEN_FILE_ASR_BASE_URL", ""),
        )


class QwenFileASRSession:
    """One private WAV, one asynchronous task, bounded final delivery."""

    def __init__(self, config):
        """Keep receipt fields compatible with the capture publication protocol."""
        self.config = config
        self.task_id = str(uuid.uuid4())
        self.provider_finished = self.billing_observed = False
        self.input_samples = self.billed_seconds = 0
        self.cleanup_error = None

    async def request(self, client, method, url, *, body=None, auth=True):
        """Bound responses and keep the API key off result-storage requests."""
        headers = {"Authorization": f"Bearer {self.config.api_key}"} if auth else {}
        if method == "POST":
            headers["X-DashScope-Async"] = "enable"
        async with client.request(
            method, url, json=body, headers=headers, allow_redirects=False
        ) as response:
            if response.status != HTTPStatus.OK:
                raise ValueError("file_asr_request_failed")
            data = bytearray()
            async for part in response.content.iter_chunked(65536):
                data.extend(part)
                if len(data) > MAX_RESULT_BYTES:
                    raise ValueError("file_asr_result_too_large")
            with stage("result_parse"):
                return json.loads(data)

    async def run(self, audio, on_final):
        """Spool PCM to disk, submit once and preserve source-relative times."""
        with stage("storage_prepare"):
            endpoint = (
                os.environ["AWS_S3_ENDPOINT_URL"]
                .removeprefix("https://")
                .removeprefix("http://")
                .rstrip("/")
            )
            storage = storage_client(endpoint)
            public_endpoint = (
                (os.getenv("AWS_S3_PUBLIC_ENDPOINT_URL") or endpoint)
                .removeprefix("https://")
                .removeprefix("http://")
                .rstrip("/")
            )
            public = storage_client(public_endpoint)
            bucket = os.environ["AWS_STORAGE_BUCKET_NAME"]
            key = f"filetrans-temporary/{uuid.uuid4()}.wav"
        with tempfile.TemporaryDirectory(prefix="filetrans-") as directory:
            filename = os.path.join(directory, "audio.wav")
            with stage("storage_prepare"):
                with wave.open(filename, "wb") as output:
                    output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                    async for pcm in audio:
                        self.input_samples += len(pcm) // 2
                        if self.input_samples > 16000 * 43200:
                            raise ValueError("file_asr_audio_too_long")
                        output.writeframesraw(pcm)
            primary_failed = False
            try:
                with stage("storage_upload"):
                    await asyncio.to_thread(
                        storage.fput_object,
                        bucket,
                        key,
                        filename,
                        content_type="audio/wav",
                    )
                with stage("storage_sign"):
                    url = await asyncio.to_thread(
                        public.presigned_get_object,
                        bucket,
                        key,
                        expires=timedelta(hours=24),
                    )
                await self.transcribe(url, on_final)
            except BaseException:
                primary_failed = True
                raise
            finally:
                try:
                    with stage("cleanup"):
                        await asyncio.to_thread(storage.remove_object, bucket, key)
                except Exception as error:
                    self.cleanup_error = error
                    if not primary_failed:
                        raise

    async def transcribe(self, url, on_final):
        """Submit one task and stream parsed finals without automatic resubmission."""
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=45)
        ) as client:
            with stage("transcription_submit"):
                result = await self.request(
                    client,
                    "POST",
                    self.config.url + "/services/audio/asr/transcription",
                    body={
                        "model": MODEL,
                        "input": {"file_urls": [url]},
                        "parameters": {"channel_id": [0]},
                    },
                )
                self.task_id = str(uuid.UUID(result["output"]["task_id"]))
            with stage("transcription_poll"):
                async with asyncio.timeout(86400):
                    while True:
                        result = await self.request(
                            client,
                            "GET",
                            self.config.url + "/tasks/" + self.task_id,
                        )
                        status = result["output"]["task_status"]
                        if status not in {"PENDING", "RUNNING"}:
                            break
                        await asyncio.sleep(5)
                files = result["output"].get("results", [])
                if (
                    status != "SUCCEEDED"
                    or len(files) != 1
                    or files[0].get("subtask_status") != "SUCCEEDED"
                ):
                    raise ValueError("file_asr_failed")
                result_url = files[0]["transcription_url"]
                parsed = urlsplit(result_url)
                if parsed.scheme != "https" or not (parsed.hostname or "").endswith(
                    ".aliyuncs.com"
                ):
                    raise ValueError("invalid_file_asr_result_url")
            with stage("result_fetch"):
                transcript = await self.request(client, "GET", result_url, auth=False)
            with stage("result_parse"):
                duration = result.get("usage", {}).get("duration")
                if isinstance(duration, (int, float)) and duration >= 0:
                    self.billed_seconds, self.billing_observed = duration, True
            await self.publish(transcript, on_final)
            self.provider_finished = True

    async def publish(self, transcript, on_final):
        """Validate result structure before converting and delivering each sentence."""
        with stage("result_parse"):
            channels = transcript["transcripts"]
            if not isinstance(channels, list):
                raise ValueError("invalid_transcript_channels")
        for channel in channels:
            with stage("result_parse"):
                sentences = channel["sentences"]
                if not isinstance(sentences, list):
                    raise ValueError("invalid_transcript_sentences")
            for item in sentences:
                with stage("result_parse"):
                    if not item["text"].strip():
                        continue
                    sentence = ASRSentence(
                        str(uuid.uuid4()),
                        item["text"],
                        item.get("language", ""),
                        item["begin_time"],
                        item["end_time"],
                    )
                with stage("delivery"):
                    delivered = on_final(sentence)
                    if inspect.isawaitable(delivered):
                        await delivered
                # Let the bounded writer drain a long file result.
                await asyncio.sleep(0)
