"""Write activity counters off the request thread (P10 M2).

The middleware decides *whether* to record; this does the writing. Split so the
middleware never touches the database — see ``core/services/activity.py``.
"""

import logging

from core.services import activity
from core.tasks._task import task

logger = logging.getLogger(__name__)


@task
def record_activity(user_id: str, organization_id, module: str):
    activity.record_activity(user_id, organization_id, module)
