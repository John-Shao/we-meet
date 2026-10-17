"""Real HTTP/PostgreSQL/process-loss check; streaming itself is a controlled stand-in."""
import argparse
import asyncio
from datetime import timedelta
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'build/bilingual-usage-validation'
TOKEN = 'offline-durable-usage-fixture'


def setup_django():
    sys.path.insert(0, str(ROOT / 'src/backend'))
    from configurations import importer
    importer.install()
    import django
    django.setup()
    from django.conf import settings
    settings.ASSISTANT_TRANSLATION_ENABLED = True
    settings.AGENT_INTERNAL_API_TOKEN = TOKEN
    settings.ALLOWED_HOSTS = ['127.0.0.1', 'testserver']
    from core.services import bilingual_sessions
    bilingual_sessions.HEARTBEAT_SECONDS = 5


def backend_child():
    setup_django()
    from django.core.wsgi import get_wsgi_application
    from wsgiref.simple_server import make_server, WSGIRequestHandler
    class QuietHandler(WSGIRequestHandler):
        def log_message(self, *args):
            pass
    server = make_server('127.0.0.1', 0, get_wsgi_application(), handler_class=QuietHandler)
    print(json.dumps({'port': server.server_port}), flush=True)
    server.serve_forever()


async def gateway_child():
    from unittest.mock import AsyncMock
    from translation.assistant_gateway import AssistantTranslationConnection
    payload = json.loads(sys.stdin.readline())
    connection = AssistantTranslationConnection(AsyncMock())
    async def controlled_stream(grant):
        # The real gateway heartbeat/close and authenticated backend API run.
        # No ASR, audio device or paid supplier is opened by this control-plane test.
        for _ in range(6 if payload['finish'] else 30):
            connection.input_bytes += 3200
            await connection.emit({'type':'translation','text':'controlled fixture'})
            await asyncio.sleep(1)
    connection._serve = controlled_stream
    await connection.run({'type':'assistant_translation','ticket':payload['ticket']})


def parent():
    sys.path.insert(0, str(ROOT / 'scripts'))
    from test_bilingual_backend import isolated_backend
    children = []
    report = {'scope':'Real internal HTTP API and PostgreSQL across forced gateway/backend process termination; controlled stream counters only',
              'real_supplier':False,'real_audio':False,'raw_text_or_credentials_exported':False}
    BASE.mkdir(parents=True,exist_ok=True)
    try:
        with isolated_backend():
            setup_django()
            from django.conf import settings
            from django.core.management import call_command
            from django.core import signing
            from django.utils import timezone
            from core.factories import UserFactory
            from core.models import BilingualSession
            from core.services import bilingual_sessions
            call_command('migrate', interactive=False, verbosity=0)
            user = UserFactory()
            since = (timezone.now()-timedelta(seconds=1)).isoformat()
            def start_backend():
                process=subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'--backend-child'],
                    cwd=ROOT/'src/backend',stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
                children.append(process)
                port=json.loads(process.stdout.readline())['port']
                return process,port
            def start_gateway(port, row, finish):
                ticket=signing.dumps({'user':str(user.pk),'session_id':str(row.pk),
                    'source_language':'zh','target_language':'en','protocol_version':2,
                    'fixed_source':'zh','voice':'Tina','max_seconds':900,'idle_seconds':300},salt='assistant-translation-v1')
                env=os.environ.copy();env.update(PYTHONPATH=str(ROOT/'src/agents/src'),
                    AGENT_BACKEND_API_URL='http://127.0.0.1:'+str(port),AGENT_INTERNAL_API_TOKEN=TOKEN)
                process=subprocess.Popen([str(ROOT/'src/agents/.venv/Scripts/python.exe'),str(Path(__file__).resolve()),'--gateway-child'],
                    stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,text=True,env=env)
                children.append(process);process.stdin.write(json.dumps({'ticket':ticket,'finish':finish})+'\n');process.stdin.flush();process.stdin.close()
                return process
            backend,port=start_backend()
            first=bilingual_sessions.reserve(user)
            gateway=start_gateway(port,first,False)
            deadline=time.monotonic()+20
            while time.monotonic()<deadline:
                first.refresh_from_db()
                if first.usage.get('input_bytes',0)>0:break
                if gateway.poll() is not None:raise RuntimeError('Controlled gateway exited before durable checkpoint')
                time.sleep(.25)
            assert first.usage.get('input_bytes',0)>0 and not first.usage['complete']
            checkpoint=first.usage.copy()
            gateway.kill();gateway.wait(timeout=10)
            backend.kill();backend.wait(timeout=10)
            first.refresh_from_db();assert first.usage==checkpoint
            # A replacement API process uses the same external validation database.
            backend,port=start_backend()
            BilingualSession.objects.filter(pk=first.pk).update(lease_until=timezone.now()-timedelta(seconds=1))
            second=bilingual_sessions.reserve(user)
            finished=start_gateway(port,second,True);assert finished.wait(timeout=20)==0
            second.refresh_from_db();first.refresh_from_db()
            assert second.usage['complete'] and second.status=='closed'
            assert first.status=='expired' and first.usage==checkpoint
            result=subprocess.run([sys.executable,'manage.py','report_bilingual_usage','--since',since],
                                  cwd=ROOT/'src/backend',capture_output=True,text=True)
            assert result.returncode==0,'Fresh process export failed; raw output withheld'
            exported=json.loads(result.stdout)
            assert exported['partial']['sessions']==exported['complete']['sessions']==1
            assert exported['partial']['input_bytes']==checkpoint['input_bytes']
            assert exported['complete']['input_bytes']==second.usage['input_bytes']
            report.update(passed=True,gateway_forcibly_terminated=True,backend_forcibly_terminated=True,
                replacement_api_process_verified=True,fresh_export_process_verified=True,
                partial=checkpoint,complete=second.usage,exported=exported)
    finally:
        for process in children:
            if process.poll() is None:process.kill();process.wait(timeout=10)
        (BASE/'durable-usage-process-loss-20261017.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'passed':report.get('passed',False),'partial_input_bytes':report.get('partial',{}).get('input_bytes'),
                      'complete_input_bytes':report.get('complete',{}).get('input_bytes')}),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--backend-child',action='store_true');parser.add_argument('--gateway-child',action='store_true')
    args=parser.parse_args()
    if args.backend_child:backend_child()
    elif args.gateway_child:asyncio.run(gateway_child())
    else:parent()
