"""Work Helm and storage-probe tests; no production credentials or cluster calls."""

import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import yaml
from botocore.exceptions import ClientError

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("check_work_runtime", ROOT / "deploy/aliyun/check-work-runtime.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


def render(*args):
    result = subprocess.run([shutil.which("helm"), "template", "meet", str(ROOT / "src/helm/meet"), *args],
                            capture_output=True, text=True, encoding="utf8")
    return result, list(yaml.safe_load_all(result.stdout)) if result.returncode == 0 else []


class WorkChartTest(unittest.TestCase):
    def test_default_has_no_work_worker(self):
        result, rows = render()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(row and row['metadata']['name'] == 'meet-celery-work' for row in rows))

    def test_worker_requires_scheduler(self):
        result, _ = render('--set', 'workWorker.enabled=true')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('requires celeryBeat', result.stderr)

    def test_worker_inherits_backend_only_and_shares_image(self):
        result, rows = render('--set', 'workWorker.enabled=true,celeryBeat.enabled=true',
                              '--set-string', 'backend.image.tag=fixture-immutable',
                              '--set-string', 'backend.envVars.WORK_ENABLED=True',
                              '--set-string', 'backend.envVars.WORK_MODEL_API_KEY.secretKeyRef.name=fixture-model',
                              '--set-string', 'backend.envVars.WORK_MODEL_API_KEY.secretKeyRef.key=api-key',
                              '--set-string', 'celeryBackend.envVars.OTHER_QUEUE_ONLY=not-work')
        self.assertEqual(result.returncode, 0, result.stderr)
        row = next(row for row in rows if row and row['metadata']['name'] == 'meet-celery-work')
        pod = row['spec']['template']['spec']
        container = pod['containers'][0]
        self.assertTrue(container['image'].endswith(':fixture-immutable'))
        self.assertEqual(container['command'][-2:], ['-Q', 'work'])
        self.assertIn('--pool=prefork', container['command'])
        env = {item['name']: item for item in container['env']}
        self.assertNotIn('OTHER_QUEUE_ONLY', env)
        self.assertEqual(env['WORK_ENABLED']['value'], 'True')
        self.assertEqual(env['WORK_MODEL_API_KEY']['valueFrom']['secretKeyRef']['name'], 'fixture-model')
        self.assertTrue(container['securityContext']['readOnlyRootFilesystem'])
        self.assertEqual(container['resources']['limits']['memory'], '1Gi')
        self.assertEqual(pod['volumes'][0]['emptyDir']['sizeLimit'], '256Mi')

    def test_material_overlay_is_persistent_but_generation_stays_off(self):
        result, rows = render('-f', str(ROOT / 'src/helm/env.d/aliyun-prod/values.work.yaml.dist'))
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in ('meet-backend', 'meet-celery-work', 'meet-celery-beat'):
            row = next(row for row in rows if row and row['kind'] == 'Deployment' and row['metadata']['name'] == name)
            env = {item['name']: item.get('value') for item in row['spec']['template']['spec']['containers'][0]['env']}
            self.assertEqual(env['WORK_MATERIALS_ENABLED'], 'True')
            self.assertEqual(env['WORK_COMMUNICATION_ENABLED'], 'False')
        script = (ROOT / 'deploy/aliyun/release-meet.sh').read_text(encoding='utf8')
        self.assertIn('helm_args+=(-f "$WORK_VALUES_FILE")', script)
        self.assertIn('wait_for_deployment "$RELEASE-celery-work"', script)


class FakeStorage:
    endpoint_url = 'https://storage.example.invalid'
    region_name = 'test-region'
    addressing_style = 'virtual'
    bucket_name = 'test-private'

    def __init__(self):
        self.content = None
        self.names = []
        self.cleaned = False

    def save(self, name, content):
        self.content = content
        self.names.append(name)
        return name

    def open(self, name, mode):
        self.content.seek(0)
        return self.content

    def _normalize_name(self, name):
        return 'work-materials/' + name

    def delete(self, name):
        assert name in self.names
        self.cleaned = True

    def exists(self, name):
        return not self.cleaned


class WorkStorageProbeTest(unittest.TestCase):
    def probe(self, *, status=None, cleanup_error=False):
        # work.storage only uses lazy Django settings at import, no live setup needed.
        storage = FakeStorage()
        client = Mock()
        if status:
            client.get_object.side_effect = ClientError({'Error': {'Code': 'Test'}, 'ResponseMetadata': {'HTTPStatusCode': status}}, 'GetObject')
        else:
            client.get_object.return_value = {'Body': Mock()}
        if cleanup_error:
            storage.delete = Mock(side_effect=RuntimeError('do-not-disclose-secret'))
        with patch('work.storage.PrivateMaterialStorage', FakeStorage), patch('boto3.client', return_value=client) as factory:
            result = runtime.storage_probe(storage)
        from botocore import UNSIGNED
        self.assertIs(factory.call_args.kwargs['config'].signature_version, UNSIGNED)
        self.assertNotIn('do-not-disclose-secret', str(result))
        return result, storage

    def test_private_signed_roundtrip_and_anonymous_denial(self):
        result, storage = self.probe(status=403)
        self.assertTrue(result['ok'])
        self.assertTrue(storage.cleaned)
        self.assertTrue(storage.names[0].startswith('_deployment-probes/'))

    def test_public_object_blocks_enable_and_is_cleaned(self):
        result, storage = self.probe()
        self.assertFalse(result['ok'])
        self.assertEqual(result['code'], 'anonymous_read_allowed')
        self.assertTrue(storage.cleaned)

    def test_404_is_not_mistaken_for_private_acl(self):
        result, _ = self.probe(status=404)
        self.assertFalse(result['ok'])

    def test_cleanup_failure_blocks_rollout_and_reports_only_probe_key(self):
        result, _ = self.probe(status=403, cleanup_error=True)
        self.assertFalse(result['ok'])
        self.assertFalse(result['cleanup'])
        self.assertTrue(result['cleanup_key'].startswith('_deployment-probes/'))

    def test_save_failure_reports_stage_and_sanitized_provider_error(self):
        storage = FakeStorage()
        error = ClientError({'Error': {'Code': 'AccessDenied', 'Message': 'secret-url'},
                             'ResponseMetadata': {'HTTPStatusCode': 403}}, 'PutObject')
        storage.save = Mock(side_effect=error)
        storage.delete = Mock(side_effect=error)
        with patch('work.storage.PrivateMaterialStorage', FakeStorage):
            result = runtime.storage_probe(storage)
        self.assertEqual(result['stage'], 'save')
        self.assertEqual(result['error']['provider_code'], 'AccessDenied')
        self.assertEqual(result['cleanup_detail']['stage'], 'delete')
        self.assertNotIn('secret-url', json.dumps(result))

    def test_cleanup_rejects_material_keys_before_storage_access(self):
        storage = Mock()
        for name in ('materials/anything.txt', '_deployment-probes/../secret.txt',
                     '_deployment-probes/', '_deployment-probes/' + 'a' * 32 + '.txt/other'):
            self.assertFalse(runtime.cleanup_probe(storage, name)['ok'])
        storage.delete.assert_not_called()

    def test_cleanup_retries_exact_previous_probe(self):
        storage = Mock()
        storage.exists.return_value = False
        name = '_deployment-probes/95f0c925b6574bd785e1f3acc4fc1685.txt'
        self.assertTrue(runtime.cleanup_probe(storage, name)['ok'])
        storage.delete.assert_called_once_with(name)
        storage.exists.assert_called_once_with(name)

    def test_unknown_provider_values_are_not_echoed(self):
        exc = ClientError({'Error': {'Code': 'secret-url', 'Message': 'private-key'},
                           'ResponseMetadata': {'HTTPStatusCode': 400}}, 'PutObject')
        self.assertEqual(runtime.safe_error(exc),
                         {'type': 'ClientError', 'http_status': 400, 'provider_code': 'OtherCode'})


class WorkStorageConfigTest(unittest.TestCase):
    def test_preserves_deployment_and_explicit_provider_config_with_bounded_timeouts(self):
        # A fresh settings registry exercises django-storages' actual defaults.
        script = '''
from django.conf import settings
from botocore.config import Config
deployment = Config(signature_version="s3v4", s3={"addressing_style": "virtual"},
                    request_checksum_calculation="when_required",
                    response_checksum_validation="when_required")
settings.configure(AWS_S3_CLIENT_CONFIG=deployment)
from work.storage import PrivateMaterialStorage
for provider in (deployment, deployment.merge(Config(s3={"addressing_style": "path"}))):
    kwargs = {} if provider is deployment else {"client_config": provider}
    storage = PrivateMaterialStorage(**kwargs)
    actual = storage.client_config
    for field in ("signature_version", "s3", "request_checksum_calculation", "response_checksum_validation"):
        assert getattr(actual, field) == getattr(provider, field), field
    assert actual.connect_timeout == 5
    assert actual.read_timeout == 15
    assert actual.retries["max_attempts"] == 1
    assert storage.get_object_parameters("fixture.txt")["ACL"] == "private"
    try:
        storage.url("fixture.txt")
        raise AssertionError("public URL allowed")
    except NotImplementedError:
        pass
'''
        result = subprocess.run([sys.executable, '-c', script], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


class WorkEnableScriptTest(unittest.TestCase):
    def execute(self, mode, denied=False, initial=None, model_denied=False):
        bash = shutil.which('bash')
        if os.name == 'nt':
            candidate = pathlib.Path(shutil.which('git')).parents[1] / 'bin/bash.exe'
            if candidate.exists():
                bash = str(candidate)
        if not bash:
            self.skipTest('bash unavailable')

        def posix(path):
            value = pathlib.Path(path).as_posix()
            return f'/{value[0].lower()}{value[2:]}' if os.name == 'nt' else value

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'deploy/aliyun').mkdir(parents=True)
            (root / 'bin').mkdir()
            shutil.copyfile(ROOT / 'deploy/aliyun/enable-work.sh', root / 'deploy/aliyun/enable-work.sh')
            shutil.copyfile(ROOT / 'deploy/aliyun/configure-work-overlay.py', root / 'deploy/aliyun/configure-work-overlay.py')
            (root / 'src/helm/env.d/aliyun-prod').mkdir(parents=True)
            shutil.copyfile(ROOT / 'src/helm/env.d/aliyun-prod/values.work.yaml.dist', root / 'src/helm/env.d/aliyun-prod/values.work.yaml.dist')
            (root / 'deploy/aliyun/check-work-runtime.py').write_text('# fixture only\n')
            (root / 'deploy/aliyun/check-work-model.py').write_text('# fixture only\n')
            scripts = {
                'bin/kubectl': '''#!/usr/bin/env bash
echo "kubectl $*" >> "$FIXTURE_LOG"
case "$*" in
  *exec*) cat >/dev/null; if [[ "$FIXTURE_DENIED" == 1 && "$*" == *--probe-storage* ]]; then exit 1; fi; if [[ "$FIXTURE_MODEL_DENIED" == 1 && "$*" == *deployment/meet-celery-work* ]]; then exit 1; fi; echo '{"ok":true}' ;;
  *'get deployments'*) echo "$FIXTURE_DEPLOYMENTS" ;;
  *get*) echo 'registry.example.invalid/backend:e82d71f91' ;;
esac
''',
                'bin/helm': '#!/usr/bin/env bash\nexit 0\n',
                'bin/python3': f'#!/usr/bin/env bash\nexec "{posix(sys.executable)}" "$@"\n',
                'deploy/aliyun/release-meet.sh': '#!/usr/bin/env bash\necho "release $*" >> "$FIXTURE_LOG"\n',
            }
            for name, text in scripts.items():
                file = root / name
                file.write_text(text, encoding='utf8', newline='\n')
                file.chmod(0o755)
            log = root / 'calls.log'
            overlay = root / 'src/helm/env.d/aliyun-prod/values.work.yaml'
            if initial is not None:
                overlay.write_text(json.dumps(initial), encoding='utf8')
            profile = yaml.safe_load((ROOT / 'src/helm/env.d/aliyun-prod/values.work.yaml.dist').read_text(encoding='utf8'))
            entries = [{'name': key, 'valueFrom' if isinstance(value, dict) else 'value': value}
                       for key, value in profile['backend']['envVars'].items()]
            deployment = {'metadata': {'generation': 1}, 'spec': {'replicas': 1, 'template': {'spec': {'containers': [{'env': entries}]}}},
                          'status': {'observedGeneration': 1, 'replicas': 1, 'updatedReplicas': 1, 'availableReplicas': 1}}
            env = dict(os.environ, FIXTURE_LOG=posix(log), FIXTURE_DENIED='1' if denied else '0',
                       FIXTURE_MODEL_DENIED='1' if model_denied else '0', FIXTURE_DEPLOYMENTS=json.dumps({'items': [deployment, deployment]}),
                       WORK_VALUES_FILE='src/helm/env.d/aliyun-prod/values.work.yaml')
            command = f'export PATH="{posix(root / "bin")}:$PATH"; exec bash "{posix(root / "deploy/aliyun/enable-work.sh")}" {mode}'
            result = subprocess.run([bash, '-c', command], env=env, capture_output=True, text=True, encoding='utf8')
            return result, log.read_text() if log.exists() else '', json.loads(overlay.read_text()) if overlay.exists() else None

    def test_check_never_writes_overlay_or_releases(self):
        result, log, overlay = self.execute('check')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(overlay)
        self.assertNotIn('release ', log)
        self.assertNotIn('--probe-storage', log)

    def test_probe_failure_stops_before_flags_or_release(self):
        result, log, overlay = self.execute('materials', denied=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(overlay)
        self.assertNotIn('release ', log)

    def test_cleanup_does_not_create_overlay_or_release(self):
        result, log, overlay = self.execute('cleanup _deployment-probes/' + 'a' * 32 + '.txt')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--cleanup-probe', log)
        self.assertNotIn('--probe-storage', log)
        self.assertNotIn('release ', log)
        self.assertIsNone(overlay)

    def test_enable_reuses_running_image_and_requires_worker(self):
        result, log, overlay = self.execute('materials')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('release --skip-git-pull --tag e82d71f91 backend', log)
        self.assertIn('--require-worker --require-materials', log)
        self.assertEqual(overlay['backend']['envVars']['WORK_COMMUNICATION_ENABLED'], 'False')
        self.assertEqual(overlay['backend']['envVars']['WORK_MATERIALS_ENABLED'], 'True')

    def test_off_keeps_worker_but_disables_work_writes(self):
        result, log, overlay = self.execute('off')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(overlay['workWorker']['enabled'])
        self.assertEqual(overlay['backend']['envVars']['WORK_ENABLED'], 'False')
        self.assertNotIn('--probe-storage', log)

    def profile(self):
        return yaml.safe_load((ROOT / 'src/helm/env.d/aliyun-prod/values.work.yaml.dist').read_text(encoding='utf8'))

    def test_prepare_binds_default_secret_without_enabling_or_calling_model(self):
        result, log, overlay = self.execute('prepare-communication')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(overlay['backend']['envVars']['WORK_MODEL'], 'qwen3.8-flash')
        self.assertEqual(overlay['backend']['envVars']['WORK_MODEL_API_KEY'], self.profile()['backend']['envVars']['WORK_MODEL_API_KEY'])
        self.assertEqual(overlay['backend']['envVars']['WORK_COMMUNICATION_ENABLED'], 'False')
        self.assertNotIn('exec -i deployment/meet-celery-work', log)
        self.assertIn('--require-model', log)

    def test_model_failure_keeps_communication_closed_without_release(self):
        initial = self.profile()
        result, log, overlay = self.execute('communication', initial=initial, model_denied=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(overlay, initial)
        self.assertNotIn('release ', log)

    def test_enable_requires_probe_before_release(self):
        result, log, overlay = self.execute('communication', initial=self.profile())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(log.index('exec -i deployment/meet-celery-work'), log.index('release '))
        self.assertEqual(overlay['backend']['envVars']['WORK_COMMUNICATION_ENABLED'], 'True')
        self.assertIn('--require-communication', log)

    def test_edited_model_cannot_use_probe_of_previous_deployment(self):
        initial = self.profile()
        initial['backend']['envVars']['WORK_MODEL'] = 'different-model'
        result, log, overlay = self.execute('communication', initial=initial)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('release ', log)
        self.assertNotIn('exec -i deployment/meet-celery-work', log)
        self.assertEqual(overlay, initial)

    def test_probe_only_never_releases_or_writes(self):
        result, log, overlay = self.execute('probe-model')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(overlay)
        self.assertNotIn('release ', log)
        self.assertIn('exec -i deployment/meet-celery-work', log)


if __name__ == '__main__':
    unittest.main()
