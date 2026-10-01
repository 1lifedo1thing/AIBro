"""Durable remote migration tests. No SSH, systemd, network, or user data."""
import contextlib
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import cloud_ssh_remote as remote


class Interrupted(BaseException):
    """Simulate abrupt remote process death, bypassing normal rollback."""


class RemoteRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name).resolve()
        self.source = self.home / 'source'
        self.target = self.home / 'destination'
        self.source.mkdir(mode=0o700)
        with sqlite3.connect(self.source / 'cloud.sqlite3') as db:
            db.execute('CREATE TABLE accounts (id TEXT, change_seq INTEGER)')
            db.execute('INSERT INTO accounts VALUES (?, ?)', ('account', 6))
        (self.source / 'attachment').write_bytes(b'synthetic retained material')
        self.base = self.home / '.config/systemd/user'
        self.override = self.base / (remote.UNIT + '.d') / '90-aibro-storage.conf'
        self.override.parent.mkdir(parents=True)
        self.override.write_bytes(b'[Service]\n# old configuration\n')
        self.old_override = self.override.read_bytes()
        self.active = True
        self.active_path = self.source
        self.commands = []
        self.fail_health = False
        self.crash = None
        self.payload = {'jobId': 'a' * 32, 'accountId': 'account', 'cursor': 5,
                        'expectedPath': str(self.source), 'dataPath': str(self.target)}
        for patcher in (
            patch.object(remote.Path, 'home', return_value=self.home),
            patch.object(remote, 'control', side_effect=self.control),
            patch.object(remote, 'deployment', side_effect=self.deployment),
            patch.object(remote, 'health', side_effect=self.health),
        ):
            patcher.start(); self.addCleanup(patcher.stop)

    def control(self, *args):
        self.commands.append(args)
        if args[0] == 'stop': self.active = False
        elif args[0] == 'start':
            self.active = True
            self.active_path = self.target if str(self.target).encode() in self.override.read_bytes() else self.source
        elif args[0] == 'show': return '0' if not self.active else '123'
        if self.crash == args[0]: raise Interrupted()
        return ''

    def deployment(self, account_id, cursor):
        if not self.active: raise ValueError('synthetic service inactive')
        remote.account_check(self.active_path, account_id, cursor)
        return {'dataPath': str(self.active_path), 'databasePath': str(self.active_path / 'cloud.sqlite3'),
                'remotePort': 8787, 'service': remote.UNIT, 'active': True,
                'argv': ['/usr/bin/python3', '/opt/cloud_server.py', 'serve', '--data-dir', str(self.active_path),
                         '--host', '127.0.0.1', '--port', '8787']}

    def health(self, info):
        if self.fail_health is True or (self.fail_health == 'target' and info['dataPath'] == str(self.target)):
            raise ValueError('synthetic health unavailable')

    def receipt_path(self):
        return self.base / '.aibro-migrations' / (self.payload['jobId'] + '.json')

    def record(self):
        return json.loads(self.receipt_path().read_text())

    def rewrite(self, record):
        self.receipt_path().write_text(json.dumps(record))

    def readonly_status(self, payload=None):
        commands = list(self.commands)
        files = {str(path): (path.read_bytes(), path.stat().st_mtime_ns)
                 for path in self.base.rglob('*') if path.is_file()}
        result = remote.move_status(payload or self.payload)
        self.assertEqual(self.commands, commands, 'status must not invoke control mutations')
        self.assertEqual(files, {str(path): (path.read_bytes(), path.stat().st_mtime_ns)
                                for path in self.base.rglob('*') if path.is_file()})
        return result

    def test_completed_receipt_is_private_durable_and_same_id_never_copies_again(self):
        before = remote.manifest(self.source)
        result = remote.move_job(self.payload)
        self.assertEqual(result['job']['state'], 'completed')
        self.assertEqual(result['job']['id'], self.payload['jobId'])
        self.assertEqual(result['dataPath'], str(self.target))
        self.assertEqual(remote.manifest(self.source), before)
        self.assertEqual(self.receipt_path().stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.receipt_path().parent.stat().st_mode & 0o777, 0o700)
        self.assertRegex(self.record()['job']['manifestDigest'], r'^[a-f0-9]{64}$')
        with patch.object(remote, 'relocate', side_effect=AssertionError('must never replay')):
            self.assertEqual(remote.move_job(self.payload)['job']['state'], 'completed')
        self.assertEqual(self.readonly_status()['job']['state'], 'completed')

    def test_receipt_and_override_atomic_writes_fsync_files_and_parent(self):
        events = []
        real_fsync = os.fsync
        def sync(fd):
            events.append(os.fstat(fd).st_mode)
            return real_fsync(fd)
        import stat
        with patch.object(remote.os, 'fsync', side_effect=sync): remote.move_job(self.payload)
        self.assertTrue(any(stat.S_ISREG(mode) for mode in events))
        self.assertTrue(any(stat.S_ISDIR(mode) for mode in events))

    def test_missing_receipt_status_is_uncertain_and_creates_nothing(self):
        result = self.readonly_status()
        self.assertEqual(result['job']['state'], 'uncertain')
        self.assertEqual(result['job']['phase'], 'missing')
        self.assertNotIn('remotePort', result)
        self.assertFalse(self.receipt_path().parent.exists())
        self.assertFalse((self.base / '.aibro-storage.lock').exists())

    def test_job_identity_binds_account_cursor_both_paths_and_id(self):
        remote.move_job(self.payload)
        for delta in ({'accountId': 'another'}, {'cursor': 4},
                      {'expectedPath': str(self.home / 'other-source')}, {'dataPath': str(self.home / 'other-target')}):
            with self.subTest(delta=delta), self.assertRaisesRegex(ValueError, '不匹配'):
                remote.move_job({**self.payload, **delta})
        for job_id in ('', '../bad', 'A' * 32, 'a' * 31, 123):
            with self.subTest(job_id=job_id), self.assertRaises(ValueError):
                remote.move_job({**self.payload, 'jobId': job_id})
        self.assertEqual(len([item for item in self.commands if item[0] == 'stop']), 1)

    def test_invalid_receipt_never_runs_or_reports_success(self):
        remote.move_job(self.payload)
        valid = self.record()
        mutations = [lambda item: item.update(version=99),
                     lambda item: item['job'].update(phase='made-up'),
                     lambda item: item['job'].update(manifestDigest=None),
                     lambda item: item['job'].update(verifiedFiles=False),
                     lambda item: item['job'].update(id='b' * 32),
                     lambda item: item['job'].update(state='error')]
        for mutate in mutations:
            item = json.loads(json.dumps(valid)); mutate(item); self.rewrite(item)
            with self.subTest(item=item), self.assertRaises(ValueError): remote.move_status(self.payload)
        self.receipt_path().write_text('{not JSON')
        with self.assertRaisesRegex(ValueError, '损坏'): remote.move_job(self.payload)

    def test_receipt_symlink_hardlink_permissions_and_directory_permissions_rejected(self):
        remote.move_job(self.payload)
        path = self.receipt_path(); original = path.read_bytes()
        path.chmod(0o644)
        with self.assertRaises(ValueError): remote.move_status(self.payload)
        path.chmod(0o600)
        linked = self.home / 'other-receipt'; os.link(path, linked)
        with self.assertRaises(ValueError): remote.move_status(self.payload)
        linked.unlink(); path.unlink(); linked.write_bytes(original); path.symlink_to(linked)
        with self.assertRaises(ValueError): remote.move_status(self.payload)
        path.unlink(); path.write_bytes(original); path.chmod(0o600)
        path.parent.chmod(0o755)
        with self.assertRaises(ValueError): remote.move_status(self.payload)

    def test_symlink_or_writable_ancestor_and_journal_inside_data_are_rejected(self):
        self.base.chmod(0o777)
        with self.assertRaises(ValueError): remote.move_job(self.payload)
        self.base.chmod(0o755)
        outside = self.home / 'journal-outside'; outside.mkdir()
        (self.base / '.aibro-migrations').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError): remote.move_job(self.payload)
        (self.base / '.aibro-migrations').unlink()
        with self.assertRaisesRegex(ValueError, '包含远端迁移记录'):
            remote.move_job({**self.payload, 'expectedPath': str(self.home / '.config')})
        self.assertFalse(self.commands)

    def test_crash_after_start_recovers_only_with_copy_verification_and_health(self):
        self.crash = 'start'
        with self.assertRaises(Interrupted): remote.move_job(self.payload)
        self.assertEqual(self.record()['job']['state'], 'running')
        self.assertEqual(self.record()['job']['phase'], 'switching')
        self.assertEqual(self.active_path, self.target)
        result = self.readonly_status()
        self.assertEqual(result['job']['state'], 'completed')
        self.assertTrue(result['job']['recovered'])
        self.assertEqual(result['dataPath'], str(self.target))
        # Reconciliation is a projection; reading never rewrites the evidence.
        self.assertEqual(self.record()['job']['state'], 'running')
        self.fail_health = True
        self.assertEqual(self.readonly_status()['job']['state'], 'uncertain')

    def test_target_path_alone_without_verified_phase_never_means_completed(self):
        self.crash = 'start'
        with self.assertRaises(Interrupted): remote.move_job(self.payload)
        item = self.record(); item['job']['phase'] = 'copying'; self.rewrite(item)
        self.assertEqual(self.readonly_status()['job']['state'], 'uncertain')
        item['job']['phase'] = 'copy_verified'; item['job'].pop('manifestDigest'); self.rewrite(item)
        with self.assertRaisesRegex(ValueError, '复制校验证据'): self.readonly_status()

    def test_crash_before_copy_retains_uncertainty_and_duplicate_does_not_restart(self):
        self.crash = 'stop'
        with self.assertRaises(Interrupted): remote.move_job(self.payload)
        self.assertEqual(self.readonly_status()['job']['state'], 'uncertain')
        self.assertFalse(self.target.exists())
        commands = list(self.commands)
        self.assertEqual(remote.move_job(self.payload)['job']['state'], 'uncertain')
        self.assertEqual(self.commands, commands)

    def test_pre_stop_crash_is_proven_not_started_and_preflight_rejection_terminal(self):
        with patch.object(remote, 'relocate', side_effect=Interrupted()):
            with self.assertRaises(Interrupted): remote.move_job(self.payload)
        result = self.readonly_status()
        self.assertEqual(result['job']['state'], 'error')
        self.assertEqual(result['job']['phase'], 'rejected')
        self.assertFalse(self.commands)
        self.payload['jobId'] = 'b' * 32
        self.target.mkdir()
        result = remote.move_job(self.payload)
        self.assertEqual(result['job']['state'], 'error')
        self.assertEqual(result['job']['phase'], 'rejected')
        self.assertFalse(self.commands)

    def test_health_failure_rolls_back_and_persists_error_not_false_success(self):
        self.fail_health = 'target'
        result = remote.move_job(self.payload)
        self.assertEqual(result['job']['state'], 'error')
        self.assertEqual(result['job']['phase'], 'rolled_back')
        self.assertEqual(self.override.read_bytes(), self.old_override)
        self.assertEqual(self.active_path, self.source)
        self.assertTrue(self.target.exists())
        self.assertEqual(self.readonly_status()['job']['state'], 'error')

    def test_failure_to_persist_terminal_receipt_stays_uncertain_and_can_reconcile(self):
        save = remote.save_receipt
        def lose_terminal(record):
            if record['job']['state'] == 'completed': raise OSError('synthetic full disk')
            return save(record)
        with patch.object(remote, 'save_receipt', side_effect=lose_terminal):
            result = remote.move_job(self.payload)
        self.assertEqual(result['job']['state'], 'uncertain')
        self.assertEqual(self.readonly_status()['job']['state'], 'completed')

    def test_lock_busy_does_not_write_or_run_another_move(self):
        with patch.object(remote, 'relocate', side_effect=Interrupted()):
            with self.assertRaises(Interrupted): remote.move_job(self.payload)
        with remote.mutation_lock():
            result = self.readonly_status()
            self.assertEqual(result['job']['state'], 'running')
            with self.assertRaises(BlockingIOError): remote.move_job(self.payload)
        self.assertFalse(self.commands)

    def test_completed_status_does_not_return_stale_deployment_when_service_unavailable(self):
        remote.move_job(self.payload)
        self.active = False
        result = self.readonly_status()
        self.assertEqual(result['job']['state'], 'uncertain')
        self.assertNotIn('remotePort', result)
        self.assertNotIn('dataPath', result)
        self.assertEqual(self.record()['job']['state'], 'completed')

    def test_unhealthy_or_changed_service_does_not_unlock_terminal_receipt(self):
        remote.move_job(self.payload)
        self.fail_health = True
        self.assertEqual(self.readonly_status()['job']['state'], 'uncertain')
        self.fail_health = False; self.active_path = self.source
        self.assertEqual(self.readonly_status()['job']['state'], 'uncertain')
        self.active_path = self.target
        self.assertEqual(self.readonly_status()['job']['state'], 'completed')

    def test_unhealthy_rollback_retains_uncertainty(self):
        self.fail_health = True
        result = remote.move_job(self.payload)
        self.assertEqual(result['job']['state'], 'uncertain')
        self.assertEqual(self.active_path, self.source)
        self.assertEqual(self.record()['job']['phase'], 'rolling_back')
        self.assertNotIn('remotePort', result)
        self.fail_health = False
        # A rolled-back-looking path after interrupted rollback is insufficient.
        self.assertEqual(self.readonly_status()['job']['state'], 'uncertain')

    def test_copy_flush_failure_never_switches_to_unflushed_destination(self):
        with patch.object(remote, 'sync_tree', side_effect=OSError('synthetic flush failure')):
            result = remote.move_job(self.payload)
        self.assertEqual(result['job']['state'], 'error')
        self.assertEqual(self.active_path, self.source)
        self.assertEqual(self.override.read_bytes(), self.old_override)
        self.assertNotIn('manifestDigest', self.record()['job'])

    def test_destination_parent_writable_by_others_rejected_before_service_stop(self):
        parent = self.home / 'shared'; parent.mkdir(mode=0o777); parent.chmod(0o777)
        self.payload['dataPath'] = str(parent / 'new')
        result = remote.move_job(self.payload)
        self.assertEqual(result['job']['state'], 'error')
        self.assertEqual(result['job']['phase'], 'rejected')
        self.assertFalse(self.commands)

    def test_cli_requires_move_job_id_and_status_returns_envelope(self):
        for payload in ({**self.payload, 'action': 'move', 'jobId': None},
                        {**self.payload, 'action': 'move-status'}):
            output = io.StringIO()
            with patch.object(remote.sys, 'stdin', io.StringIO(json.dumps(payload))), contextlib.redirect_stdout(output):
                remote.main()
            result = json.loads(output.getvalue())
            self.assertEqual(result['ok'], payload['action'] == 'move-status')
            if result['ok']: self.assertEqual(result['job']['state'], 'uncertain')
        self.assertFalse(self.commands)


if __name__ == '__main__': unittest.main()
