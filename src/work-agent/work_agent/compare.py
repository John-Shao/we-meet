"""Sequential PoC: separate HTTP endpoints, ledgers and images for each engine."""

import argparse
import json
import secrets
from pathlib import Path

from .config import Config, load_env
from .evaluate import CASES, AgentClient, evaluate
from .server import Gateway


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--engine", choices=["dsh", "pi", "both"], default="both")
    parser.add_argument("--case", choices=[case["id"] for case in CASES])
    parser.add_argument("--allow-paid", action="store_true")
    args = parser.parse_args()
    if not args.allow_paid:
        parser.error("requires --allow-paid")
    load_env(args.env_file)
    token = secrets.token_urlsafe(32)
    engines = ["dsh", "pi"] if args.engine == "both" else [args.engine]
    for engine in engines:
        root = args.output_dir.resolve() / engine
        gateway = Gateway(
            Config(engine, root, token, image=f"we-meet-work-agent:{engine}-poc")
        )
        gateway.start()
        try:
            client = AgentClient(gateway.url, token)
            records = []
            for case in CASES:
                if args.case is not None and args.case != case["id"]:
                    continue
                record = evaluate(client, case)
                records.append(record)
                (root / "evaluation.json").write_text(
                    json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                print(
                    json.dumps(
                        {
                            "engine": engine,
                            "case": case["id"],
                            "state": record["job"]["state"],
                            "error_code": record["job"]["error_code"],
                            "checks": record["checks"],
                        }
                    ),
                    flush=True,
                )
        finally:
            gateway.close()


if __name__ == "__main__":
    main()
