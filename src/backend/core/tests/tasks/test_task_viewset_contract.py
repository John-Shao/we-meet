"""Framework-level contracts for the task viewset."""

from rest_framework.settings import api_settings

from core.api.tasks import TaskViewSet


def test_task_actions_do_not_shadow_drf_settings():
    """DRF needs this class attribute whenever any task action raises."""

    assert TaskViewSet.settings is api_settings
