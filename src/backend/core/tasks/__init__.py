"""Celery tasks for the core app.

Celery's ``app.autodiscover_tasks()`` finds tasks via ``<app>.tasks``;
when ``tasks`` is a package (this directory), the sub-modules are NOT
auto-imported. Importing them here ensures the ``@task``-decorated
functions get registered when the worker boots — without this, the
``[tasks]`` list in the celery worker log is empty and ``.apply_async()``
silently drops jobs.
"""

# noqa: F401 — these imports register tasks as a side effect.
from core.tasks import file as _file  # noqa: F401
from core.tasks import summary as _summary  # noqa: F401
from core.tasks import embeddings as _embeddings  # noqa: F401
