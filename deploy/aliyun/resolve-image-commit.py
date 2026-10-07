"""Resolve backend CI provenance from a tag or a committed image receipt."""

import argparse
import json
import re
import subprocess


def from_receipts(image, receipts):
    commits = set()
    for receipt in receipts:
        if not isinstance(receipt, dict):
            continue
        references = {
            row.get("image")
            for row in receipt.get("verification", {}).get("controllers", [])
        }
        candidate = receipt.get("release_candidate", {})
        if image in references:
            commit = receipt.get("source_commit", "")
        elif image == candidate.get("immutable_image") and candidate.get(
            "registry_digest_verified"
        ):
            commit = candidate.get("source_commit", "")
        else:
            continue
        if not re.fullmatch(r"[a-f0-9]{40}", commit):
            raise ValueError("invalid_committed_image_provenance")
        commits.add(commit)
    if len(commits) != 1:
        raise ValueError("missing_or_conflicting_committed_image_provenance")
    return commits.pop()


def git(*args):
    return (
        subprocess.run(["git", *args], capture_output=True, check=True)
        .stdout.decode()
        .strip()
    )


def resolve(image):
    if "@" not in image:
        tag = image.rsplit("/", 1)[-1].rsplit(":", 1)
        if len(tag) == 2 and re.fullmatch(r"[a-fA-F0-9]{7,40}", tag[1]):
            return git("rev-parse", "--verify", tag[1] + "^{commit}")
    files = git("ls-files", "docs/reviews/*.json").splitlines()
    # Read committed contents, never trust an untracked/local edited receipt.
    receipts = [json.loads(git("show", "HEAD:" + path)) for path in files]
    commit = from_receipts(image, receipts)
    return git("rev-parse", "--verify", commit + "^{commit}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    try:
        print(resolve(args.image))
    except (ValueError, subprocess.CalledProcessError):
        parser.exit(
            1,
            "Cannot establish backend image commit; add a reviewed committed image receipt.\n",
        )


if __name__ == "__main__":
    main()
