#!/usr/bin/env python3
"""Send Work health transition emails through the backup SMTP channel."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import sys
import time
from email.utils import make_msgid

sys.path.insert(0, "/opt/meet-db-backup")
import notify

CONFIG = Path(os.environ.get("WORK_HEALTH_NOTIFY_CONFIG", "/etc/meet-db-backup/work/notification.json"))
STATE = Path(os.environ.get("WORK_HEALTH_STATE", "/var/lib/work/health-alert-state.json"))
REMIND_SECONDS = 6 * 3600


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("status", choices=["ok", "degraded"])
    parser.add_argument("issues", nargs="?", default="")
    args = parser.parse_args()
    os.umask(0o077)
    now = time.time()
    state = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
    previous = state.get("status")
    issues = args.issues.replace("\n", " ")[:500]

    if args.status == "ok" and previous != "degraded":
        return 0
    if args.status == "degraded" and previous == "degraded":
        if now - float(state.get("last_sent", 0)) < REMIND_SECONDS:
            return 0

    config = notify.load_config(CONFIG)
    host = config.get("hostname", "we-meet")
    if args.status == "degraded":
        subject = f"【we-meet 告警】{host}：Work 健康检查异常"
        body = (f"主机：{host}\n检查时间：{dt.datetime.now(dt.timezone.utc).isoformat()}\n"
                f"异常项：{issues or 'unknown'}\n\n"
                "这是 Work 控制面健康检查的自动告警；持续异常每 6 小时提醒一次，恢复后发恢复邮件。\n")
    else:
        subject = f"【we-meet 恢复】{host}：Work 健康检查恢复"
        body = (f"主机：{host}\n恢复时间：{dt.datetime.now(dt.timezone.utc).isoformat()}\n"
                "Work 控制面健康检查已恢复。\n")

    for recipient in config["recipients"]:
        notify.send_mail(config, recipient, subject, body,
                         make_msgid(domain=config["from_address"].split("@", 1)[1]))
    notify.write_json(STATE, {
        "status": args.status,
        "issues": issues,
        "last_sent": now,
        "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    })
    print("HEALTH_ALERT_SENT", args.status)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
