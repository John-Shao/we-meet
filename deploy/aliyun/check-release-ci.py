#!/usr/bin/env python3
"""Require successful release-guard jobs for the exact image and chart commits."""

import argparse
import json
import re
import subprocess
import sys

REQUIRED_JOBS = {"backend-boundaries", "frontend-artifact", "deployment-boundaries"}


class CheckFailed(Exception):
    """A release cannot establish the required CI evidence."""


def repository(origin):
    match = re.fullmatch(
        r"(?:https://github\.com/|git@github\.com:)([\w.-]+/[\w.-]+?)(?:\.git)?/?",
        origin.strip(),
    )
    if not match:
        raise CheckFailed("origin must identify the GitHub repository being released")
    return match[1]


def api(path):
    try:
        result = subprocess.run(
            ["gh", "api", "--hostname", "github.com", path],
            capture_output=True, text=True, encoding="utf-8", timeout=30, check=False,
        )
        if result.returncode:
            raise CheckFailed("GitHub CI lookup failed; authenticate gh and retry")
        return json.loads(result.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError) as exc:
        raise CheckFailed("GitHub CI evidence unavailable or malformed") from exc


def verify(repo, commit):
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise CheckFailed("CI verification requires a full commit SHA")
    response = api(f"repos/{repo}/actions/workflows/release-guard.yml/runs?head_sha={commit}&per_page=100")
    candidates = [
        run for run in response.get("workflow_runs", [])
        if run.get("head_sha") == commit
        and run.get("event") in {"push", "workflow_dispatch"}
        and run.get("head_repository", {}).get("full_name") == repo
    ]
    if not candidates:
        raise CheckFailed(f"no release-guard run for {commit}; run that workflow on this commit first")
    # An earlier green run must never hide the latest failure or rerun in progress.
    run = max(candidates, key=lambda item: int(item["id"]))
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        raise CheckFailed(f"latest release-guard run for {commit} is not successful")
    run_id, attempt = int(run["id"]), int(run["run_attempt"])
    jobs = api(f"repos/{repo}/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100")
    successful = {
        job.get("name") for job in jobs.get("jobs", [])
        if job.get("status") == "completed" and job.get("conclusion") == "success"
        # The attempt-specific endpoint is authoritative. GitHub's documented
        # job response need not include run_attempt; validate it when present.
        and job.get("head_sha") == commit and job.get("run_id") == run_id
        and job.get("run_attempt", attempt) == attempt
    }
    missing = REQUIRED_JOBS - successful
    if missing:
        raise CheckFailed(f"required jobs missing, skipped or unsuccessful: {', '.join(sorted(missing))}")
    return f"https://github.com/{repo}/actions/runs/{run_id}/attempts/{attempt}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", action="append", required=True)
    args = parser.parse_args()
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"], capture_output=True,
            text=True, encoding="utf-8", timeout=10, check=True,
        )
        repo = repository(result.stdout)
        for commit in dict.fromkeys(args.commit):
            url = verify(repo, commit)
            print(f"CI verified {commit}: {url}")
    except (CheckFailed, OSError, subprocess.SubprocessError, KeyError, TypeError, ValueError, AttributeError) as exc:
        # Never print subprocess stdout/stderr; they can contain authentication data.
        message = str(exc) if isinstance(exc, CheckFailed) else "CI verification failed"
        print(f"ERROR: {message}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
