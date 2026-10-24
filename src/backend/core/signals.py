"""Domain events emitted by core lifecycle services.

This module must stay dependency-free: ``work`` subscribes to these signals in
``AppConfig.ready``, but core never imports ``work``. A signal only describes
what happened; subscribers decide what it means for them.

``membership_left`` is sent inside the offboarding transaction, so a subscriber
failure rolls the departure back instead of leaving access granted.
"""

from django.dispatch import Signal

#: kwargs: ``membership``, ``actor`` (``None`` for a system-initiated event),
#: ``reason``, ``left_at``, ``initiated_by`` (``"console"`` / ``"webhook"``).
membership_left = Signal()
