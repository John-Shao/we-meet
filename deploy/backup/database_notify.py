#!/usr/bin/env python3
"""Reuse durable mail delivery with isolated state for each database service."""
import argparse
import sys

import notify


def units_for(service):
    if service not in {"docs", "im", "keycloak"}:
        raise ValueError("Unsupported database service")
    return {f"meet-db-backup@{service}.service": "run",
            f"meet-db-backup-check@{service}.service": "check"}


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("service", choices=["docs", "im", "keycloak"])
    args, rest = parser.parse_known_args()
    sys.argv = [sys.argv[0], *rest]
    return notify.main(units_for(args.service),
                       f"/etc/meet-db-backup/{args.service}/notification.json",
                       f"/var/lib/meet-db-backup/{args.service}")


if __name__ == "__main__":
    raise SystemExit(main())
