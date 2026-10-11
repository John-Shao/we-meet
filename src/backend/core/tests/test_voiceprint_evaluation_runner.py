"""Research execution, blind split order, real core matching and media provenance."""

import base64
import copy
import hashlib
import io
import json
import math
import struct
import wave
from pathlib import Path

from django.core.management import call_command
from django.core.management.base import CommandError

import pytest

from core.services import voiceprint_evaluation as evaluation
from core.services.voiceprint_encoder import EncoderResult


def file_digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source(path, tag, enrollment=False):
    seconds = 30 if enrollment else 60
    rows = bytearray(seconds * 48000)
    boundaries = range(0, seconds, 10)
    for slot, start in enumerate(boundaries):
        known = enrollment or start < 30
        period = 120 if known else 48
        cycle = b"".join(
            int(7000 * math.sin(2 * math.pi * i / period)).to_bytes(
                2, "little", signed=True
            )
            for i in range(period)
        )
        block = bytearray((cycle * (240000 // period + 1))[:480000])
        struct.pack_into("<hhh", block, 0, 100 if known else 200, tag, slot)
        rows[start * 48000 : (start + 10) * 48000] = block
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(24000)
        stream.writeframes(rows)


def corpus(root):
    annotation = root / "annotations.txt"
    annotation.write_text(
        "synthetic annotation declarations; no human data", encoding="utf-8"
    )
    quality = {
        "valid_speech_ms": 10000,
        "speech_checked": True,
        "speaker_consistency_checked": True,
        "speaker_count": 1,
    }

    def clips(rid, start=0):
        return [
            {
                "recording_id": rid,
                "start_ms": start + i * 10000,
                "end_ms": start + (i + 1) * 10000,
                "quality": quality.copy(),
            }
            for i in range(3)
        ]

    sessions = []
    for index, split in enumerate(("enrollment", "calibration", "test"), 1):
        path = root / (split + ".wav")
        source(path, index, split == "enrollment")
        sessions.append(
            {
                "session_id": split + "_session",
                "split": split,
                "subjects": ["opaque_known"]
                if split == "enrollment"
                else ["opaque_known", "opaque_visitor"],
                "recordings": [
                    {
                        "recording_id": split + "_record",
                        "path": path.name,
                        "sha256": file_digest(path),
                    }
                ],
            }
        )
    queries = []
    for split in ("calibration", "test"):
        for subject, start in (("opaque_known", 0), ("opaque_visitor", 30000)):
            queries.append(
                {
                    "query_id": split + "_" + subject,
                    "subject_id": subject,
                    "session_id": split + "_session",
                    "recording_id": split + "_record",
                    "start_ms": start,
                    "end_ms": start + 30000,
                    "condition": "near",
                    "eligible": True,
                    "candidate_subjects": ["opaque_known"],
                    "clips": clips(split + "_record", start),
                }
            )
    return {
        "schema_version": 1,
        "origin": "synthetic",
        "authorization": None,
        "annotation": {"path": annotation.name, "sha256": file_digest(annotation)},
        "sessions": sessions,
        "enrollment": [
            {
                "subject_id": "opaque_known",
                "device_group": "default",
                "clips": clips("enrollment_record"),
            }
        ],
        "queries": queries,
        "policy_grid": [
            {"accept": 0.95, "margin": 0.05, "min_pair_cosine": 0.85},
            {"accept": 0.99, "margin": 0.05, "min_pair_cosine": 0.85},
        ],
        "threshold_version": "research_fixture_v1",
    }


class FixtureClient:
    def __init__(self, *, fail=None, test_wrong=False, calibration_no_unknown=False):
        self.tags = []
        self.fail = fail
        self.test_wrong = test_wrong
        self.calibration_no_unknown = calibration_no_unknown

    def extract(self, wav, **kwargs):
        with wave.open(io.BytesIO(wav), "rb") as stream:
            marker, tag, _slot = struct.unpack("<hhh", stream.readframes(3))
        self.tags.append(tag)
        if self.fail:
            raise ValueError(self.fail)
        visitor = marker == 200
        if tag == 2 and self.calibration_no_unknown:
            visitor = False
        if tag == 3 and self.test_wrong:
            visitor = False
        first = 0.96 if visitor else 1.0
        vector = (first, math.sqrt(1 - first**2), *(0.0 for _ in range(1022)))
        return EncoderResult(vector, {}, hashlib.sha256(wav).hexdigest())


def test_extraction_matching_calibration_and_test_are_reproducible_without_database(
    tmp_path,
):
    data = corpus(tmp_path)
    client = FixtureClient()
    report = evaluation.execute(evaluation.Dataset(data, tmp_path), client)
    assert client.tags == [1] * 3 + [2] * 6 + [3] * 6
    assert report["extraction_calls"] == 15
    assert report["selected_research_parameters"]["accept"] == 0.99
    assert report["test_results"]["suggestion_precision"]["rate"] == 1
    assert report["test_results"]["unknown_false_acceptance"]["rate"] == 0
    assert (
        report["release_ready"] is False
        and report["production_threshold_written"] is False
    )
    assert report["database_used"] is False
    output = json.dumps(report)
    assert all(
        value not in output
        for value in (
            "opaque_known",
            "opaque_visitor",
            "enrollment.wav",
            "test_record",
            "vector",
        )
    )


def test_heldout_predictions_cannot_change_selected_parameters(tmp_path):
    data = corpus(tmp_path)
    before = evaluation.execute(evaluation.Dataset(data, tmp_path), FixtureClient())
    after = evaluation.execute(
        evaluation.Dataset(data, tmp_path), FixtureClient(test_wrong=True)
    )
    assert (
        before["selected_research_parameters"] == after["selected_research_parameters"]
    )
    assert before["calibration_sha256"] == after["calibration_sha256"]
    assert after["test_results"]["unknown_false_acceptance"]["rate"] == 1
    assert after["release_ready"] is False


def test_no_feasible_grid_does_not_touch_test_audio(tmp_path):
    client = FixtureClient(calibration_no_unknown=True)
    report = evaluation.execute(evaluation.Dataset(corpus(tmp_path), tmp_path), client)
    assert client.tags == [1] * 3 + [2] * 6
    assert (
        report["test_results"] is None
        and report["selected_research_parameters"] is None
    )
    assert report["selection_status"] == "no_empirically_feasible_calibration_policy"


@pytest.mark.parametrize(
    "change",
    [
        "outside",
        "candidate",
        "duration",
        "overlap",
        "quality",
        "grid",
        "authorization",
        "device_group",
        "baseline",
        "threshold_version",
    ],
)
def test_invalid_or_unreviewed_manifest_fails_before_rpc(tmp_path, change):
    data = corpus(tmp_path)
    if change == "outside":
        data["sessions"][0]["recordings"][0]["path"] = "../outside.wav"
    elif change == "candidate":
        data["queries"][0]["candidate_subjects"] = ["missing_template"]
    elif change == "duration":
        data["queries"][0]["clips"][0]["end_ms"] = 10001
    elif change == "overlap":
        data["queries"][0]["clips"][1] = copy.deepcopy(data["queries"][0]["clips"][0])
    elif change == "quality":
        data["enrollment"][0]["clips"][0]["quality"]["speech_checked"] = False
    elif change == "grid":
        data["policy_grid"][0]["accept"] = float("nan")
    elif change == "device_group":
        data["enrollment"][0]["device_group"] = "unsupported"
    elif change == "baseline":
        data["enrollment"][0]["device_group"] = "headset"
    elif change == "threshold_version":
        data["threshold_version"] = "_invalid"
    else:
        data["origin"] = "authorized_human"
    with pytest.raises(evaluation.EvaluationError):
        evaluation.Dataset(data, tmp_path)


def test_recording_and_canonical_pcm_duplicates_are_rejected(tmp_path):
    data = corpus(tmp_path)
    duplicate = (tmp_path / "calibration.wav").read_bytes()
    duplicate = (
        duplicate[:4]
        + (len(duplicate) + 4).to_bytes(4, "little")
        + duplicate[8:]
        + b"JUNK\x00\x00\x00\x00"
    )
    target = tmp_path / "test.wav"
    target.write_bytes(duplicate)
    data["sessions"][2]["recordings"][0]["sha256"] = file_digest(target)
    with pytest.raises(evaluation.EvaluationError, match="pcm_recording_reused"):
        evaluation.Dataset(data, tmp_path)


def test_changed_media_is_rejected_before_embedding(tmp_path):
    data = corpus(tmp_path)
    dataset = evaluation.Dataset(data, tmp_path)
    with (tmp_path / "enrollment.wav").open("ab") as stream:
        stream.write(b"changed")
    client = FixtureClient()
    with pytest.raises(evaluation.EvaluationError, match="media_changed"):
        evaluation.execute(dataset, client)
    assert client.tags == []


def test_copied_pcm_clip_in_distinct_source_is_rejected_before_reencoding(tmp_path):
    data = corpus(tmp_path)
    target = tmp_path / "calibration.wav"
    enrollment = (tmp_path / "enrollment.wav").read_bytes()
    changed = bytearray(target.read_bytes())
    # Whole recordings remain different; the first canonical ten seconds were copied.
    changed[44 : 44 + 480000] = enrollment[44 : 44 + 480000]
    target.write_bytes(changed)
    data["sessions"][1]["recordings"][0]["sha256"] = file_digest(target)
    client = FixtureClient()
    with pytest.raises(evaluation.EvaluationError, match="pcm_clip_reused"):
        evaluation.execute(evaluation.Dataset(data, tmp_path), client)
    assert client.tags == [1] * 3


def test_deadline_after_slicing_prevents_rpc(tmp_path, monkeypatch):
    dataset = evaluation.Dataset(corpus(tmp_path), tmp_path)
    clock = [0.0]
    original = dataset.wav

    def delayed_slice(clip):
        result = original(clip)
        clock[0] = 121.0
        return result

    monkeypatch.setattr(dataset, "wav", delayed_slice)
    monkeypatch.setattr(evaluation.time, "monotonic", lambda: clock[0])
    client = FixtureClient()
    with pytest.raises(evaluation.EvaluationError, match="deadline_exceeded"):
        evaluation.execute(dataset, client, deadline_seconds=120)
    assert client.tags == []


def test_command_private_output_no_overwrite_and_errors_do_not_echo_secret(
    tmp_path, settings, monkeypatch
):
    for name in (
        "MEETING_VOICEPRINT_ENABLED",
        "MEETING_VOICEPRINT_SAMPLING_ENABLED",
        "MEETING_VOICEPRINT_MATCHING_ENABLED",
    ):
        setattr(settings, name, False)
    data = corpus(tmp_path)
    manifest, config, output = (
        tmp_path / "manifest.json",
        tmp_path / "encoder.json",
        tmp_path / "report.json",
    )
    manifest.write_text(json.dumps(data), encoding="utf-8")
    config.write_text(
        json.dumps(
            {
                "purpose": "speaker-evaluation-only",
                "url": "https://127.0.0.1:8093",
                "api_token": "synthetic-token-of-at-least-32-bytes",
                "permit_key": base64.b64encode(
                    b"synthetic-key-of-at-least-32-bytes"
                ).decode(),
                "ca_bundle": True,
            }
        ),
        encoding="utf-8",
    )
    target = "core.management.commands.evaluate_voiceprint_dataset.EncoderClient"
    monkeypatch.setattr(target, lambda *args, **kwargs: FixtureClient())
    args = [
        "--manifest",
        str(manifest),
        "--dataset-root",
        str(tmp_path),
        "--isolated-encoder-config",
        str(config),
        "--output",
        str(output),
    ]
    stdout = io.StringIO()
    call_command("evaluate_voiceprint_dataset", *args, stdout=stdout)
    assert stdout.getvalue().strip() == "voiceprint_research_report_written"
    assert json.loads(output.read_text())["release_ready"] is False
    original = output.read_bytes()
    with pytest.raises(CommandError, match="output_exists"):
        call_command("evaluate_voiceprint_dataset", *args)
    assert output.read_bytes() == original
    output.unlink()
    monkeypatch.setattr(
        target,
        lambda *args, **kwargs: FixtureClient(fail="private-recording-token-path"),
    )
    with pytest.raises(CommandError) as error:
        call_command("evaluate_voiceprint_dataset", *args)
    assert str(error.value) == "evaluation_execution_failed" and not output.exists()


def test_command_refuses_enabled_business_environment(tmp_path, settings):
    settings.MEETING_VOICEPRINT_ENABLED = True
    with pytest.raises(CommandError, match="business_flags_must_be_disabled"):
        call_command(
            "evaluate_voiceprint_dataset",
            "--manifest",
            str(tmp_path / "missing"),
            "--dataset-root",
            str(tmp_path),
            "--isolated-encoder-config",
            str(tmp_path / "missing"),
            "--output",
            str(tmp_path / "output"),
        )


@pytest.mark.parametrize(
    "case",
    [
        ("production", "https://127.0.0.1:8093", "isolated_config_required"),
        ("speaker-evaluation-only", "http://127.0.0.1:8093", "private_https_required"),
        ("speaker-evaluation-only", "https://example.com", "private_https_required"),
    ],
)
def test_command_rejects_nonisolated_config_before_client(
    tmp_path, settings, monkeypatch, case
):
    purpose, url, code = case
    settings.MEETING_VOICEPRINT_ENABLED = False
    settings.MEETING_VOICEPRINT_SAMPLING_ENABLED = False
    settings.MEETING_VOICEPRINT_MATCHING_ENABLED = False
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps(corpus(tmp_path)), encoding="utf-8")
    config = tmp_path / "encoder.json"
    config.write_text(
        json.dumps(
            {
                "purpose": purpose,
                "url": url,
                "api_token": "unused",
                "permit_key": "unused",
                "ca_bundle": True,
            }
        ),
        encoding="utf-8",
    )
    clients = []
    monkeypatch.setattr(
        "core.management.commands.evaluate_voiceprint_dataset.EncoderClient",
        lambda *args, **kwargs: clients.append(True),
    )
    output = tmp_path / "report.json"
    with pytest.raises(CommandError, match=code):
        call_command(
            "evaluate_voiceprint_dataset",
            "--manifest",
            str(manifest),
            "--dataset-root",
            str(tmp_path),
            "--isolated-encoder-config",
            str(config),
            "--output",
            str(output),
        )
    assert clients == [] and not output.exists()
