"""One spelling for a mobile number (P10 M2-g).

The same person's number reaches us in several shapes: an administrator types
``138 0000 0001`` or ``+86 13800000001`` into the console, a CSV carries
whatever Excel left behind, and Keycloak's ``phoneNumber`` attribute holds
whatever the sign-in flow wrote. Matching an invitation to a login means all of
those have to collapse to one value first — a phone invitation that fails to
match is invisible: the person simply lands on the default membership and
nobody is told why.

Deliberately its own module rather than a helper in ``core/utils.py``: this is
imported from the authentication backend, which runs before most of the app is
warm, and ``core/utils.py`` pulls in LiveKit and S3 clients.

Mainland China only, matching what ``core/api/mobile_auth.py`` accepts. Feishu
gates overseas numbers behind enterprise verification; we have no such concept,
so the honest answer for now is to reject them at the door rather than store a
number nobody can sign in with.
"""

import re

#: 11 digits, ``1`` then 3–9. Same rule as ``mobile_auth.PHONE_REGEX``; kept
#: here as the shared source of truth because that module imports serializers
#: and cannot be reached from the auth backend without a cycle.
CN_MOBILE_RE = re.compile(r"^1[3-9]\d{9}$")

_SEPARATORS = re.compile(r"[\s\-()（）.]")


def normalize_cn_phone(value) -> str:
    """Collapse a written-down number to 11 bare digits, or ``""`` if it is not one.

    Returning ``""`` rather than raising is intentional: every caller here is
    either matching (where "no match" is the answer) or validating (where the
    caller wants to phrase its own error).
    """
    if not value:
        return ""
    digits = _SEPARATORS.sub("", str(value).strip())
    digits = digits.removeprefix("+")
    # ``8613800000001`` and ``008613800000001`` both mean the same number. Only
    # strip the country code when what remains is itself a valid mobile number,
    # so a number that merely happens to start with 86 is left alone.
    for prefix in ("0086", "86"):
        if digits.startswith(prefix) and CN_MOBILE_RE.match(digits[len(prefix) :]):
            digits = digits[len(prefix) :]
            break
    return digits if CN_MOBILE_RE.match(digits) else ""


def is_valid_cn_phone(value) -> bool:
    """True when ``value`` normalizes to a mainland-China mobile number."""
    return bool(normalize_cn_phone(value))


def phone_variants(value) -> list[str]:
    """Every spelling ``User.phone`` might already hold for this number.

    ``User.phone`` mirrors Keycloak's ``phoneNumber`` verbatim
    (``core/services/keycloak_phone.py``) and is not normalized at rest, so
    looking a person up by number means asking for the handful of forms that
    attribute is written in. Returns ``[]`` for anything that is not a mobile
    number, which callers can treat as "matches nobody".
    """
    number = normalize_cn_phone(value)
    if not number:
        return []
    return [number, f"+86{number}", f"86{number}"]
