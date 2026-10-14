"""Synthetic protocol tests only: never start claude/auth/login/model requests."""
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from claude_bridge import (BridgeError, ClaudeBridge, REQUIRED_FLAGS, StreamJSONAdapter,
                           SubprocessRunner, clean_environment, runtime_command)


def event(kind, **fields):
    return {'type': 'stream_event', 'session_id': 'session-test', 'parent_tool_use_id': None,
            'event': {'type': kind, **fields}}


def complete():
    return {'type': 'result', 'subtype': 'success', 'is_error': False,
            'session_id': 'session-test', 'result': '合成答案'}


def init():
    return {'type': 'system', 'subtype': 'init', 'session_id': 'session-test',
            'tools': [], 'mcp_servers': [], 'permissionMode': 'dontAsk'}


def sequence(assistant_before_stop=False):
    answer = {'type': 'assistant', 'session_id': 'session-test', 'message': {
        'id': 'msg-test', 'content': [{'type': 'text', 'text': '合成答案'}]}}
    result = [
        {'type': 'system', 'subtype': 'init', 'session_id': 'session-test',
         'tools': [], 'mcp_servers': [], 'permissionMode': 'dontAsk'},
        event('message_start', message={'id': 'msg-test'}),
        event('content_block_start', index=0, content_block={'type': 'text', 'text': ''}),
        event('content_block_delta', index=0, delta={'type': 'text_delta', 'text': '合成'}),
        event('content_block_delta', index=0, delta={'type': 'text_delta', 'text': '答案'}),
        event('content_block_stop', index=0)]
    return result + ([answer, event('message_stop')] if assistant_before_stop else [event('message_stop'), answer]) + [complete()]


class FakeRunner:
    def __init__(self, messages=None, *, auth=None, exit_code=0):
        self.messages = sequence() if messages is None else messages
        self.auth = {'loggedIn': True, 'authMethod': 'claude.ai'} if auth is None else auth
        self.exit_code = exit_code
        self.calls = []
        self.help = ' '.join(REQUIRED_FLAGS)
        self.login_started = threading.Event()
        self.login_release = threading.Event()

    def run(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        callback = kwargs['on_line']
        if argv[-1] == '--help':
            callback(self.help)
            return 0
        if 'status' in argv:
            callback(json.dumps(self.auth))
            return 0 if self.auth.get('loggedIn') else 1
        if 'login' in argv:
            callback('SYNTHETIC_LOGIN_CODE_DO_NOT_RETURN https://claude.ai/oauth?code=synthetic\n')
            self.login_started.set()
            while not self.login_release.wait(.005):
                if kwargs['cancel'].is_set():
                    raise BridgeError('cancelled', '已停止 Claude Code 操作。')
            return self.exit_code
        for item in self.messages:
            callback(json.dumps(item, ensure_ascii=False) + '\n')
        return self.exit_code


class ClaudeBridgeTests(unittest.TestCase):
    def bridge(self, runner=None):
        return ClaudeBridge(tempfile.gettempdir(), command='/synthetic/claude', runner=runner or FakeRunner(),
                            environment={'HOME': '/synthetic/home', 'PATH': '/usr/bin',
                                         'ANTHROPIC_API_KEY': 'DO_NOT_COPY',
                                         'CLAUDE_CODE_OAUTH_TOKEN': 'DO_NOT_COPY'})

    def assert_code(self, expected, call):
        with self.assertRaises(BridgeError) as caught:
            call()
        self.assertEqual(caught.exception.code, expected)
        self.assertNotIn('SYNTHETIC_LOGIN_CODE', str(caught.exception))

    def test_construction_is_inert_and_status_is_strict_whitelist(self):
        runner = FakeRunner(auth={'loggedIn': True, 'authMethod': 'claude.ai',
                                 'accessToken': 'DO_NOT_RETURN', 'email': 'private@example.invalid',
                                 'configDirectory': '/private/claude', 'subscriptionType': 'max'})
        bridge = self.bridge(runner)
        self.assertEqual(runner.calls, [])
        self.assertEqual(bridge.status(), {'loggedIn': True, 'authMethod': 'claude.ai',
                                          'localCLIOnly': True, 'dynamicTools': False})
        self.assertEqual(runner.calls[1][0][-3:], ['auth', 'status', '--json'])

    def test_unlogged_status_and_unknown_auth_are_not_success(self):
        self.assertFalse(self.bridge(FakeRunner(auth={'loggedIn': False, 'authMethod': 'none'})).status()['loggedIn'])
        self.assert_code('unsupported_protocol', lambda: self.bridge(FakeRunner(auth={'loggedIn': 'true', 'authMethod': 'claude.ai'})).status())
        self.assert_code('unsupported_protocol', lambda: self.bridge(FakeRunner(auth={'loggedIn': True, 'authMethod': 'new-auth'})).status())

    def test_missing_isolation_flag_fails_without_auth_or_model(self):
        runner = FakeRunner()
        runner.help = runner.help.replace('--safe-mode', '')
        self.assert_code('unsupported_cli', self.bridge(runner).status)
        self.assertEqual(len(runner.calls), 1)

    def test_actual_argv_has_no_tools_bypass_or_prompt_and_no_auth_env(self):
        runner, events = FakeRunner(), []
        bridge = self.bridge(runner)
        result = bridge.print_stream('req-test', 'PRIVATE_PROMPT_ONLY_STDIN', events.append)
        argv, kwargs = runner.calls[-1]
        self.assertNotIn('PRIVATE_PROMPT_ONLY_STDIN', argv)
        self.assertEqual(kwargs['stdin'], 'PRIVATE_PROMPT_ONLY_STDIN')
        self.assertEqual(argv[argv.index('--tools') + 1], '')
        self.assertEqual(argv[argv.index('--permission-mode') + 1], 'dontAsk')
        self.assertEqual(argv[argv.index('--setting-sources') + 1], '')
        for flag in ('--safe-mode', '--strict-mcp-config', '--no-session-persistence'):
            self.assertIn(flag, argv)
        self.assertFalse(any('bypass' in item.lower() or 'dangerously' in item for item in argv))
        self.assertEqual(kwargs['env'], {'HOME': '/synthetic/home', 'PATH': '/usr/bin'})
        self.assertEqual(''.join(e['text'] for e in events if e['type'] == 'text'), '合成答案')
        self.assertEqual(result['type'], 'done')
        self.assertEqual(events[-1]['type'], 'done')
        self.assertEqual(bridge.operation_status('req-test')['status'], 'completed')

    def test_snapshot_before_message_stop_does_not_duplicate_text(self):
        events = []
        self.bridge(FakeRunner(sequence(True))).print_stream('req-test', '合成', events.append)
        self.assertEqual(''.join(e['text'] for e in events if e['type'] == 'text'), '合成答案')

    def test_official_api_or_token_auth_cannot_be_mislabelled_subscription(self):
        for method in ('api_key', 'api_key_helper', 'oauth_token', 'third_party', 'none'):
            runner = FakeRunner(auth={'loggedIn': method != 'none', 'authMethod': method})
            self.assert_code('subscription_login_required', lambda: self.bridge(runner).print_stream('req', '合成', lambda _: None))
            self.assertFalse(any('--print' in argv for argv, _ in runner.calls))

    def test_dynamic_tools_rejected_before_any_process(self):
        runner = FakeRunner()
        self.assert_code('unsupported_dynamic_tools', lambda: self.bridge(runner).print_stream('req', '合成', lambda _: None, tools=[{'name': 'save'}]))
        self.assertEqual(runner.calls, [])

    def test_unknown_protocol_and_control_requests_fail_closed(self):
        for message in ({'type': 'control_request', 'request': {'subtype': 'can_use_tool'}},
                        {'type': 'new_future_protocol'}, event('future_event')):
            events = []
            self.assert_code('unsupported_protocol', lambda: self.bridge(FakeRunner([init(), message])).print_stream('req', '合成', events.append))
            self.assertFalse(any(e['type'] == 'done' for e in events))

    def test_runtime_tools_mcp_or_permission_bypass_rejected(self):
        for field in ({'tools': ['Read']}, {'mcp_servers': [{'name': 'outside'}]}, {'permissionMode': 'bypassPermissions'}):
            message = {**init(), **field}
            with self.assertRaises(BridgeError):
                self.bridge(FakeRunner([message])).print_stream('req', '合成', lambda _: None)

    def test_failure_missing_result_and_nonzero_exit_never_emit_done(self):
        cases = [(sequence()[:-1], 0, 'incomplete_stream'), (sequence(), 1, 'cli_failed'),
                 ([init(), {'type': 'result', 'subtype': 'error_during_execution', 'is_error': True,
                    'errors': ['SYNTHETIC_LOGIN_CODE token=not-public']}], 1, 'model_error')]
        for messages, code, expected in cases:
            events = []
            self.assert_code(expected, lambda: self.bridge(FakeRunner(messages, exit_code=code)).print_stream('req', '合成', events.append))
            self.assertFalse(any(e['type'] == 'done' for e in events))
            self.assertNotIn('SYNTHETIC_LOGIN_CODE', json.dumps(events))

    def test_reasoning_is_observation_not_raw_thinking_or_signature(self):
        events = []
        parser = StreamJSONAdapter(events.append)
        for item in [init(), event('message_start', message={'id': 'thinking-msg'}),
                     event('content_block_start', index=0, content_block={'type': 'thinking', 'thinking': ''}),
                     event('content_block_delta', index=0, delta={'type': 'thinking_delta', 'thinking': 'PRIVATE_REASONING'}),
                     event('content_block_delta', index=0, delta={'type': 'signature_delta', 'signature': 'PRIVATE_SIGNATURE'}),
                     event('content_block_stop', index=0), event('message_stop'), complete()]:
            parser.line(json.dumps(item))
        parser.finish()
        self.assertTrue(any(e['type'] == 'reasoning' for e in events))
        self.assertNotIn('PRIVATE_', json.dumps(events))

    def test_observed_tool_input_and_result_ids_and_errors_are_distinct(self):
        events = []
        parser = StreamJSONAdapter(events.append, allow_tools=True)
        blocks = [init(), event('message_start', message={'id': 'tool-msg'}),
                  event('content_block_start', index=0, content_block={'type': 'tool_use', 'id': 'tool-1', 'name': 'mcp__fixture__read', 'input': {}}),
                  event('content_block_delta', index=0, delta={'type': 'input_json_delta', 'partial_json': '{"id":'}),
                  event('content_block_delta', index=0, delta={'type': 'input_json_delta', 'partial_json': '"synthetic"}'}),
                  event('content_block_stop', index=0), event('message_stop'),
                  {'type': 'assistant', 'message': {'id': 'tool-msg', 'content': [{'type': 'tool_use', 'id': 'tool-1', 'name': 'mcp__fixture__read', 'input': {'id': 'synthetic'}}]}},
                  {'type': 'user', 'message': {'content': [{'type': 'tool_result', 'tool_use_id': 'tool-1', 'content': [{'type': 'text', 'text': 'not found'}], 'is_error': True}]}}, complete()]
        for item in blocks:
            parser.line(json.dumps(item))
        self.assertEqual([e['type'] for e in events][1:4], ['tool_start', 'tool_input', 'tool_result'])
        self.assertEqual(events[2]['input'], {'id': 'synthetic'})
        self.assertTrue(events[3]['isError'])
        self.assertEqual(parser.finish()['type'], 'done')

    def test_partial_tool_json_unknown_result_and_incomplete_blocks_rejected(self):
        for items in ([event('message_start', message={'id': 't'}), event('content_block_start', index=0, content_block={'type': 'tool_use', 'id': 't1', 'name': 'read'}), event('content_block_delta', index=0, delta={'type': 'input_json_delta', 'partial_json': '{'}), event('content_block_stop', index=0)],
                      [{'type': 'user', 'message': {'content': [{'type': 'tool_result', 'tool_use_id': 'unknown', 'content': 'x'}]}}],
                      [event('message_start', message={'id': 't'}), complete()]):
            parser = StreamJSONAdapter(lambda _: None, allow_tools=True)
            with self.assertRaises(BridgeError):
                for item in [init(), *items]:
                    parser.line(json.dumps(item))

    def test_cancel_stops_late_stream_output_and_marks_cancelled(self):
        bridge, events = self.bridge(), []
        def callback(item):
            events.append(item)
            if item['type'] == 'text':
                bridge.cancel('cancel-print')
        self.assert_code('cancelled', lambda: bridge.print_stream('cancel-print', '合成', callback))
        self.assertEqual(''.join(e['text'] for e in events if e['type'] == 'text'), '合成')
        self.assertEqual(events[-1]['type'], 'cancelled')
        self.assertEqual(bridge.operation_status('cancel-print')['status'], 'cancelled')
        self.assertFalse(bridge.cancel('cancel-print'))

    def test_login_only_explicit_start_never_returns_raw_codes_and_can_cancel(self):
        runner = FakeRunner()
        bridge = self.bridge(runner)
        response = bridge.login_start('login-1')
        self.assertTrue(runner.login_started.wait(1))
        self.assertTrue(bridge.cancel('login-1'))
        for _ in range(100):
            status = bridge.operation_status('login-1')
            if status['status'] != 'running':
                break
            time.sleep(.005)
        self.assertEqual(status['status'], 'cancelled')
        self.assertNotIn('SYNTHETIC_LOGIN_CODE', json.dumps([response, status]))
        self.assertFalse(any('logout' in argv or 'setup-token' in argv for argv, _ in runner.calls))

    def test_real_runner_uses_stdin_and_success_does_not_set_cancel(self):
        cancel, lines = threading.Event(), []
        code = SubprocessRunner().run([sys.executable, '-c', 'import sys; print(sys.stdin.read())'],
                                     cwd=tempfile.gettempdir(), env=clean_environment(), stdin='合成输入',
                                     cancel=cancel, timeout=2, on_line=lines.append)
        self.assertEqual(code, 0)
        self.assertEqual(''.join(lines).strip(), '合成输入')
        self.assertFalse(cancel.is_set())

    def test_real_runner_timeout_and_cancel_reap_owned_process(self):
        with tempfile.TemporaryDirectory() as directory:
            pidfile = str(Path(directory) / 'pid')
            script = 'import os,time,pathlib; pathlib.Path(' + repr(pidfile) + ').write_text(str(os.getpid())); time.sleep(10)'
            for explicit_cancel in (False, True):
                cancel = threading.Event()
                if explicit_cancel:
                    threading.Timer(.15, cancel.set).start()
                expected = 'cancelled' if explicit_cancel else 'timeout'
                self.assert_code(expected, lambda: SubprocessRunner().run([sys.executable, '-c', script], cwd=directory,
                    env=clean_environment(), stdin='', cancel=cancel, timeout=.4, on_line=lambda _: None))
                pid = int(Path(pidfile).read_text())
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)

    def test_cancelled_before_start_never_spawns_process(self):
        with tempfile.TemporaryDirectory() as directory:
            output = str(Path(directory) / 'must-not-exist')
            cancel = threading.Event()
            cancel.set()
            self.assert_code('cancelled', lambda: SubprocessRunner().run([sys.executable, '-c',
                'from pathlib import Path; Path(' + repr(output) + ').write_text("started")'], cwd=directory,
                env=clean_environment(), stdin='', cancel=cancel, timeout=2, on_line=lambda _: None))
            self.assertFalse(Path(output).exists())

    def test_group_child_is_stopped_even_after_leader_exits(self):
        with tempfile.TemporaryDirectory() as directory:
            heartbeat = str(Path(directory) / 'child-heartbeat')
            child = 'import time,pathlib,signal; signal.signal(signal.SIGTERM,signal.SIG_IGN); p=pathlib.Path(' + repr(heartbeat) + ');\nwhile True:\n p.write_text(str(time.monotonic())); time.sleep(.02)'
            parent = 'import subprocess,sys; subprocess.Popen([sys.executable,"-c",' + repr(child) + '])'
            self.assert_code('timeout', lambda: SubprocessRunner().run([sys.executable, '-c', parent], cwd=directory,
                env=clean_environment(), stdin='', cancel=threading.Event(), timeout=.4, on_line=lambda _: None))
            self.assertTrue(Path(heartbeat).exists())
            before = Path(heartbeat).read_text()
            time.sleep(.08)
            self.assertEqual(Path(heartbeat).read_text(), before)

    def test_real_runner_discards_stderr_secrets_and_terminates_on_parser_error(self):
        lines = []
        code = SubprocessRunner().run([sys.executable, '-c', 'import sys; print("SYNTHETIC_LOGIN_CODE",file=sys.stderr); print("ok")'],
                                     cwd=tempfile.gettempdir(), env=clean_environment(), stdin='', cancel=threading.Event(), timeout=2, on_line=lines.append)
        self.assertEqual(code, 0)
        self.assertEqual(lines, ['ok\n'])
        self.assert_code('unsupported_protocol', lambda: SubprocessRunner().run([sys.executable, '-c', 'print("invalid json")'],
            cwd=tempfile.gettempdir(), env=clean_environment(), stdin='', cancel=threading.Event(), timeout=2,
            on_line=StreamJSONAdapter(lambda _: None).line))


class ClaudeBridgeReviewRegressionTests(unittest.TestCase):
    bridge = ClaudeBridgeTests.bridge
    assert_code = ClaudeBridgeTests.assert_code
    # Only these named methods need to run for the new review counterexamples.
    def test_review_blocked_callback_does_not_block_cancel_or_late_text(self):
        bridge, events = self.bridge(), []
        entered, release, exited = threading.Event(), threading.Event(), threading.Event()
        result = []
        def callback(item):
            events.append(item)
            if item['type'] == 'text':
                entered.set(); release.wait(2)
        def work():
            try: bridge.print_stream('blocked', '合成', callback, timeout=.4)
            except BridgeError as error: result.append(error.code)
            finally: exited.set()
        thread = threading.Thread(target=work, daemon=True); thread.start()
        try:
            self.assertTrue(entered.wait(1))
            cancelled = threading.Event()
            cancel_thread = threading.Thread(target=lambda: (bridge.cancel('blocked'), cancelled.set()), daemon=True)
            cancel_thread.start()
            self.assertTrue(cancelled.wait(.15), 'external callback must not own the state lock')
            self.assertTrue(exited.wait(.3), 'callback cannot prevent process cancellation/return')
            self.assertEqual(result, ['cancelled'])
        finally:
            release.set(); thread.join(1)
        self.assertEqual(''.join(e['text'] for e in events if e['type'] == 'text'), '合成')
        self.assertFalse(any(e['type'] == 'done' for e in events))

    def test_review_blocked_callback_timeout_returns_without_waiting_for_callback(self):
        bridge = self.bridge()
        entered, release, exited = threading.Event(), threading.Event(), threading.Event()
        result = []
        def callback(item):
            if item['type'] == 'text': entered.set(); release.wait(2)
        def work():
            try: bridge.print_stream('blocked-timeout', '合成', callback, timeout=.12)
            except BridgeError as error: result.append(error.code)
            finally: exited.set()
        thread = threading.Thread(target=work, daemon=True); thread.start()
        try:
            self.assertTrue(entered.wait(1))
            self.assertTrue(exited.wait(.35), 'timeout must advance independently of callback')
            self.assertEqual(result, ['timeout'])
        finally:
            release.set(); thread.join(1)

    def test_review_cancel_reaps_actual_process_while_callback_remains_blocked(self):
        with tempfile.TemporaryDirectory() as directory:
            pidfile = str(Path(directory) / 'synthetic-stream.pid')
            script = ('import os,time,pathlib; pathlib.Path(' + repr(pidfile) + ').write_text(str(os.getpid())); '
                      'print(' + repr('\n'.join(json.dumps(item) for item in sequence())) + ',flush=True); time.sleep(10)')
            class Runner(FakeRunner):
                def run(self, argv, **kwargs):
                    if '--print' not in argv: return super().run(argv, **kwargs)
                    return SubprocessRunner().run([sys.executable, '-c', script], **kwargs)
            bridge = self.bridge(Runner())
            entered, release, exited = threading.Event(), threading.Event(), threading.Event()
            events, result = [], []
            def callback(item):
                events.append(item)
                if item['type'] == 'text': entered.set(); release.wait(3)
            def work():
                try: bridge.print_stream('actual-blocked', '合成', callback, timeout=2)
                except BridgeError as error: result.append(error.code)
                finally: exited.set()
            thread = threading.Thread(target=work, daemon=True); thread.start()
            try:
                self.assertTrue(entered.wait(1))
                self.assertTrue(bridge.cancel('actual-blocked'))
                self.assertTrue(exited.wait(.7))
                with self.assertRaises(ProcessLookupError): os.kill(int(Path(pidfile).read_text()), 0)
                self.assertEqual(result, ['cancelled'])
                self.assertEqual(''.join(e['text'] for e in events if e['type'] == 'text'), '合成')
            finally:
                release.set(); thread.join(1)

    def test_review_completed_stream_message_id_replay_is_rejected_before_duplicate_text(self):
        messages = sequence()[:-1]
        messages += sequence()[1:7] + [complete()]
        events = []
        self.assert_code('unsupported_protocol', lambda: self.bridge(FakeRunner(messages)).print_stream('replay', '合成', events.append))
        self.assertEqual(''.join(e['text'] for e in events if e['type'] == 'text'), '合成答案')
        self.assertFalse(any(e['type'] == 'done' for e in events))

    def test_review_missing_duplicate_init_and_result_only_are_rejected(self):
        for messages in (sequence()[1:], [complete()], [init(), complete()], [init()] + sequence()):
            events = []
            self.assert_code('unsupported_protocol', lambda: self.bridge(FakeRunner(messages)).print_stream('init-case', '合成', events.append))
            self.assertFalse(any(e['type'] == 'done' for e in events))

    def test_review_permission_mode_must_be_exact_dont_ask(self):
        for mode in (None, '', 'default', 'manual', 'plan', 'future-mode', False):
            first = init()
            if mode is None: first.pop('permissionMode')
            else: first['permissionMode'] = mode
            self.assert_code('unsafe_runtime', lambda: self.bridge(FakeRunner([first] + sequence()[1:])).print_stream('mode', '合成', lambda _: None))

    def test_review_divergent_or_shortened_result_cannot_complete(self):
        for body in ('错误答案', '合成', '', None, 12):
            final = {**complete(), 'result': body}
            events = []
            self.assert_code('unsupported_protocol', lambda: self.bridge(FakeRunner(sequence()[:-1] + [final])).print_stream('body-case', '合成', events.append))
            self.assertFalse(any(e['type'] == 'done' for e in events))

    def test_review_final_result_can_only_append_verified_prefix_suffix(self):
        events = []
        final = {**complete(), 'result': '合成答案，已补全。'}
        self.bridge(FakeRunner(sequence()[:-1] + [final])).print_stream('suffix', '合成', events.append)
        self.assertEqual(''.join(e['text'] for e in events if e['type'] == 'text'), final['result'])
        self.assertEqual(events[-1]['type'], 'done')


class ClaudeAccountLifecycleTests(unittest.TestCase):
    bridge = ClaudeBridgeTests.bridge
    assert_code = ClaudeBridgeTests.assert_code

    def test_gui_discovery_uses_fixed_home_install_and_is_inert(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / '.local/bin/claude'
            binary.parent.mkdir(parents=True)
            binary.write_text('#!/bin/sh\nexit 99\n'); binary.chmod(0o700)
            env = {'HOME': directory, 'PATH': '/usr/bin:/bin'}
            self.assertEqual(runtime_command(env), str(binary))
            runner = FakeRunner()
            bridge = ClaudeBridge(directory, runner=runner, environment=env)
            self.assertEqual(runner.calls, [])
            bridge.status()
            self.assertTrue(all(argv[0] == str(binary) for argv, _ in runner.calls))
            preferred = Path(directory) / 'selected-bin/claude'
            preferred.parent.mkdir(); preferred.write_text('#!/bin/sh\nexit 98\n'); preferred.chmod(0o700)
            self.assertEqual(runtime_command({**env, 'PATH': str(preferred.parent) + ':/usr/bin'}), str(preferred))

    def test_logout_waits_for_owned_login_and_only_then_calls_official_logout(self):
        class Runner(FakeRunner):
            def run(self, argv, **options):
                if 'logout' in argv:
                    self.calls.append((argv, options))
                    if not self.login_cancelled.is_set(): raise AssertionError('login still running')
                    self.auth = {'loggedIn': False, 'authMethod': 'none'}
                    options['on_line']('SYNTHETIC_LOGOUT_SECRET\n')
                    return 0
                try: return super().run(argv, **options)
                except BridgeError:
                    if 'login' in argv: self.login_cancelled.set()
                    raise
        runner = Runner(); runner.login_cancelled = threading.Event()
        bridge = self.bridge(runner)
        bridge.login_start('owned-login'); self.assertTrue(runner.login_started.wait(1))
        self.assert_code('busy', lambda: bridge.print_stream('during-login', '合成', lambda _: None))
        self.assertEqual(bridge.logout(), {'loggedIn': False, 'authMethod': 'none', 'localCLIOnly': True, 'dynamicTools': False})
        self.assertEqual(bridge.operation_status('owned-login')['status'], 'cancelled')
        self.assertEqual(sum('logout' in argv for argv, _ in runner.calls), 1)

    def test_late_cancel_cannot_reuse_evicted_job_or_stop_another_request(self):
        bridge = self.bridge()
        for index in range(66):
            bridge.print_stream('completed-' + str(index), '合成', lambda _: None)
            time.sleep(.025)  # Allow each bounded callback worker to close.
        self.assertNotIn('completed-0', bridge.jobs)
        self.assertFalse(bridge.cancel('completed-0'))
        self.assert_code('duplicate_request', lambda: bridge.print_stream('completed-0', '合成', lambda _: None))
        self.assertEqual(bridge.operation_status('completed-65')['status'], 'completed')
        self.assertLessEqual(len(bridge.jobs), 64)

    def test_disconnected_before_runner_start_and_closed_bridge_never_spawn(self):
        runner = FakeRunner(); bridge = self.bridge(runner)
        cancelled = threading.Event(); cancelled.set()
        self.assert_code('cancelled', lambda: bridge.print_stream('already-gone', '合成', lambda _: None, cancel=cancelled))
        self.assertFalse(any('--print' in argv for argv, _ in runner.calls))
        bridge.close()
        self.assert_code('busy', lambda: bridge.login_start('after-close'))


if __name__ == '__main__':
    unittest.main()
