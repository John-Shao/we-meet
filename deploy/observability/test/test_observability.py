import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import yaml

ROOT = Path(__file__).resolve().parents[1]


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def bash_executable():
    if os.name != "nt":
        return "bash"
    candidates = [Path("D:/Program Files/Git/bin/bash.exe"), Path("C:/Program Files/Git/bin/bash.exe")]
    return str(next((path for path in candidates if path.exists()), candidates[0]))


class ObservabilityConfigTests(unittest.TestCase):
    def test_prometheus_targets_and_rules_are_local_and_present(self):
        config = yaml.safe_load((ROOT / "prometheus/prometheus.yml").read_text())
        self.assertEqual(config["rule_files"], ["../prometheus-rules.yaml", "../demo-rules.yaml"])
        targets = [target for job in config["scrape_configs"] for group in job["static_configs"] for target in group["targets"]]
        self.assertEqual(targets, ["127.0.0.1:19091", "127.0.0.1:19092", "127.0.0.1:19090"])
        self.assertEqual(config["alerting"]["alertmanagers"][0]["static_configs"][0]["targets"], ["127.0.0.1:19093"])
        for name in config["rule_files"]:
            self.assertTrue((ROOT / "prometheus" / name).resolve().is_file(), name)

    def test_alertmanager_only_routes_to_the_local_demo_webhook(self):
        config = yaml.safe_load((ROOT / "alertmanager/alertmanager.yml").read_text())
        self.assertEqual(config["route"]["receiver"], "demo-discard")
        self.assertEqual(config["route"]["routes"][0]["matchers"], [
            'alertname="WorkObservabilityDemoFailure"', 'alert_class="demo"', 'org_id="demo"',
        ])
        self.assertEqual(config["route"]["routes"][0]["receiver"], "demo-webhook")
        self.assertFalse(config["route"]["routes"][0]["continue"])
        receiver = next(item for item in config["receivers"] if item["name"] == "demo-webhook")
        self.assertEqual(receiver["webhook_configs"][0]["url"], "http://127.0.0.1:19094/alerts")
        self.assertNotIn("email_configs", receiver)
        self.assertNotIn("slack_configs", receiver)
        self.assertIn({"name": "demo-discard"}, config["receivers"])
        demo_rule = yaml.safe_load((ROOT / "demo-rules.yaml").read_text())["groups"][0]["rules"][0]
        self.assertEqual(demo_rule["alert"], "WorkObservabilityDemoFailure")
        self.assertEqual(demo_rule["labels"]["alert_class"], "demo")
        self.assertEqual(demo_rule["labels"]["org_id"], "demo")
        webhook = load_module("demo_webhook_contract", "demo-webhook.py")
        self.assertEqual(demo_rule["annotations"], webhook.ALLOWED_ANNOTATIONS)

    def test_grafana_provisioning_and_dashboard_use_the_prometheus_uid(self):
        datasource = yaml.safe_load((ROOT / "grafana/provisioning/datasources/work.yaml").read_text())
        prometheus = next(item for item in datasource["datasources"] if item["type"] == "prometheus")
        self.assertEqual(prometheus["uid"], "work-prometheus")
        self.assertEqual(prometheus["url"], "http://127.0.0.1:19090")
        provider = yaml.safe_load((ROOT / "grafana/provisioning/dashboards/work.yaml").read_text())
        self.assertEqual(provider["providers"][0]["options"]["path"], "/etc/work-observability/grafana/dashboards")
        dashboard = json.loads((ROOT / "grafana-dashboards/work-overview.json").read_text())
        self.assertEqual(dashboard["uid"], "work-r0a-overview")
        for panel in dashboard["panels"]:
            self.assertEqual(panel["datasource"]["uid"], "work-prometheus")
            for target in panel["targets"]:
                self.assertEqual(target["datasource"]["uid"], "work-prometheus")

    def test_units_are_hardened_and_loopback_only(self):
        units = list((ROOT / "systemd").glob("*.service"))
        self.assertEqual(len(units), 5)
        for path in units:
            text = path.read_text()
            self.assertIn("User=work-observability", text)
            self.assertIn("NoNewPrivileges=true", text)
            self.assertIn("ProtectSystem=strict", text)
            self.assertIn("ProtectHome=true", text)
            self.assertNotIn("0.0.0.0", text)
        prometheus = (ROOT / "systemd/work-observability-prometheus.service").read_text()
        self.assertIn("--web.listen-address=127.0.0.1:19090", prometheus)
        alertmanager = (ROOT / "systemd/work-observability-alertmanager.service").read_text()
        self.assertIn("--web.listen-address=127.0.0.1:19093", alertmanager)
        grafana = (ROOT / "systemd/work-observability-grafana.service").read_text()
        self.assertIn("http_port = 13000", (ROOT / "grafana/grafana.ini").read_text())
        self.assertIn("http_addr = 127.0.0.1", (ROOT / "grafana/grafana.ini").read_text())
        self.assertIn("ExecStart=", grafana)

    def test_release_packager_carries_the_whole_observability_tree(self):
        script = (ROOT / "make-release.sh").read_text()
        self.assertIn('cp -a "$SOURCE/." "$OUT/"', script)
        self.assertIn('sha256sum -c "$archive.sha256"', script)
        self.assertIn('gh release download', script)
        self.assertIn('OBSERVABILITY_ASSET_CACHE', script)
        self.assertIn('OBSERVABILITY_BIN_CACHE', script)
        self.assertIn('stage_archive_binary', script)
        self.assertIn('--speed-time 60', script)
        self.assertIn('find . -type f ! -name SHA256SUMS', script)
        self.assertNotIn('GO_CONTAINER', script)
        self.assertNotIn('docker exec', script)
        self.assertIn('source tree changed while building the observability release', script)
        for name in (
            "prometheus/prometheus.yml", "alertmanager/alertmanager.yml", "grafana/grafana.ini",
            "grafana/provisioning/datasources/work.yaml", "grafana/provisioning/dashboards/work.yaml",
            "grafana-dashboards/work-overview.json", "demo-metrics.py", "demo-webhook.py",
            "install.sh", "verify.sh", "exercise-demo.sh", "rollback.sh", "versions.env",
            "third-party-licenses/prometheus-LICENSE", "third-party-licenses/prometheus-NOTICE",
            "third-party-licenses/alertmanager-LICENSE", "third-party-licenses/alertmanager-NOTICE",
            "third-party-licenses/grafana-LICENSE",
        ):
            self.assertTrue((ROOT / name).is_file(), name)

    def test_install_failure_restores_api_and_removes_partial_stack(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "host"
            root_posix = root.as_posix()
            release = Path(temp) / "release"
            shutil.copytree(ROOT, release)
            shutil.copyfile(ROOT / "demo-rules.yaml", release / "prometheus/demo-rules.yaml")
            (release / "grafana/dashboards").mkdir()
            shutil.copyfile(ROOT / "grafana-dashboards/work-overview.json", release / "grafana/dashboards/work-overview.json")
            (release / "bin").mkdir()
            (release / "third-party").mkdir()
            for name in ("prometheus", "promtool", "alertmanager", "amtool"):
                path = release / "bin" / name
                path.write_text("#!/usr/bin/env bash\nexit 0\n")
                path.chmod(0o755)
            (release / "bin/work-api").write_text("new-api\n")
            (release / "third-party/grafana.deb").write_text("mock-deb\n")
            (release / "RELEASE_COMMIT").write_text("a" * 40 + "\n")
            (release / "RELEASE_DIRTY").write_text("0\n")
            sums = []
            for path in sorted(release.rglob("*")):
                if path.is_file() and path.name != "SHA256SUMS":
                    digest = hashlib.sha256(path.read_bytes()).hexdigest()
                    sums.append(f"{digest}  {path.relative_to(release).as_posix()}\n")
            (release / "SHA256SUMS").write_bytes("".join(sums).encode())

            api = root / "usr/local/bin/work-api"
            api.parent.mkdir(parents=True)
            api.write_text("old-api\n")
            api.chmod(0o755)
            env = root / "etc/work/work-api.env"
            env.parent.mkdir(parents=True)
            env.write_text("WORK_LISTEN_ADDR=127.0.0.1:8080\n")
            (root / "etc/systemd/system").mkdir(parents=True)
            systemctl_log = Path(temp) / "systemctl.log"

            script = (ROOT / "install.sh").read_text()
            for prefix in ("/etc/", "/opt/", "/usr/local/", "/var/backups/", "/var/lib/", "/var/log/"):
                script = script.replace(prefix, root_posix + prefix)
            script = script.replace("[[ ! -x ", "[[ ! -f ", 1)
            script = script.replace(f"rm -f {root_posix}/opt/work-observability/current", f"rm -rf {root_posix}/opt/work-observability/current")
            mocks = r'''
id() { if [[ "$1" == "-u" ]]; then echo 0; fi; return 0; }
getent() { return 0; }
ss() { return 0; }
runuser() { echo 0; }
curl() { return 0; }
openssl() { echo 000000000000000000000000000000000000000000000000; }
systemd-analyze() { return 0; }
systemctl() { printf '%s\n' "$*" >> "$MOCK_SYSTEMCTL_LOG"; [[ "$*" != "start work-api" ]]; }
install() {
  local directory=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -d) directory=1; shift ;;
      -m|-o|-g) shift 2 ;;
      *) break ;;
    esac
  done
  if [[ "$directory" == "1" ]]; then mkdir -p "$@"; return; fi
  local destination="${@: -1}" source target
  for source in "${@:1:$#-1}"; do
    if [[ -d "$destination" || "$destination" == */ ]]; then
      target="$destination/$(basename "$source")"
    else
      target="$destination"
    fi
    command cp "$source" "$target"
  done
}
ln() { if [[ "$1" == "-s" ]]; then command cp -a "$2" "$3"; else command ln "$@"; fi; }
dpkg-deb() {
  mkdir -p "$3/usr/share/grafana/bin"
  printf '#!/usr/bin/env bash\necho grafana version 13.3.1\n' > "$3/usr/share/grafana/bin/grafana"
  chmod +x "$3/usr/share/grafana/bin/grafana"
}
'''
            result = subprocess.run(
                [bash_executable(), "-s", "--", release.as_posix()],
                input=mocks + script,
                capture_output=True,
                text=True,
                env={**os.environ, "MOCK_SYSTEMCTL_LOG": str(systemctl_log)},
            )
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(api.read_text(), "old-api\n")
            self.assertEqual(env.read_text(), "WORK_LISTEN_ADDR=127.0.0.1:8080\n")
            self.assertFalse((root / "etc/work-observability").exists())
            self.assertTrue(list((root / "etc").glob("work-observability.install-failed-*")), result.stdout + result.stderr + "\n" + repr(list((root / "etc").iterdir())))
            self.assertFalse((root / "opt/work-observability/current").exists())
            calls = systemctl_log.read_text().splitlines()
            self.assertIn("start work-api", calls, result.stdout + result.stderr + "\n" + repr(calls))
            self.assertIn("restart work-api", calls)
            self.assertEqual(calls[calls.index("restart work-api") - 1], "stop work-api")

    def test_installer_and_verifier_use_host_safe_checks(self):
        install = (ROOT / "install.sh").read_text()
        verify = (ROOT / "verify.sh").read_text()
        self.assertIn('"$GRAFANA_BIN" --version', install)
        self.assertNotIn("ldd ", install)
        self.assertIn("while read -r _state _recv _send local_address _peer _process; do", verify)

    def test_install_and_rollback_preserve_recovery_order(self):
        install = (ROOT / "install.sh").read_text()
        rollback = (ROOT / "rollback.sh").read_text()
        self.assertIn('refusing to install a dirty observability release', install)
        self.assertIn('for binary in prometheus promtool alertmanager amtool', install)
        self.assertNotIn('tar -xzf "$RELEASE/third-party/$PROMETHEUS_ARCHIVE"', install)
        self.assertNotIn('tar -xzf "$RELEASE/third-party/$ALERTMANAGER_ARCHIVE"', install)
        self.assertIn('RELEASE_ID="$COMMIT-$STAMP"', install)
        self.assertLess(install.index('printf \'%s\\n\' "$BACKUP" > /etc/work-observability/API_BACKUP'), install.index('install -m 0755 -o root -g root "$RELEASE/bin/work-api"'))
        self.assertLess(install.index('systemctl stop work-api'), install.index('install -m 0755 -o root -g root "$RELEASE/bin/work-api"'))
        self.assertLess(install.index('install -m 0755 -o root -g root "$RELEASE/bin/work-api"'), install.index('systemctl start work-api'))
        self.assertEqual(install.count('OPEN_RUNS='), 2)
        self.assertIn('trap cleanup_failed_install EXIT', install)
        self.assertLess(rollback.index('BACKUP="$(cat /etc/work-observability/API_BACKUP)"'), rollback.index('systemctl stop work-api'))
        self.assertLess(rollback.index('systemctl stop work-api'), rollback.index('cp -p "$BACKUP/work-api"'))
        self.assertLess(rollback.index('cp -p "$BACKUP/work-api"'), rollback.index('mv -f /usr/local/bin/work-api.rollback'))
        self.assertLess(rollback.index('mv -f /usr/local/bin/work-api.rollback'), rollback.index('systemctl start work-api\nAPI_STOPPED=0'))
        self.assertLess(rollback.index('systemctl start work-api\nAPI_STOPPED=0'), rollback.index('for unit in work-observability-grafana'))
        self.assertLess(rollback.index('systemctl start work-api\nAPI_STOPPED=0'), rollback.index('mv /etc/work-observability'))
        self.assertIn('rm -f /opt/work-observability/current', rollback)

    def test_rollback_script_runs_with_mocked_host_commands(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "host"
            root_posix = root.as_posix()
            config = root / "etc/work-observability"
            backup = root / "var/backups/work-observability/test"
            for directory in (config, root / "etc/systemd/system", root / "etc/work", root / "opt/work-observability", root / "usr/local/bin", backup):
                directory.mkdir(parents=True, exist_ok=True)
            (config / "API_BACKUP").write_text(backup.as_posix() + "\n")
            (backup / "work-api").write_text("new-api\n")
            (backup / "work-api.env").write_text("WORK_METRICS_ADDR=127.0.0.1:19091\n")
            (root / "usr/local/bin/work-api").write_text("old-api\n")
            (root / "opt/work-observability/current").write_text("mock-current\n")
            script = (ROOT / "rollback.sh").read_text()
            script = script.replace("/etc/", root_posix + "/etc/")
            script = script.replace("/opt/", root_posix + "/opt/")
            script = script.replace("/usr/local/", root_posix + "/usr/local/")
            script = "id() { echo 0; }\nsystemctl() { return 0; }\ncurl() { return 0; }\n" + script
            result = subprocess.run([bash_executable()], input=script, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertIn("work-api restored from", result.stdout)
            self.assertFalse(config.exists())
            self.assertTrue(list((root / "etc").glob("work-observability.rolled-back-*")))
            self.assertFalse((root / "opt/work-observability/current").exists())
            self.assertEqual((root / "usr/local/bin/work-api").read_text(), "new-api\n")

    def test_rollback_refuses_missing_backup_before_stopping_services(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "host"
            root_posix = root.as_posix()
            config = root / "etc/work-observability"
            config.mkdir(parents=True)
            current = root / "opt/work-observability/current"
            current.parent.mkdir(parents=True)
            current.write_text("mock-current\n")
            script = (ROOT / "rollback.sh").read_text()
            script = script.replace("/etc/", root_posix + "/etc/")
            script = script.replace("/opt/", root_posix + "/opt/")
            script = "id() { echo 0; }\nsystemctl() { return 0; }\ncurl() { return 0; }\n" + script
            result = subprocess.run([bash_executable()], input=script, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("refusing rollback without a verified API backup", result.stderr)
            self.assertTrue(config.exists())
            self.assertTrue(current.exists())

    def test_third_party_versions_are_pinned_with_sha256(self):
        values = {}
        for line in (ROOT / "versions.env").read_text().splitlines():
            if not line.strip():
                continue
            key, value = line.split("=", 1)
            values[key] = value
        for prefix in ("PROMETHEUS", "ALERTMANAGER", "GRAFANA"):
            self.assertRegex(values[f"{prefix}_VERSION"], r"^\d+\.\d+\.\d+$")
            self.assertRegex(values[f"{prefix}_SHA256"], r"^[0-9a-f]{64}$")
            self.assertTrue(values[f"{prefix}_URL"].startswith("https://github.com/"))
        for name in ("PROMETHEUS_BIN_SHA256", "PROMTOOL_BIN_SHA256", "ALERTMANAGER_BIN_SHA256", "AMTOOL_BIN_SHA256"):
            self.assertRegex(values[name], r"^[0-9a-f]{64}$")


class DemoMetricsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.fail_file = Path(self.temp.name) / "fail"
        self.module = load_module("demo_metrics", "demo-metrics.py")
        self.old_env = os.environ.copy()
        os.environ["WORK_DEMO_FAIL_FILE"] = str(self.fail_file)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self.module.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        os.environ.clear()
        os.environ.update(self.old_env)
        self.temp.cleanup()

    def test_metrics_toggle_only_the_controlled_demo_state(self):
        with urlopen(self.base + "/metrics") as response:
            first = response.read().decode()
        self.assertIn('work_demo_requests_total{org_id="demo"} 1', first)
        self.assertIn('work_demo_failures_total{org_id="demo"} 0', first)
        self.fail_file.touch()
        with urlopen(self.base + "/metrics") as response:
            second = response.read().decode()
        self.assertIn('work_demo_requests_total{org_id="demo"} 2', second)
        self.assertIn('work_demo_failures_total{org_id="demo"} 1', second)
        self.assertNotIn("goal", second)
        self.assertNotIn("prompt", second)


class DemoWebhookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data_file = Path(self.temp.name) / "alerts.jsonl"
        self.module = load_module("demo_webhook", "demo-webhook.py")
        self.old_env = os.environ.copy()
        os.environ["WORK_WEBHOOK_DATA_FILE"] = str(self.data_file)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self.module.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        os.environ.clear()
        os.environ.update(self.old_env)
        self.temp.cleanup()

    def post(self, payload):
        request = Request(self.base + "/alerts", data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="POST")
        return urlopen(request)

    def test_allowed_alert_is_recorded_without_extra_labels(self):
        payload = {
            "receiver": "demo-webhook",
            "status": "firing",
            "groupKey": "demo",
            "alerts": [{
                "status": "firing",
                "startsAt": "2026-11-24T00:00:00Z",
                "endsAt": "0001-01-01T00:00:00Z",
                "labels": {"alertname": "WorkObservabilityDemoFailure", "severity": "ticket", "alert_class": "demo", "org_id": "demo", "job": "work-demo", "instance": "127.0.0.1:19092"},
                "annotations": {"summary": "C17 local demo alert pipeline probe", "runbook": "docs/work/operations.md"},
            }],
        }
        with self.post(payload) as response:
            self.assertEqual(response.status, 200)
        record = json.loads(self.data_file.read_text().splitlines()[0])
        self.assertEqual(record["alerts"][0]["status"], "firing")
        self.assertEqual(record["alerts"][0]["labels"]["alertname"], "WorkObservabilityDemoFailure")
        self.assertNotIn("group_key", record)
        self.assertNotIn("annotations", record["alerts"][0])
        self.assertNotIn("starts_at", record["alerts"][0])
        if os.name != "nt":
            self.assertEqual(self.data_file.stat().st_mode & 0o777, 0o600)

    def test_real_org_alert_is_refused_and_not_written(self):
        payload = {"alerts": [{"labels": {"alertname": "WorkControlApiAvailabilityFastBurn", "org_id": "org_a"}, "annotations": {}}]}
        with self.assertRaises(HTTPError) as caught:
            self.post(payload)
        self.assertEqual(caught.exception.code, 400)
        self.assertFalse(self.data_file.exists())

    def test_annotation_content_is_refused_and_not_written(self):
        payload = {"alerts": [{
            "status": "firing",
            "labels": {"alertname": "WorkObservabilityDemoFailure", "severity": "ticket", "alert_class": "demo", "org_id": "demo"},
            "annotations": {"summary": "private"},
        }]}
        with self.assertRaises(HTTPError) as caught:
            self.post(payload)
        self.assertEqual(caught.exception.code, 400)
        self.assertFalse(self.data_file.exists())

    def test_wrong_scrape_label_is_refused_and_not_written(self):
        payload = {"alerts": [{
            "status": "firing",
            "labels": {"alertname": "WorkObservabilityDemoFailure", "severity": "ticket", "alert_class": "demo", "org_id": "demo", "job": "other", "instance": "127.0.0.1:19092"},
            "annotations": {"summary": "C17 local demo alert pipeline probe", "runbook": "docs/work/operations.md"},
        }]}
        with self.assertRaises(HTTPError) as caught:
            self.post(payload)
        self.assertEqual(caught.exception.code, 400)
        self.assertFalse(self.data_file.exists())

    def test_content_label_is_refused_and_not_written(self):
        payload = {"alerts": [{"labels": {"goal": "private"}, "annotations": {}}]}
        with self.assertRaises(HTTPError) as caught:
            self.post(payload)
        self.assertEqual(caught.exception.code, 400)
        self.assertFalse(self.data_file.exists())


if __name__ == "__main__":
    unittest.main()
