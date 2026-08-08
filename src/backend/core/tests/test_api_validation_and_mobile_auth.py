"""Regression tests for strict API booleans and OTP state serialization."""

import threading
import time

from django.core.cache import cache
from django.test import override_settings

import pytest
from rest_framework.exceptions import ValidationError

from core.api.mobile_auth import _OTP_CACHE_PREFIX, _validate_otp
from core.api.validation import parse_boolean


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(True, True), (False, False), ("true", True), ("false", False), ("1", True), ("0", False)],
)
def test_parse_boolean_accepts_drf_boolean_values(raw, expected):
    assert parse_boolean(raw) is expected


@pytest.mark.parametrize("raw", [[], {}, "yes please", 2, None])
def test_parse_boolean_rejects_ambiguous_values(raw):
    with pytest.raises(ValidationError):
        parse_boolean(raw)


@override_settings(
    CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
)
def test_parallel_wrong_otp_attempts_cannot_overwrite_each_other(
    settings, monkeypatch
):
    phone = "13800000000"
    settings.MOBILE_AUTH_OTP_MAX_ATTEMPTS = 5
    settings.MOBILE_AUTH_OTP_EXPIRY = 600
    cache_key = f"{_OTP_CACHE_PREFIX}{phone}"
    cache.set(cache_key, {"otp": "654321", "attempts": 0}, timeout=600)

    original_get = cache.get

    def slow_get(key, *args, **kwargs):
        value = original_get(key, *args, **kwargs)
        if key == cache_key:
            time.sleep(0.01)
        return value

    monkeypatch.setattr(cache, "get", slow_get)
    barrier = threading.Barrier(10)
    results = []

    def guess():
        barrier.wait()
        results.append(_validate_otp(phone, "000000"))

    threads = [threading.Thread(target=guess) for _ in range(10)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=2)

    assert sum(reason == "wrong" for _, reason, _ in results) == 4
    assert sum(reason == "locked" for _, reason, _ in results) == 1
    assert cache.get(cache_key) is None
