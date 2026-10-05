"""Exercise streaming lifetimes without any model or network dependency."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import Mock

import pytest

from meet.ai_admission import AIAdmission

ASK = "/api/v1.0/users/me/ai/ask-stream/"


def request(app, path=ASK):
    start = Mock()
    response = app({"PATH_INFO": path}, start)
    return response, start


def app(_environ, start_response):
    start_response("200 OK", [])
    return iter([b"first", b"second"])


def test_capacity_is_held_for_stream_lifetime_and_released_on_disconnect():
    pool = AIAdmission(app, capacity=1)
    response, _ = request(pool)
    assert next(response) == b"first"
    busy, status = request(pool)
    assert status.call_args.args[0] == "503 Service Unavailable"
    assert ("Retry-After", "5") in status.call_args.args[1]
    assert b"busy" in b"".join(busy)
    # Ordinary API and health remain usable while the AI slot is occupied.
    assert b"".join(request(app, "/api/v1.0/users/me/")[0]) == b"firstsecond"
    assert b"".join(request(pool, "/__heartbeat__")[0]) == b"firstsecond"
    response.close()
    response.close()
    assert b"".join(request(pool)[0]) == b"firstsecond"


def test_close_before_first_byte_closes_upstream_and_releases_slot():
    upstream = Mock()
    upstream.__iter__ = Mock(return_value=iter([b"first"]))
    pool = AIAdmission(lambda *_: upstream, capacity=1)
    response, _ = request(pool)
    response.close()
    upstream.close.assert_called_once()
    next_response, status = request(pool)
    assert not status.called
    next_response.close()


@pytest.mark.parametrize("when", ["application", "iteration", "close"])
def test_capacity_recovers_from_errors(when):
    def broken_stream():
        yield b"first"
        raise RuntimeError("iteration")

    def broken_app(*_args):
        if when == "application":
            raise RuntimeError("application")
        if when == "iteration":
            return broken_stream()
        response = Mock()
        response.__iter__ = Mock(return_value=iter([]))
        response.close.side_effect = RuntimeError("close")
        return response

    pool = AIAdmission(broken_app, capacity=1)
    with pytest.raises(RuntimeError, match=when):
        response, _ = request(pool)
        if when == "close":
            response.close()
        else:
            list(response)
    pool.application = app
    assert b"".join(request(pool)[0]) == b"firstsecond"


def test_threaded_requests_cannot_exceed_process_capacity():
    pool = AIAdmission(app, capacity=2)
    barrier = Barrier(8)

    def worker():
        response, status = request(pool)
        barrier.wait(timeout=5)  # Keep all accepted streams alive simultaneously.
        return response, status.call_args.args[0]

    with ThreadPoolExecutor(max_workers=8) as executor:
        responses = list(executor.map(lambda _: worker(), range(8)))
    assert sum(status == "200 OK" for _, status in responses) == 2
    assert sum(status == "503 Service Unavailable" for _, status in responses) == 6
    for response, _ in responses:
        close = getattr(response, "close", None)
        if close:
            close()
    assert b"".join(request(pool)[0]) == b"firstsecond"


@pytest.mark.parametrize("path", ["/api/v1.0/users/me/", "/admin/", ASK + "other/"])
def test_non_ai_routes_are_not_served_by_ai_pool(path):
    upstream = Mock()
    _, status = request(AIAdmission(upstream, capacity=1), path)
    assert status.call_args.args[0] == "404 Not Found"
    upstream.assert_not_called()


def test_invalid_capacity_fails_at_startup():
    with pytest.raises(ValueError):
        AIAdmission(app, capacity=0)
