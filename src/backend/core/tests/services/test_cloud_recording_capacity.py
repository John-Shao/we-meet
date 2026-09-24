"""A demo recording slot is fenced across rooms, without blocking stop/replay."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

from django.db import close_old_connections

import pytest

from core import models
from core.services.cloud_recording_worker import process
from core.tests.services.test_cloud_recording import command_body, meeting, post
from core.tests.services.test_cloud_recording_worker import environment

pytestmark = pytest.mark.django_db


def test_second_room_is_busy_but_original_replay_and_stop_work(settings, environment):
    settings.MEETING_CLOUD_RECORDING_MAX_CONCURRENT = 1
    user, session = meeting()
    second_user, second_session = meeting()
    body = command_body(session)
    started = post(user, body)
    assert started.status_code == 202
    assert post(user, body).status_code == 200
    rejected = post(second_user, command_body(second_session))
    assert rejected.status_code == 409
    assert rejected.json()["code"] == "recording_capacity_reached"
    assert not models.Recording.objects.filter(session=second_session).exists()
    command = models.CloudRecordingCommand.objects.get(
        pk=started.json()["command"]["id"]
    )
    process(command.pk)
    stopped = post(
        user, command_body(session, operation="stop", expected=command.recording_id)
    )
    assert stopped.status_code == 202


@pytest.mark.django_db(transaction=True)
def test_concurrent_rooms_cannot_both_reserve_the_single_slot(settings, environment):
    settings.MEETING_CLOUD_RECORDING_MAX_CONCURRENT = 1
    first, second = meeting(), meeting()
    barrier = Barrier(2)

    def reserve(pair):
        close_old_connections()
        try:
            barrier.wait(timeout=10)
            return post(pair[0], command_body(pair[1])).status_code
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(reserve, [first, second]))
    assert sorted(statuses) == [202, 409]
    assert models.Recording.objects.filter(status="initiated").count() == 1
