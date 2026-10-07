"""Real Helm rendering plus preservation/provenance failure boundaries."""

import copy
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import test_meeting_ai_chart as chart
import yaml
from test_meeting_ai_chart import ROOT, render


def load(name, filename):
    spec = importlib.util.spec_from_file_location(
        name, Path(__file__).with_name(filename)
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


resolver = load("image_commit", "resolve-image-commit.py")
preserver = load("preserve_backend", "preserve-backend-release.py")
IMAGE = "fixture/backend@sha256:" + "b" * 64
COMMIT = "a" * 40
SETTINGS = (
    "aiBackend.enabled=true",
    "workWorker.enabled=true",
    "celeryBeat.enabled=true",
    "backend.docsProfileSync.enabled=true",
    "backend.reminders.enabled=true",
)


def containers(row):
    spec = (
        row["spec"]["jobTemplate"]["spec"] if row["kind"] == "CronJob" else row["spec"]
    )
    return spec["template"]["spec"]["containers"]


class ImageReferenceTests(unittest.TestCase):
    def test_backend_digest_is_shared_by_pools_workers_crons_and_hooks(self):
        rows = render(
            *SETTINGS, "backend.image.reference=" + IMAGE, "backend.image.tag=ignored"
        )
        names = {
            "meet-backend",
            "meet-backend-ai",
            "meet-celery-backend",
            "meet-celery-work",
            "meet-celery-beat",
            "meet-backend-docs-profiles",
            "meet-backend-reminders",
            "meet-backend-migrate",
            "meet-backend-createsuperuser",
        }
        selected = [
            r
            for r in rows
            if r["metadata"]["name"] in names
            and r["kind"] in ("Deployment", "CronJob", "Job")
        ]
        self.assertEqual(len(selected), 9)
        self.assertTrue(all(containers(r)[0]["image"] == IMAGE for r in selected))

    def test_other_image_families_accept_independent_references(self):
        rows = render(
            "frontend.image.reference=registry.invalid:5000/ui@sha256:" + "c" * 64,
            "summary.image.reference=fixture/summary:commit",
            "agentMetadata.image.reference=fixture/agent@sha256:" + "d" * 64,
        )
        deployments = {
            r["metadata"]["name"]: containers(r)[0]["image"]
            for r in rows
            if r["kind"] == "Deployment"
        }
        self.assertEqual(
            deployments["meet-frontend"], "registry.invalid:5000/ui@sha256:" + "c" * 64
        )
        self.assertEqual(deployments["meet-summary"], "fixture/summary:commit")
        self.assertEqual(
            deployments["meet-agent-metadata"], "fixture/agent@sha256:" + "d" * 64
        )

    def test_malformed_digest_fails_before_any_apply(self):
        self.assertIn(
            "image.reference",
            render("backend.image.reference=fixture/backend@sha256:bad", success=False),
        )

    def test_transcribe_instance_override_does_not_inherit_base_digest(self):
        rows = render(
            "celeryTranscribe.image.reference=" + IMAGE,
            "celeryTranscribe.instances[0].name=default",
            "celeryTranscribe.instances[0].image.tag=instance-tag",
        )
        row = next(
            r for r in rows if r["metadata"]["name"] == "meet-celery-transcribe-default"
        )
        self.assertEqual(
            containers(row)[0]["image"], "lasuite/meet-summary:instance-tag"
        )

    def test_optional_ai_worker_digest_overrides_legacy_tag(self):
        rows = render(
            *chart.MeetingAIChartTest.settings,
            "meetingAIWorkers.workers.capture-asr.enabled=true",
            "meetingAIWorkers.workers.capture-asr.imageReference=" + IMAGE,
            "meetingAIWorkers.workers.capture-asr.imageTag=ignored",
        )
        row = next(
            r
            for r in rows
            if r["kind"] == "Deployment"
            and r["metadata"]["name"] == "meet-agent-capture-asr"
        )
        self.assertEqual(containers(row)[0]["image"], IMAGE)

    def test_partial_release_preserves_spec_env_order_flags_and_omits_db_hooks(self):
        baseline = render(
            *SETTINGS,
            "backend.image.reference=" + IMAGE,
            "backend.envVars.WORK_REVIEW_ENABLED=False",
        )
        names = {
            "meet-backend",
            "meet-backend-ai",
            "meet-celery-backend",
            "meet-celery-work",
            "meet-celery-beat",
            "meet-backend-docs-profiles",
            "meet-backend-reminders",
        }
        old = [
            r
            for r in baseline
            if r["metadata"]["name"] in names and r["kind"] in ("Deployment", "CronJob")
        ]
        for r in old:
            r["metadata"]["uid"] = "fixture-" + r["metadata"]["name"]
            containers(r)[0]["env"].append(
                {"name": "ORIGINAL_ORDER", "value": "fixture"}
            )
        pending = render(
            *SETTINGS,
            "backend.image.tag=old-default",
            "backend.envVars.WORK_REVIEW_ENABLED=True",
            "frontend.image.reference=fixture/ui:new",
        )
        result = preserver.preserve(pending, {"items": old}, "meet")
        current = {(r["kind"], r["metadata"]["name"]): r for r in result}
        self.assertEqual(len(old), 7)
        for r in old:
            self.assertEqual(
                current[(r["kind"], r["metadata"]["name"])]["spec"], r["spec"]
            )
        self.assertNotIn(("Job", "meet-backend-migrate"), current)
        self.assertNotIn(("Job", "meet-backend-createsuperuser"), current)
        self.assertEqual(
            containers(current[("Deployment", "meet-frontend")])[0]["image"],
            "fixture/ui:new",
        )

    def test_unselected_consumer_creation_or_removal_is_rejected(self):
        row = {
            "kind": "Deployment",
            "metadata": {"name": "meet-backend", "namespace": "meet"},
            "spec": {},
        }
        new = copy.deepcopy(row)
        new["metadata"]["name"] = "meet-backend-ai"
        with self.assertRaisesRegex(ValueError, "would_be_created"):
            preserver.preserve([row, new], {"items": [row]}, "meet")
        with self.assertRaisesRegex(ValueError, "consumer_missing"):
            preserver.preserve([], {"items": [row]}, "meet")

    def test_namespace_mismatch_is_rejected(self):
        old = {
            "kind": "Deployment",
            "metadata": {"name": "meet-backend", "namespace": "meet"},
            "spec": {},
        }
        row = copy.deepcopy(old)
        row["metadata"]["namespace"] = "other"
        with self.assertRaisesRegex(ValueError, "namespace_mismatch"):
            preserver.preserve([row], {"items": [old]}, "meet")


class ImageProvenanceTests(unittest.TestCase):
    def test_committed_digest_receipt_resolves_one_source_commit(self):
        receipt = {
            "source_commit": COMMIT,
            "verification": {"controllers": [{"image": IMAGE}]},
        }
        self.assertEqual(resolver.from_receipts(IMAGE, [receipt, receipt, []]), COMMIT)

    def test_missing_conflicting_or_malformed_provenance_is_rejected(self):
        receipt = {
            "source_commit": COMMIT,
            "verification": {"controllers": [{"image": IMAGE}]},
        }
        other = copy.deepcopy(receipt)
        other["source_commit"] = "c" * 40
        for records in (
            [],
            [receipt, other],
            [{**receipt, "source_commit": "not-a-commit"}],
        ):
            with self.assertRaises(ValueError):
                resolver.from_receipts(IMAGE, records)

    def test_receipt_is_read_from_git_head_instead_of_working_tree(self):
        receipt = {
            "source_commit": COMMIT,
            "verification": {"controllers": [{"image": IMAGE}]},
        }
        with patch.object(
            resolver,
            "git",
            side_effect=["docs/reviews/receipt.json", json.dumps(receipt), COMMIT],
        ) as git:
            self.assertEqual(resolver.resolve(IMAGE), COMMIT)
            self.assertEqual(
                git.call_args_list[1].args, ("show", "HEAD:docs/reviews/receipt.json")
            )


@unittest.skipIf(os.name == "nt", "Executable release fixtures run on Linux/WSL CI")
class RealPartialReleaseTests(unittest.TestCase):
    def release(self, drift=None, module="frontend"):
        baseline = render(*SETTINGS, "backend.image.reference=" + IMAGE)
        snapshot = {"items": []}
        for row in baseline:
            if row["kind"] in ("Deployment", "CronJob"):
                row["metadata"]["namespace"] = "meet"
                row["metadata"]["uid"] = "fixture-" + row["metadata"]["name"]
                snapshot["items"].append(row)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot_path = root / "snapshot.json"
            snapshot_path.write_text(json.dumps(snapshot))
            values = root / "values.json"
            values.write_text(
                json.dumps(
                    {
                        "aiBackend": {"enabled": True},
                        "workWorker": {"enabled": True},
                        "celeryBeat": {"enabled": True},
                        "backend": {
                            "docsProfileSync": {"enabled": True},
                            "reminders": {"enabled": True},
                            "envVars": {"WORK_REVIEW_ENABLED": "True"},
                        },
                    }
                )
            )
            secrets = root / "empty.json"
            secrets.write_text("{}")
            profile = root / "disabled.json"
            profile.write_text('{"workAgent":{"enabled":false}}')
            scripts = {
                "git": """#!/bin/sh
case "$*" in
 *--is-inside-work-tree*) echo true;;
 *branch*--show-current*) echo aliyun-dev;;
 *rev-parse*) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;;
esac
exit 0
""",
                "kubectl": """#!/usr/bin/env python3
import json,os,sys,pathlib
args=sys.argv[1:]
assert 'get' in args, 'fixture permits read-only kubectl'
if 'deployment,cronjob' in args:
 counter=pathlib.Path(os.environ['FIXTURE_COUNTER'])
 count=int(counter.read_text()) if counter.exists() else 0
 counter.write_text(str(count+1))
 data=json.loads(pathlib.Path(os.environ['FIXTURE_SNAPSHOT']).read_text())
 backend=next(r for r in data['items'] if r['metadata']['name']=='meet-backend')
 mode=os.environ['FIXTURE_DRIFT']
 if count and mode=='uid': backend['metadata']['uid']='changed'
 if count and mode=='spec': backend['spec']['replicas']=999
 if mode=='image': backend['spec']['template']['spec']['containers'][0]['image']='fixture/unreviewed:new'
 print(json.dumps(data))
elif '--ignore-not-found' not in args:
 name=args[args.index('deployment')+1]
 if name in ('meet-agent-translation','meet-agent-interpretation','meet-agent-capture-asr','meet-agent-capture-live-asr','meet-agent-capture-translation'): sys.exit(1)
 print(os.environ['FIXTURE_IMAGE'] if name=='meet-backend' else 'fixture/other:123456789')
""",
                "helm": """#!/usr/bin/env python3
import os,subprocess,sys
args=sys.argv[1:]
assert '--dry-run' in args, 'fixture forbids cluster upgrade'
assert '--post-renderer' in args, 'partial release must preserve backend'
out=['template',args[3],args[4],'-n',args[1]]
i=5
while i<len(args):
 if args[i] in ('--wait','--dry-run','--debug'): i+=1
 elif args[i]=='--timeout': i+=2
 else: out.extend(args[i:i+2]); i+=2
sys.exit(subprocess.run([os.environ['FIXTURE_REAL_HELM'],*out]).returncode)
""",
            }
            for name, source in scripts.items():
                path = root / name
                path.write_text(source)
                path.chmod(0o755)
            env = dict(
                os.environ,
                PATH=str(root) + os.pathsep + os.environ["PATH"],
                VALUES_FILE=str(values),
                SECRETS_FILE=str(secrets),
                WORK_VALUES_FILE=str(root / "absent"),
                WORK_AGENT_VALUES_FILE=str(profile),
                FIXTURE_SNAPSHOT=str(snapshot_path),
                FIXTURE_COUNTER=str(root / "counter"),
                FIXTURE_IMAGE=IMAGE,
                FIXTURE_DRIFT=drift or "none",
                FIXTURE_REAL_HELM=shutil.which("helm"),
                NAMESPACE="meet",
                RELEASE="meet",
            )
            result = subprocess.run(
                [
                    "bash",
                    str(ROOT / "deploy/aliyun/release-meet.sh"),
                    "--dry-run",
                    "--skip-git-pull",
                    "--tag",
                    "234567890",
                    module,
                ],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            return result, snapshot

    def test_real_helm_preserves_backend_and_disables_hooks_before_post_render(self):
        result, snapshot = self.release()
        self.assertEqual(result.returncode, 0, result.stderr)
        # The release script's progress text precedes Helm's first document.
        rows = [
            r
            for r in yaml.safe_load_all(result.stdout[result.stdout.index("---") :])
            if r
        ]
        indexed = {(r["kind"], r["metadata"]["name"]): r for r in rows}
        self.assertNotIn(("Job", "meet-backend-migrate"), indexed)
        self.assertNotIn(("Job", "meet-backend-createsuperuser"), indexed)
        preserved = 0
        for old in snapshot["items"]:
            name = old["metadata"]["name"]
            if name in {
                "meet-backend",
                "meet-backend-ai",
                "meet-celery-backend",
                "meet-celery-beat",
                "meet-celery-work",
                "meet-backend-docs-profiles",
                "meet-backend-reminders",
            }:
                self.assertEqual(indexed[(old["kind"], name)]["spec"], old["spec"])
                preserved += 1
        self.assertEqual(preserved, 7)
        self.assertEqual(
            containers(indexed[("Deployment", "meet-frontend")])[0]["image"],
            "fixture/other:234567890",
        )

    def test_live_uid_drift_rejects_real_render_before_any_apply(self):
        result, _ = self.release(drift="uid")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unselected_backend_changed_since_snapshot", result.stderr)

    def test_live_spec_drift_rejects_real_render_before_any_apply(self):
        result, _ = self.release(drift="spec")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unselected_backend_changed_since_snapshot", result.stderr)

    def test_snapshot_image_drift_rejects_unchecked_backend_provenance(self):
        result, _ = self.release(drift="image")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("backend_image_changed_since_provenance_check", result.stderr)

    def test_agents_release_resolves_absent_worker_defaults_without_enabling(self):
        result, _ = self.release(module="agents")
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = [
            r
            for r in yaml.safe_load_all(result.stdout[result.stdout.index("---") :])
            if r
        ]
        names = {r["metadata"]["name"] for r in rows if r["kind"] == "Deployment"}
        self.assertNotIn("meet-agent-capture-asr", names)
        row = next(
            r
            for r in rows
            if r["kind"] == "Deployment"
            and r["metadata"]["name"] == "meet-agent-metadata"
        )
        self.assertEqual(containers(row)[0]["image"], "fixture/other:234567890")


if __name__ == "__main__":
    unittest.main()
