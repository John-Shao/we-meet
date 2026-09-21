"""Explicit, sequential paid file-ASR evaluation of the frozen synthetic corpus."""

import argparse
import asyncio
import hashlib
import io
import json
import sys
import time
import wave
import zipfile
from pathlib import Path

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT.parents[1]))

from asr_diagnostics import failures  # noqa: E402
from plugins.qwen_filetrans import QwenFileASRConfig, QwenFileASRSession  # noqa: E402

KNOWN_LANGUAGES = {"two-speakers-clean": "en", "terms-zh-clean": "zh"}
TERM_LANGUAGES = {"terms-zh-clean": "zh", "terms-zh-noise10": "zh", "silence": "zh"}


class LanguageCandidateSession(QwenFileASRSession):
    """Evaluation-only request parameter; production adapter stays unchanged."""

    def __init__(self, config, language, *, term_candidate=False):
        """Allow only the two known synthetic script languages."""
        super().__init__(config)
        if language not in {"en", "zh"}:
            raise ValueError("Unsupported candidate language")
        self.language = language
        self.term_candidate = term_candidate

    async def request(self, client, method, url, *, body=None, auth=True):
        """Add hints only to the exact submission, preserving result auth behavior."""
        if (
            method == "POST"
            and url == self.config.url + "/services/audio/asr/transcription"
        ):
            body = {
                **body,
                "parameters": {**body["parameters"], "language_hints": [self.language]},
            }
            if self.term_candidate:
                body["parameters"]["vocabulary"] = {"妙记": 5}
        return await super().request(client, method, url, body=body, auth=auth)


async def run(output, label, *, known_language_candidate=False, term_candidate=False):
    """Record observations after each single submission and stop on first failure."""
    if output.exists():
        raise ValueError("Refusing to overwrite prior observations")
    if known_language_candidate and term_candidate:
        raise ValueError("Only one candidate at a time")
    languages = TERM_LANGUAGES if term_candidate else KNOWN_LANGUAGES
    candidate = known_language_candidate or term_candidate
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    config = QwenFileASRConfig.from_env()
    measured = {
        "label": label,
        "model": config.model,
        "region": config.region,
        "adapter": "sealed_filetrans_no_diarization_or_hotwords",
        "cases": [],
    }
    if known_language_candidate:
        measured["candidate"] = "known_script_language_hints_only"
        measured["scope"] = (
            "Two clean synthetic fixtures only; no production parameter change"
        )
    if term_candidate:
        measured["candidate"] = "known_zh_language_and_one_term_weight5"
        measured["scope"] = (
            "Two Chinese fixtures and silence; no production parameter change"
        )
    with zipfile.ZipFile(ROOT / "fixtures.zip") as archive:
        # Validate every fixture before the first paid submission.
        for case in manifest["cases"]:
            if (
                hashlib.sha256(archive.read(case["id"] + ".wav")).hexdigest()
                != case["sha256"]
            ):
                raise ValueError("Fixture checksum mismatch")
        for case in manifest["cases"]:
            if candidate and case["id"] not in languages:
                continue
            with wave.open(io.BytesIO(archive.read(case["id"] + ".wav")), "rb") as wav:
                pcm = wav.readframes(wav.getnframes())
            session = (
                LanguageCandidateSession(
                    config, languages[case["id"]], term_candidate=term_candidate
                )
                if candidate
                else QwenFileASRSession(config)
            )
            observed = {"id": case["id"], "sha256": case["sha256"], "segments": []}
            if candidate:
                observed["language_hints"] = [languages[case["id"]]]
            if term_candidate:
                observed["vocabulary"] = {"妙记": 5}

            async def audio(source=pcm):
                for start in range(0, len(source), 3200):
                    yield source[start : start + 3200]

            async def final(sentence, result=observed):
                result["segments"].append(
                    {
                        "text": sentence.text,
                        "start_ms": sentence.start_ms,
                        "end_ms": sentence.end_ms,
                        "speaker": None,
                        "language": sentence.language,
                    }
                )

            started = time.monotonic()
            try:
                async with asyncio.timeout(180):
                    await session.run(audio(), final)
                observed["status"] = (
                    "succeeded" if session.provider_finished else "failed"
                )
            except Exception as error:
                observed["status"] = "failed"
                observed["errors"] = [
                    {"stage": e.stage, "code": e.code} for e in failures(error)
                ]
            observed["elapsed_ms"] = round((time.monotonic() - started) * 1000)
            measured["cases"].append(observed)
            output.write_text(
                json.dumps(measured, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
                newline="\n",
            )
            print(  # noqa: T201 -- bounded operator progress
                json.dumps(
                    {
                        "id": case["id"],
                        "status": observed["status"],
                        "elapsed_ms": observed["elapsed_ms"],
                    }
                ),
                flush=True,
            )
            if observed["status"] != "succeeded":
                # Do not repeat an infrastructure failure or resubmit a paid task.
                break


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Submit up to six paid ASR tasks; never retry automatically",
    )
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--label", required=True)
    candidates = parser.add_mutually_exclusive_group()
    candidates.add_argument(
        "--known-language-candidate",
        action="store_true",
        help="Two clean fixtures with known language hints; up to two paid tasks",
    )
    candidates.add_argument(
        "--term-candidate",
        action="store_true",
        help="Two Chinese fixtures and silence, with one term; up to three paid tasks",
    )
    args = parser.parse_args()
    if not args.execute:
        parser.error("--execute is required for paid provider requests")
    try:
        asyncio.run(
            run(
                args.output,
                args.label,
                known_language_candidate=args.known_language_candidate,
                term_candidate=args.term_candidate,
            )
        )
    except Exception:
        print("Evaluation setup failed; no raw provider error or credential printed.")  # noqa: T201
        raise SystemExit(1) from None
