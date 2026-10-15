"""Reconciliation complements, and never replaces, the native lease deadline."""

from core.services.remote_control import expire_sessions, prune_history
from core.tasks._task import task


@task
def expire_remote_control_sessions():
    expire_sessions()


@task
def prune_remote_control_history():
    prune_history()
