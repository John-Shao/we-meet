"""Real isolated PostgreSQL audit integration, run with project's Test settings."""

import importlib.util
from pathlib import Path
import uuid
from unittest.mock import patch

from django.db import InternalError
from django.utils import timezone

import pytest

from core.factories import UserFactory
from core.models import AIUsageRecord
from work.models import WorkMaterial, WorkRun, WorkTask

spec = importlib.util.spec_from_file_location("acceptance_db_audit", Path(__file__).with_name("check-work-acceptance.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
pytestmark = pytest.mark.django_db(transaction=True)


@pytest.fixture
def records():
    now = timezone.now()
    owner = UserFactory()
    for case in audit.CASES:
        _, task_id, run_id, inputs, outputs, material_ids = case
        task = WorkTask.objects.create(pk=task_id, owner=owner, request_key=uuid.uuid4(),
                                       recipient="synthetic", goal="audit fixture",
                                       sources=[{"id": key} for key in material_ids])
        usage = AIUsageRecord.objects.create(user=owner, ref_type="work_run", ref_id=run_id,
                                             model_code="qwen3.8-flash", input_tokens=inputs, output_tokens=outputs)
        WorkRun.objects.create(pk=run_id, task=task, request_key=uuid.uuid4(), status="succeeded",
                               model="qwen3.8-flash", base_url="https://example.invalid/v1", reserved_tokens=3000,
                               max_output_tokens=1600, input_tokens=inputs, output_tokens=outputs, usage_record=usage)
        WorkRun.objects.filter(pk=run_id).update(created_at=now, call_started_at=now, finished_at=now)
        for key in material_ids:
            WorkMaterial.objects.create(pk=key, owner=owner, upload_key=uuid.uuid4(),
                                        original_name="synthetic.txt", storage_key="", checksum="fixture", size=10,
                                        mime="text/plain", deleted_at=now, purged_at=now)


def test_real_queries_reconcile_five_runs_six_materials_without_mutations(records):
    before = list(WorkRun.objects.values())
    result = audit.audit()
    assert result["ok"]
    assert len(result["runs"]) == 5
    assert len(result["materials"]) == 6
    assert not result["independent_object_absence_verified"]
    assert list(WorkRun.objects.values()) == before


@pytest.mark.parametrize("failure", ["duplicate", "missing_link", "unpurged", "wrong_owner"])
def test_real_reconciliation_detects_incomplete_receipts(records, failure):
    case = audit.CASES[0]
    if failure == "duplicate":
        AIUsageRecord.objects.create(ref_type="work_run", ref_id=case[2])
    elif failure == "missing_link":
        WorkRun.objects.filter(pk=case[2]).update(usage_record=None)
    elif failure == "unpurged":
        WorkMaterial.objects.filter(pk=case[5][0]).update(purged_at=None, storage_key="private-key")
    else:
        AIUsageRecord.objects.filter(ref_type="work_run", ref_id=case[2]).update(user=None)
    assert not audit.audit()["ok"]


def test_transaction_rejects_accidental_writes(records):
    def attempt_write(*args):
        WorkMaterial.objects.filter(pk=audit.CASES[0][5][0]).update(storage_key="should-not-write")
    with patch.object(audit, "inspect_run", side_effect=attempt_write), pytest.raises(InternalError):
        audit.audit()
    assert WorkMaterial.objects.get(pk=audit.CASES[0][5][0]).storage_key == ""
