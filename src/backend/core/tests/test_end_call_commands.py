from io import StringIO

from django.core.management import call_command
from django.core.management.base import CommandError

import pytest

from core.management.commands.extend_end_call_commands import EXTENSIONS
from core.models import AIPrompt

pytestmark = pytest.mark.django_db


def test_extension_preserves_admin_content_and_metadata_and_is_idempotent():
    prompt = AIPrompt.objects.get(code="call.tool.end_call")
    prompt.content = "Administrator's custom end-call rules"
    prompt.is_active = False
    prompt.save()
    untouched = dict(
        AIPrompt.objects.exclude(code__in=EXTENSIONS).values_list("code", "content")
    )
    output = StringIO()
    call_command("extend_end_call_commands", stdout=output)
    assert "updated=2" in output.getvalue()
    prompt.refresh_from_db()
    assert (
        prompt.content
        == "Administrator's custom end-call rules\n" + EXTENSIONS[prompt.code]
    )
    assert not prompt.is_active
    assert prompt.scope == "system"
    output = StringIO()
    call_command("extend_end_call_commands", stdout=output)
    assert "updated=0" in output.getvalue()
    assert (
        dict(
            AIPrompt.objects.exclude(code__in=EXTENSIONS).values_list("code", "content")
        )
        == untouched
    )


@pytest.mark.parametrize("invalid", ["missing", "empty", "wrong_scope"])
def test_invalid_catalog_does_not_partially_change_other_prompts(invalid):
    code = "call.tool.description.end_call"
    if invalid == "missing":
        AIPrompt.objects.filter(code=code).delete()
    else:
        AIPrompt.objects.filter(code=code).update(
            **({"content": " "} if invalid == "empty" else {"scope": "call"})
        )
    before = dict(AIPrompt.objects.values_list("code", "content"))
    with pytest.raises(CommandError):
        call_command("extend_end_call_commands")
    assert dict(AIPrompt.objects.values_list("code", "content")) == before
