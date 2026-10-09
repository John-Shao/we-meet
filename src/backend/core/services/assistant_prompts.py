"""Resolve active server-managed instructions; never silently restore a disabled prompt."""

from rest_framework.exceptions import APIException

from core.models import AIPrompt


class PromptUnavailable(APIException):
    status_code = 503
    default_detail = "Assistant instructions are unavailable."


def instruction(code):
    prompt = AIPrompt.objects.filter(code=code, scope="system", is_active=True).first()
    if prompt is None or not prompt.content.strip():
        raise PromptUnavailable()
    return prompt.content


def language_detection(source, target):
    return (
        instruction("translation.language_detection")
        .replace("{source_language}", source)
        .replace("{target_language}", target)
    )
