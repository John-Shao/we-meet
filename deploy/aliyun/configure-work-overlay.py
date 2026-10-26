"""Persist only generic Work switches; never print credentials."""

import argparse
import copy
import json
import os
from pathlib import Path

import yaml


def configure(data, mode):
    data = copy.deepcopy(data or {})
    data.setdefault("workWorker", {})["enabled"] = True
    data.setdefault("celeryBeat", {})["enabled"] = True
    env = data.setdefault("backend", {}).setdefault("envVars", {})
    env["WORK_ENABLED"] = "True" if mode == "on" else "False"
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    parser.add_argument("mode", choices=("on", "off"))
    args = parser.parse_args()
    try:
        original = (
            yaml.safe_load(args.path.read_text(encoding="utf8"))
            if args.path.exists()
            else {}
        )
        data = configure(original, args.mode)
    except (ValueError, TypeError, AttributeError, KeyError, yaml.YAMLError):
        parser.exit(1, "Work overlay is invalid.\n")
    args.path.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.path.with_name(args.path.name + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf8") as stream:
            json.dump(data, stream, indent=2, ensure_ascii=True)
            stream.write("\n")
        os.replace(temporary, args.path)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
