"""Qwen 3.8 catalog migration and dispatch compatibility on a real database."""

from importlib import import_module
from types import SimpleNamespace

from django.db import connection
from django.db.migrations.executor import MigrationExecutor

import pytest

from core import models
from core.services.ai_agent_providers import (
    build_agent_metadata,
    resolve_profile_context,
)

migration = import_module("core.migrations.0195_upgrade_qwen_omni_38")
pytestmark = pytest.mark.django_db


def upgrade():
    """Run the data operation against its historical model registry."""
    state = MigrationExecutor(connection).loader.project_state(
        [("core", "0194_room_reservation_lifecycle")]
    )
    migration.upgrade_catalog(state.apps, SimpleNamespace(connection=connection))


@pytest.fixture
def legacy_catalog():
    """Create active legacy profiles without relying on seeded default choices."""
    vendor, _ = models.AIVendor.objects.get_or_create(
        code="aliyun", defaults={"display_name": "Aliyun"}
    )
    old, _ = models.AIModel.objects.update_or_create(
        vendor=vendor,
        capability="omni",
        code=migration.OLD_MODEL_CODE,
        defaults={"display_name": "Legacy Qwen", "is_active": True},
    )
    profiles = {}
    for value in ("Cherry", "Ethan", "Ryan"):
        voice, _ = models.AIVoice.objects.update_or_create(
            model=old, value=value, defaults={"label": value, "is_active": True}
        )
        profiles[value] = models.AIAgentProfile.objects.create(
            code=f"migration-qwen-{value.lower()}",
            display_name=value,
            architecture="omni",
            omni_model=old,
            default_voice=voice,
            is_active=value != "Ethan",
        )
    return old, profiles


def test_upgrade_updates_model_and_voices_without_rewriting_history(legacy_catalog):
    """Unsupported defaults fall back; compatible defaults and disabled profiles persist."""
    old, profiles = legacy_catalog
    old_voice_id = profiles["Cherry"].default_voice_id
    upgrade()
    current = models.AIModel.objects.get(code=migration.MODEL_CODE)
    assert current.pk != old.pk
    old.refresh_from_db()
    assert old.code == migration.OLD_MODEL_CODE
    assert not old.is_active
    assert models.AIVoice.objects.filter(pk=old_voice_id).exists()
    assert not models.AIVoice.objects.filter(model=old, is_active=True).exists()
    for value, expected in (("Cherry", "Tina"), ("Ethan", "Tina"), ("Ryan", "Ryan")):
        profile = profiles[value]
        profile.refresh_from_db()
        assert profile.omni_model_id == current.pk
        assert profile.default_voice.model_id == current.pk
        assert profile.default_voice.value == expected
    assert not profiles["Ethan"].is_active
    assert current.voices.filter(is_active=True).count() == len(migration.VOICES)
    assert not current.voices.filter(value__in=("Cherry", "Ethan")).exists()


def test_cached_legacy_voice_id_resolves_to_upgraded_dispatch(legacy_catalog):
    """An old client selection must not send Cherry to the new model."""
    _, profiles = legacy_catalog
    selected = profiles["Cherry"]
    cached_voice_id = str(selected.default_voice_id)
    upgrade()
    profile, voice, prompt = resolve_profile_context(selected.code, cached_voice_id)
    payload = build_agent_metadata(profile, voice, prompt, "test-requester")
    assert payload["models"]["omni"]["code"] == migration.MODEL_CODE
    assert payload["voice"] == "Tina"


def test_repeat_upgrade_preserves_existing_new_catalog_customization(legacy_catalog):
    """Rerunning the operation neither duplicates rows nor resets admin choices."""
    upgrade()
    model = models.AIModel.objects.get(code=migration.MODEL_CODE)
    model.display_name = "Custom Qwen name"
    model.save(update_fields=["display_name"])
    cindy = model.voices.get(value="Cindy")
    cindy.is_active = False
    cindy.save(update_fields=["is_active"])
    counts = (models.AIModel.objects.count(), models.AIVoice.objects.count())
    upgrade()
    model.refresh_from_db()
    cindy.refresh_from_db()
    assert model.display_name == "Custom Qwen name"
    assert not cindy.is_active
    assert counts == (models.AIModel.objects.count(), models.AIVoice.objects.count())


def test_unrelated_profile_and_voice_remain_unchanged(legacy_catalog):
    """The upgrade touches profiles selecting the exact legacy Qwen model only."""
    old, _ = legacy_catalog
    other = models.AIModel.objects.create(
        vendor=old.vendor,
        capability="omni",
        code="aliyun/custom-omni",
        display_name="Custom model",
    )
    voice = models.AIVoice.objects.create(model=other, value="custom", label="Custom")
    profile = models.AIAgentProfile.objects.create(
        code="migration-other",
        display_name="Other assistant",
        architecture="omni",
        omni_model=other,
        default_voice=voice,
    )
    upgrade()
    profile.refresh_from_db()
    voice.refresh_from_db()
    assert profile.omni_model_id == other.pk
    assert profile.default_voice_id == voice.pk
    assert voice.is_active
