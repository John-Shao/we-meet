"""Bounded enrollment challenge checks, without giving an ASR the answer."""

import hashlib
import json
import re
import unicodedata
from difflib import SequenceMatcher
from functools import lru_cache

LOCALES = {"en", "zh-CN", "fr", "de", "nl"}


def plain(text):
    text = unicodedata.normalize("NFKD", text).casefold()
    return "".join(char for char in text if char.isalnum())


def challenge_digest(locale, prompt):
    return hashlib.sha256(
        json.dumps([locale, prompt], ensure_ascii=True, separators=(",", ":")).encode()
    ).hexdigest()


@lru_cache(maxsize=5)
def number_names(locale):  # noqa: PLR0912 -- Each supported enrollment locale has explicit cardinal spellings.
    names = {}
    if locale == "en":
        units = "one two three four five six seven eight nine".split()
        teens = "ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
        tens = "twenty thirty forty fifty sixty seventy eighty ninety".split()
        names.update({name: i + 10 for i, name in enumerate(teens)})
        for i, name in enumerate(tens, 2):
            names[name] = i * 10
            names.update(
                {f"{name} {unit}": i * 10 + j for j, unit in enumerate(units, 1)}
            )
    elif locale in {"de", "nl"}:
        if locale == "de":
            units = "ein zwei drei vier fünf sechs sieben acht neun".split()
            teens = "zehn elf zwölf dreizehn vierzehn fünfzehn sechzehn siebzehn achtzehn neunzehn".split()
            tens = "zwanzig dreißig vierzig fünfzig sechzig siebzig achtzig neunzig".split()
            join = "und"
        else:
            units = "een twee drie vier vijf zes zeven acht negen".split()
            teens = "tien elf twaalf dertien veertien vijftien zestien zeventien achttien negentien".split()
            tens = "twintig dertig veertig vijftig zestig zeventig tachtig negentig".split()
            join = "en"
        names.update({name: i + 10 for i, name in enumerate(teens)})
        for i, name in enumerate(tens, 2):
            names[name] = i * 10
            for j, unit in enumerate(units, 1):
                names[f"{unit}{join}{name}"] = i * 10 + j
                names[f"{unit} {join} {name}"] = i * 10 + j
    elif locale == "fr":
        units = "un deux trois quatre cinq six sept huit neuf".split()
        teens = [
            "dix",
            "onze",
            "douze",
            "treize",
            "quatorze",
            "quinze",
            "seize",
            "dix sept",
            "dix huit",
            "dix neuf",
        ]
        names.update({name: i + 10 for i, name in enumerate(teens)})
        for i, name in enumerate("vingt trente quarante cinquante soixante".split(), 2):
            names[name] = i * 10
            for j, unit in enumerate(units, 1):
                names[f"{name} {'et ' if j == 1 else ''}{unit}"] = i * 10 + j
        for i, name in enumerate(teens, 10):
            names[f"soixante {'et ' if i == 11 else ''}{name}"] = 60 + i
            names[f"quatre vingt {name}"] = 80 + i
        names["quatre vingts"] = names["quatre vingt"] = 80
        for j, unit in enumerate(units, 1):
            names[f"quatre vingt {unit}"] = 80 + j
    elif locale == "zh-CN":
        units = "一二三四五六七八九"
        for value in range(10, 100):
            name = (units[value // 10 - 1] if value >= 20 else "") + "十"
            if value % 10:
                name += units[value % 10 - 1]
            names[name] = value
    return names


def readable(text):
    text = unicodedata.normalize("NFKD", text).casefold()
    return " ".join(
        "".join(
            char if char.isalnum() else " "
            for char in text
            if not unicodedata.combining(char)
        ).split()
    )


def numeric_text(text, locale):
    text = readable(text)
    if locale == "zh-CN":
        # Providers may emit one timed word per character with leading spaces.
        text = re.sub(r"(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])", "", text)
    names = {readable(key): value for key, value in number_names(locale).items()}
    pattern = "|".join(re.escape(key) for key in sorted(names, key=len, reverse=True))
    if locale != "zh-CN":
        pattern = rf"(?<!\w)(?:{pattern})(?!\w)"
    return re.sub(pattern, lambda match: str(names[match[0]]), text)


def prompt_matches(text, *, locale, prompt):
    if (
        not isinstance(locale, str)
        or locale not in LOCALES
        or not isinstance(text, str)
        or not isinstance(prompt, str)
        or not 1 <= len(text) <= 4096
        or not 1 <= len(prompt) <= 1024
    ):
        return False
    groups = re.findall(r"[0-9]+", prompt)
    if len(groups) != 6 or any(
        len(group) != 2 or not 10 <= int(group) <= 99 for group in groups
    ):
        return False
    observed = numeric_text(text, locale)
    digits = "".join(re.findall(r"[0-9]+", observed))
    # Exact challenge digits first; approximate fixed wording only accommodates
    # ordinary punctuation, orthography and small ASR wording differences.
    return (
        digits == "".join(groups)
        and SequenceMatcher(
            None, plain(prompt), plain(observed), autojunk=False
        ).ratio()
        >= 0.70
    )
