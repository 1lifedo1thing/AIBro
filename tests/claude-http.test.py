"""Real loopback HTTP + synthetic executable only; no user CLI or credentials."""
import http.client
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app'))
from claude_bridge import ClaudeBridge, REQUIRED_FLAGS

CLI = r'''
import json,os,pathlib,sys,time
root=pathlib.Path(__file__).parent
args=sys.argv[1:]
def out(value): print(json.dumps(value),flush=True)
def logged(): return (root/'logged-in').exists()
if '--help' in args:
 print(__FLAGS__);raise SystemExit()
if 'status' in args:
 out({'loggedIn':logged(),'authMethod':'claude.ai' if logged() else 'none','email':'PRIVATE_SYNTHETIC','token':'SECRET_SYNTHETIC','configDirectory':'PRIVATE_SYNTHETIC'});raise SystemExit(0 if logged() else 1)
if 'login' in args:
 print('SECRET_SYNTHETIC https://claude.ai/oauth?code=SECRET_SYNTHETIC',flush=True)
 print('SECRET_SYNTHETIC',file=sys.stderr)
 (root/'logged-in').write_text('synthetic')
 raise SystemExit()
if 'logout' in args:
 for file in root.glob('run-*.pid'):
  try: os.kill(int(file.read_text()),0)
  except ProcessLookupError: continue
  raise SystemExit(9)
 (root/'logged-in').unlink(missing_ok=True)
 print('SECRET_SYNTHETIC',flush=True);raise SystemExit()
assert '--print' in args and args[args.index('--tools')+1]==''
assert 'ANTHROPIC_API_KEY' not in os.environ and 'CLAUDE_CODE_OAUTH_TOKEN' not in os.environ
prompt=sys.stdin.read()
if prompt.startswith('silent'):
 (root/('run-'+str(os.getpid())+'.pid')).write_text(str(os.getpid()));time.sleep(20);raise SystemExit()
out({'type':'system','subtype':'init','session_id':'synthetic-session','tools':[],'mcp_servers':[],'permissionMode':'dontAsk'})
if prompt.startswith('hold'):
 (root/('run-'+str(os.getpid())+'.pid')).write_text(str(os.getpid()));time.sleep(20);raise SystemExit()
if prompt=='invalid':
 print('SECRET_SYNTHETIC');raise SystemExit(7)
out({'type':'assistant','session_id':'synthetic-session','message':{'id':'synthetic-message','content':[{'type':'text','text':'合成回复'}]}})
out({'type':'result','subtype':'success','session_id':'synthetic-session','is_error':False,'result':'合成回复'})
raise SystemExit(7 if prompt=='nonzero' else 0)
'''


def until(check, timeout=4):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check(): return
        time.sleep(.015)
    raise AssertionError('synthetic operation did not settle')


class ClaudeHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workspace = tempfile.TemporaryDirectory(prefix='aibro-claude-http-workspace-')
        with patch.dict(os.environ, {'AI_WORKSTATION_DATA_DIR': cls.workspace.name, 'AI_WORKSTATION_PORT': '0'}):
            spec = importlib.util.spec_from_file_location('synthetic_claude_server', ROOT / 'app/server.py')
            cls.module = importlib.util.module_from_spec(spec); spec.loader.exec_module(cls.module)

    @classmethod
    def tearDownClass(cls):
        cls.module.EXTERNAL_NOTIFICATIONS.close(); cls.workspace.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aibro-synthetic-claude-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.binary = self.root / 'claude'
        self.binary.write_text('#!' + sys.executable + '\n' + CLI.replace('__FLAGS__', repr(' '.join(REQUIRED_FLAGS))))
        self.binary.chmod(0o700)
        self.logged(True)
        self.bridge = ClaudeBridge(self.root, command=str(self.binary), environment={'HOME': str(self.root), 'PATH': '/usr/bin:/bin',
            'ANTHROPIC_API_KEY': 'SECRET_SYNTHETIC', 'CLAUDE_CODE_OAUTH_TOKEN': 'SECRET_SYNTHETIC'})
        self.addCleanup(self.bridge.close)
        outer = self
        class Handler(self.module.Handler):
            def log_message(self, *args): pass
        self.server = self.module.LoopbackHTTPServer(('127.0.0.1', 0), Handler)
        self.addCleanup(self.server.server_close); self.addCleanup(self.server.shutdown)
        replacement = patch.object(self.module, 'claude_service', lambda: outer.bridge)
        replacement.start(); self.addCleanup(replacement.stop)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.origin = 'http://127.0.0.1:' + str(self.server.server_port)

    def logged(self, yes):
        path = self.root / 'logged-in'
        if yes: path.write_text('synthetic')
        else: path.unlink(missing_ok=True)

    def call(self, path, payload=None, *, method=None, headers=None, raw=None, origin=True):
        method = method or ('GET' if payload is None and raw is None else 'POST')
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=8)
        fields = {'Content-Type': 'application/json'}
        if origin: fields['Origin'] = self.origin
        fields.update(headers or {})
        body = raw if raw is not None else json.dumps(payload) if payload is not None else None
        try:
            conn.request(method, path, body=body, headers=fields)
            response = conn.getresponse(); result = response.read()
            self.assertNotIn(b'SECRET_SYNTHETIC', result)
            self.assertNotIn(b'PRIVATE_SYNTHETIC', result)
            return response.status, json.loads(result)
        finally: conn.close()

    def stream(self, request_id, prompt):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=8)
        conn.request('POST', '/__claude/respond', json.dumps({'requestId': request_id, 'prompt': prompt}),
                     {'Content-Type': 'application/json', 'Origin': self.origin})
        response = conn.getresponse()
        self.assertEqual(response.status, 200)
        self.assertTrue(response.getheader('Content-Type').startswith('text/event-stream'))
        return conn, response

    def event(self, response):
        line = response.readline()
        self.assertTrue(line.startswith(b'data: '), line)
        self.assertEqual(response.readline(), b'\n')
        return json.loads(line[6:])

    def test_status_origin_get_referer_and_public_projection(self):
        code, state = self.call('/__claude/status')
        self.assertEqual(code, 200)
        self.assertEqual(state, {'available': True, 'loggedIn': True, 'authMethod': 'claude.ai', 'localCLIOnly': True, 'dynamicTools': False})
        self.assertEqual(self.call('/__claude/status', origin=False)[0], 403)
        self.assertEqual(self.call('/__claude/status', origin=False, headers={'Referer': self.origin + '/?synthetic'})[0], 200)
        for fields in ({'Origin':'https://hostile.invalid'}, {'Origin':'null'}, {'Sec-Fetch-Site':'cross-site'}, {'Host':'hostile.invalid'}):
            self.assertEqual(self.call('/__claude/status', headers=fields)[0], 403)
        self.assertEqual(self.call('/__claude/status', origin=False, headers={'Referer':'https://hostile.invalid/'})[0], 403)

    def test_strict_json_fields_methods_and_no_external_login(self):
        for path in ('login', 'cancel', 'logout', 'respond'):
            self.assertEqual(self.call('/__claude/' + path, {}, headers={'Origin':'https://hostile.invalid'})[0], 403)
            self.assertEqual(self.call('/__claude/' + path, {}, origin=False, headers={'Referer': self.origin + '/'})[0], 403)
        cases = [('/__claude/login', {'requestId':'x','command':'/tmp/no'}), ('/__claude/login', {'requestId':'../bad'}),
                 ('/__claude/logout', {'confirmation':1}), ('/__claude/respond', {'requestId':'x','prompt':'hi','tools':[]}),
                 ('/__claude/respond', {'requestId':'x','prompt':'hi','model':None}), ('/__claude/respond', {'requestId':'x','prompt':'\u0000'}),
                 ('/__claude/respond', {'requestId':'x','prompt':'a' * (1024 * 1024 + 1)})]
        for path, body in cases: self.assertEqual(self.call(path, body)[0], 400)
        self.assertEqual(self.call('/__claude/login', raw='{"requestId":"a","requestId":"b"}')[0], 400)
        self.assertEqual(self.call('/__claude/login', raw='{"requestId":NaN}')[0], 400)
        self.assertEqual(self.call('/__claude/login?x=1', {'requestId':'x'})[0], 400)
        self.assertEqual(self.call('/__claude/login', {'requestId':'x'}, headers={'Content-Type':'text/plain'})[0], 400)
        self.assertEqual(self.call('/__claude/login', method='GET')[0], 405)
        self.assertEqual(self.call('/__claude/status', {})[0], 405)
        self.assertEqual(self.call('/__claude/status?x=1')[0], 400)
        self.assertEqual(self.call('/__claude/operation?requestId=a&requestId=b')[0], 400)
        self.assertEqual(self.call('/__claude/operation?requestId=a#ignored')[0], 400)
        self.assertEqual(self.call('/__claude/operation?requestId=missing')[0], 404)
        self.assertEqual(self.bridge.jobs, {})

    def test_explicit_login_status_operation_logout_and_duplicate_id(self):
        self.logged(False)
        self.assertFalse(self.call('/__claude/status')[1]['loggedIn'])
        code, result = self.call('/__claude/login', {'requestId':'synthetic-login'})
        self.assertEqual((code, result['status']), (200, 'started'))
        until(lambda: self.bridge.operation_status('synthetic-login')['status'] != 'running')
        self.assertEqual(self.call('/__claude/operation?requestId=synthetic-login')[1]['status'], 'completed')
        self.assertTrue(self.call('/__claude/status')[1]['loggedIn'])
        self.assertEqual(self.call('/__claude/login', {'requestId':'synthetic-login'})[0], 409)
        self.assertFalse(self.call('/__claude/cancel', {'requestId':'synthetic-login'})[1]['cancelled'])
        self.assertEqual(self.call('/__claude/logout', {'confirmation':True})[1]['authMethod'], 'none')

    def test_stream_success_and_nonzero_exit_never_claims_done(self):
        for request_id, prompt in (('success', 'hello'), ('bad-exit', 'nonzero'), ('bad-json', 'invalid')):
            conn, response = self.stream(request_id, prompt)
            try:
                raw = response.read(); self.assertNotIn(b'SECRET_SYNTHETIC', raw)
                events = [json.loads(line[6:]) for line in raw.splitlines() if line.startswith(b'data: ')]
                self.assertTrue(all(event['requestId'] == request_id for event in events))
                self.assertEqual(events[0]['type'], 'started')
                if prompt == 'hello': self.assertEqual([event['type'] for event in events], ['started','text','done'])
                else:
                    self.assertEqual(events[-1]['type'], 'error')
                    self.assertNotIn('done', [event['type'] for event in events])
            finally: response.close(); conn.close()

    def test_duplicate_stream_and_late_cancel_do_not_cancel_other_request(self):
        first, response = self.stream('active-A', 'hold-A')
        self.assertEqual(self.event(response)['type'], 'started')
        duplicate, duplicate_response = self.stream('active-A', 'hello')
        try:
            result = self.event(duplicate_response)
            self.assertEqual((result['type'], result['code']), ('error', 'duplicate_request'))
            duplicate_response.read()
        finally: duplicate_response.close(); duplicate.close()
        self.assertEqual(self.bridge.operation_status('active-A')['status'], 'running')
        second, second_response = self.stream('active-B', 'hold-B')
        self.assertEqual(self.event(second_response)['type'], 'started')
        self.assertTrue(self.call('/__claude/cancel', {'requestId':'active-A'})[1]['cancelled'])
        until(lambda: self.bridge.operation_status('active-A')['status'] == 'cancelled')
        self.assertFalse(self.call('/__claude/cancel', {'requestId':'active-A'})[1]['cancelled'])
        self.assertEqual(self.bridge.operation_status('active-B')['status'], 'running')
        self.assertTrue(self.call('/__claude/cancel', {'requestId':'active-B'})[1]['cancelled'])
        for c, r in ((first,response),(second,second_response)):
            r.read(); r.close(); c.close()

    def test_disconnect_before_first_event_reaps_only_owned_process(self):
        conn, response = self.stream('silent-disconnect', 'silent')
        until(lambda: bool(list(self.root.glob('run-*.pid'))))
        pids = [int(p.read_text()) for p in self.root.glob('run-*.pid')]
        response.close(); conn.close()
        until(lambda: self.bridge.operation_status('silent-disconnect')['status'] == 'cancelled')
        for pid in pids:
            with self.assertRaises(ProcessLookupError): os.kill(pid, 0)

    def test_logout_cancels_and_reaps_active_stream_before_auth_mutation(self):
        conn, response = self.stream('logout-active', 'hold')
        self.assertEqual(self.event(response)['type'], 'started')
        until(lambda: bool(list(self.root.glob('run-*.pid'))))
        code, result = self.call('/__claude/logout', {'confirmation':True})
        self.assertEqual((code, result['loggedIn']), (200, False))
        self.assertEqual(self.bridge.operation_status('logout-active')['status'], 'cancelled')
        response.read(); response.close(); conn.close()
        conn, response = self.stream('logged-out', 'hello')
        try:
            self.assertEqual(self.event(response)['code'], 'subscription_login_required')
            response.read()
        finally: response.close(); conn.close()


if __name__ == '__main__': unittest.main()
