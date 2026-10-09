import importlib

from django.apps import apps
from django.db import connection

import pytest

from core.models import AIPrompt
from core.services.ai_agent_providers import _all_prompts

pytestmark = pytest.mark.django_db


def test_catalog_replacement_removes_old_rows_and_isolates_system_instructions():
    legacy = AIPrompt.objects.create(label="Legacy", content="old")
    migration = importlib.import_module("core.migrations.0199_manage_assistant_prompts")
    with connection.schema_editor() as editor:
        migration.replace_catalog(apps, editor)
    assert not AIPrompt.objects.filter(pk=legacy.pk).exists()
    assert AIPrompt.objects.count() == 12
    choices = _all_prompts()
    assert len(choices) == 4
    assert {row["code"] for row in choices} == {
        "call.scene.travel",
        "call.scene.travel_ja",
        "call.scene.business",
        "call.scene.practice",
    }
    assert all(row["content"] for row in choices)
