"""Celery tasks for the core app.

Celery's ``app.autodiscover_tasks()`` finds tasks via ``<app>.tasks``;
when ``tasks`` is a package (this directory), the sub-modules are NOT
auto-imported. Importing them here ensures the ``@task``-decorated
functions get registered when the worker boots — without this, the
``[tasks]`` list in the celery worker log is empty and ``.apply_async()``
silently drops jobs.

Nothing here fails in development: with ``CELERY_ENABLED=False`` the decorator
in ``_task.py`` hands back a plain function whose ``.delay()`` runs inline, so a
module missing from this list still works — and every test still passes. The
omission only surfaces in production, as a job that stays "pending" forever.
Add the import in the same commit as the task module.
"""

from core.tasks import activity as _activity
from core.tasks import bot_callback as _bot_callback
from core.tasks import calendar_exports as _calendar_exports
from core.tasks import calendar_maintenance as _calendar_maintenance
from core.tasks import embeddings as _embeddings
from core.tasks import external_calendars as _external_calendars
from core.tasks import file as _file
from core.tasks import member_import as _member_import
from core.tasks import offboarding as _offboarding
from core.tasks import summary as _summary
