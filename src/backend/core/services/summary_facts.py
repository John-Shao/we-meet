"""Conservative normalization of model-generated owner placeholders."""

import re
import unicodedata

PLACEHOLDERS = frozenset(
    {
        "unknown",
        "unknown speaker",
        "unidentified speaker",
        "unnamed speaker",
        "tbd",
        "unassigned",
        "not specified",
        "未知",
        "未知说话人",
        "未知发言人",
        "未指定",
        "未分配",
        "待定",
    }
)
SPEAKER_LABEL = re.compile(r"(?:speaker|说话人|发言人)\s*\d*", re.IGNORECASE)


def normalized(value):
    """Normalize comparison only; preserve the source spelling of real owners."""
    return " ".join(unicodedata.normalize("NFKC", value).split()).casefold()


def normalize_owner(value, cited_sources):
    """Blank known placeholders without guessing the identity of a quoted 'I'."""
    key = normalized(value)
    label = re.sub(r"\s*\((?:i|我|本人)\)$", "", key)
    placeholder = label in PLACEHOLDERS or SPEAKER_LABEL.fullmatch(label) is not None
    if not placeholder:
        return value
    # A real attributed display name may resemble a label. Only references for
    # this action can establish it; unrelated speakers cannot assign its owner.
    if any(
        row.get("speaker_identity")
        and normalized(row.get("speaker_name") or "") in {key, label}
        for row in cited_sources
    ):
        return value
    return ""
