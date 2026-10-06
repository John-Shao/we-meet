#!/usr/bin/env python3
"""Independent, durable SMTP notifications for backup systemd units.

The mail queue is separate from backup success state. No app/Redis/Celery needed.
SMTP acceptance is recorded per recipient; it is not proof of inbox delivery.
"""
import argparse
from contextlib import contextmanager
import datetime as dt
from email.message import EmailMessage
from email.utils import formatdate, make_msgid, parseaddr
import json
import os
from pathlib import Path
import smtplib
import ssl
import subprocess
import sys
import time
import uuid

UNITS = {"meet-backup.service": "run", "meet-backup-check.service": "check"}
LABELS = {"run": "备份任务失败", "check": "机外备份检查异常"}
RETRY_DELAYS = [60, 300, 900, 3600]
MAX_ATTEMPTS = 5
REMINDER_SECONDS = 6 * 3600


def write_json(path, value):
    path = Path(path)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(temp, 0o600)
    os.replace(temp, path)


@contextmanager
def locked_state(directory):
    import fcntl

    directory = Path(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (directory / "notifications.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield directory / "notifications.json"


def load_config(path):
    config = json.loads(Path(path).read_text(encoding="utf-8"))
    smtp = config["smtp"]
    if smtp.get("security") not in {"ssl", "starttls"}:
        raise ValueError("Encrypted SMTP is required")
    if not smtp.get("host") or not smtp.get("username") or not smtp.get("password"):
        raise ValueError("SMTP credentials are missing")
    if not config.get("recipients") or not isinstance(config["recipients"], list):
        raise ValueError("Explicit recipients are required")
    for address in [config["from_address"], *config["recipients"]]:
        if not isinstance(address, str) or "\r" in address or "\n" in address:
            raise ValueError("Invalid mail address")
        parsed = parseaddr(address)[1]
        if parsed != address or parsed.count("@") != 1 or any(c.isspace() for c in parsed):
            raise ValueError("Invalid mail address")
    config["recipients"] = list(dict.fromkeys(config["recipients"]))
    return config


def send_mail(config, recipient, subject, body, message_id):
    smtp = config["smtp"]
    message = EmailMessage()
    message["From"] = config["from_address"]
    message["To"] = recipient
    message["Subject"] = subject
    message["Date"] = formatdate(localtime=False)
    message["Message-ID"] = message_id
    message.set_content(body)
    context = ssl.create_default_context()
    if smtp["security"] == "ssl":
        client = smtplib.SMTP_SSL(smtp["host"], int(smtp["port"]), timeout=15, context=context)
    else:
        client = smtplib.SMTP(smtp["host"], int(smtp["port"]), timeout=15)
    try:
        if smtp["security"] == "starttls":
            client.ehlo()
            client.starttls(context=context)
            client.ehlo()
        client.login(smtp["username"], smtp["password"])
        refused = client.send_message(message, from_addr=config["from_address"], to_addrs=[recipient])
        if refused:
            raise smtplib.SMTPRecipientsRefused(refused)
        # DATA accepted: a later QUIT failure must not enqueue a duplicate.
    finally:
        client.close()


def stamp(epoch):
    return dt.datetime.fromtimestamp(epoch, dt.timezone(dt.timedelta(hours=8))).isoformat(timespec="seconds")


class Notifications:
    def __init__(self, path, config, sender=send_mail, now=time.time):
        self.path, self.config, self.sender, self.now = Path(path), config, sender, now
        self.state = json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else {"incidents": {}, "pending": []}

    def save(self):
        write_json(self.path, self.state)

    def enqueue(self, category, incident, kind, recipients):
        when = self.now()
        for recipient in recipients:
            self.state["pending"].append({
                "category": category, "generation": incident["generation"], "kind": kind,
                "recipient": recipient, "attempts": 0, "next_at": when,
                "message_id": make_msgid(domain=self.config["from_address"].split("@", 1)[1]),
            })
        incident["last_queued_at"] = when

    def observe(self, category, failed, event_id, reason):
        previous = self.state["incidents"].get(category)
        if previous and previous.get("event_id") == event_id:
            return
        if failed:
            if previous and previous["active"]:
                previous.update(event_id=event_id, reason=reason)
            else:
                # Cancel obsolete recovery notices if this category fails again.
                self.state["pending"] = [m for m in self.state["pending"] if m["category"] != category]
                incident = {"active": True, "generation": uuid.uuid4().hex,
                            "opened_at": self.now(), "event_id": event_id, "reason": reason,
                            "notified": [], "last_queued_at": self.now()}
                self.state["incidents"][category] = incident
                self.enqueue(category, incident, "failure", self.config["recipients"])
        elif previous:
            previous["event_id"] = event_id
            if previous["active"]:
                previous.update(active=False, recovered_at=self.now())
                # Never deliver an old failure after the service has recovered.
                self.state["pending"] = [m for m in self.state["pending"] if m["category"] != category]
                recipients = [r for r in previous["notified"] if r in self.config["recipients"]]
                self.enqueue(category, previous, "recovery", recipients)
        self.save()

    def reminders(self):
        for category, incident in self.state["incidents"].items():
            if incident["active"] and self.now() - incident["last_queued_at"] >= REMINDER_SECONDS:
                self.state["pending"] = [m for m in self.state["pending"] if m["category"] != category]
                self.enqueue(category, incident, "reminder", self.config["recipients"])
        self.save()

    def content(self, item, incident):
        hostname = self.config.get("hostname", "we-meet")
        recovery = item["kind"] == "recovery"
        tag = "恢复通知" if recovery else "备份告警"
        subject = f"【we-meet {tag}】{hostname}：{LABELS[item['category']]}" + ("已恢复" if recovery else "")
        body = [f"主机：{hostname}", f"检查项：{LABELS[item['category']]}",
                f"首次异常：{stamp(incident['opened_at'])}",
                f"状态：{'已恢复' if recovery else '异常持续中'}",
                f"原因：{incident['reason']}"]
        if recovery:
            body.append(f"恢复时间：{stamp(incident['recovered_at'])}")
        # Read only the timestamp from the receipt; never mail raw logs/configs.
        receipt = self.path.parent / "last-success.json"
        if receipt.exists():
            try:
                completed = json.loads(receipt.read_text(encoding="utf-8"))["completed_at"]
                body.append("最近成功备份：" + dt.datetime.fromisoformat(completed).isoformat())
            except (ValueError, KeyError, TypeError, OSError):
                pass
        body += ["请查看 systemctl status meet-backup.service meet-backup-check.service。",
                 "本通知由主机发出；整机宕机或完全断网需由独立机外监控覆盖。"]
        return subject, "\n".join(body)

    def flush(self):
        self.reminders()
        failed = False
        for item in list(self.state["pending"]):
            incident = self.state["incidents"].get(item["category"])
            if not incident or incident["generation"] != item["generation"] or item["recipient"] not in self.config["recipients"]:
                self.state["pending"].remove(item)
                self.save()
                continue
            if item["attempts"] >= MAX_ATTEMPTS:
                failed = True
                continue
            if item["next_at"] > self.now():
                continue
            subject, body = self.content(item, incident)
            try:
                self.sender(self.config, item["recipient"], subject, body, item["message_id"])
            except Exception as error:
                item["attempts"] += 1
                item["last_error_type"] = type(error).__name__
                delay = RETRY_DELAYS[min(item["attempts"] - 1, len(RETRY_DELAYS) - 1)]
                item["next_at"] = self.now() + delay
                failed = True
                # Provider errors may contain addresses or auth data: type only.
                print("NOTIFICATION_SEND_FAILED " + type(error).__name__, file=sys.stderr)
            else:
                if item["kind"] != "recovery" and item["recipient"] not in incident["notified"]:
                    incident["notified"].append(item["recipient"])
                incident["last_smtp_accepted_at"] = self.now()
                self.state["pending"].remove(item)
                print("NOTIFICATION_SMTP_ACCEPTED " + item["kind"])
            self.save()
        return not failed


def unit_event(unit, state_dir):
    result = subprocess.run(["systemctl", "show", unit, "--property=Result",
                             "--property=ExecMainStatus", "--property=ExecMainExitTimestamp",
                             "--property=StateChangeTimestamp", "--property=ActiveState"],
                            capture_output=True, text=True, check=True, timeout=10)
    props = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    if props.get("ActiveState") in {"active", "activating", "deactivating"}:
        return None
    failed = props.get("Result") != "success" or props.get("ExecMainStatus") != "0"
    # ExecStart may never launch (for example, a missing executable).
    timestamp = (props.get("StateChangeTimestamp") if failed else None) or props.get("ExecMainExitTimestamp")
    if not props.get("Result") or not timestamp:
        return None
    category = UNITS[unit]
    reason = "备份任务执行失败" if category == "run" else "备份读取、时效或完整性检查未通过"
    if props["Result"] == "timeout":
        reason = "任务执行超时"
    if category == "check" and failed and props["Result"] != "timeout":
        path = Path(state_dir) / "last-check.json"
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                age = time.time() - dt.datetime.fromisoformat(data["at"]).timestamp()
                if not 0 <= age <= 300:
                    data = {}
            except (ValueError, KeyError, TypeError, OSError):
                data = {}
            # Only fixed messages from the allowlist; no exception text in mail.
            reason = {"stale": "超过 8 小时没有成功备份", "future": "备份记录时间异常",
                      "mismatch": "备份对象与成功记录不一致"}.get(data.get("reason"), reason)
    event_id = timestamp + ":" + props["Result"] + ":" + props.get("ExecMainStatus", "")
    return category, failed, event_id, reason


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["observe", "flush", "test", "status"])
    parser.add_argument("--unit", choices=list(UNITS))
    parser.add_argument("--config", default="/etc/meet-backup/notification.json")
    parser.add_argument("--state-dir", default="/var/lib/meet-backup")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        config = load_config(args.config)
        if args.action == "test":
            for recipient in config["recipients"]:
                send_mail(config, recipient, "【测试】we-meet 备份主动通知",
                          "这是上线验证邮件，不代表生产故障。\n通知包含备份失败、备份过期及异常恢复；持续异常每 6 小时提醒一次。",
                          make_msgid(domain=config["from_address"].split("@", 1)[1]))
                print("TEST_NOTIFICATION_SMTP_ACCEPTED")
            return 0
        with locked_state(args.state_dir) as path:
            engine = Notifications(path, config)
            if args.action == "status":
                print(json.dumps({"active_incidents": [k for k, v in engine.state["incidents"].items() if v["active"]],
                                  "pending": len(engine.state["pending"]),
                                  "exhausted": sum(m["attempts"] >= MAX_ATTEMPTS for m in engine.state["pending"])}))
                return 0
            if args.action == "observe":
                if not args.unit:
                    raise ValueError("--unit is required")
                event = unit_event(args.unit, args.state_dir)
                if event:
                    engine.observe(*event)
            elif args.action == "flush":
                # Reconcile completed units in case a hook was missed or interrupted.
                for unit in UNITS:
                    event = unit_event(unit, args.state_dir)
                    if event:
                        engine.observe(*event)
            return 0 if engine.flush() else 1
    except Exception as error:
        print("NOTIFICATION_FAILED " + type(error).__name__, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
