"""Atomic sync groups against disposable SQLite and real loopback HTTP only."""
import copy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import cloud_server as cloud

if not hasattr(hashlib, 'scrypt'):
    import os
    for candidate in ('python3.13', 'python3.12', 'python3.11'):
        executable = shutil.which(candidate)
        if executable and subprocess.run([executable, '-c', 'import hashlib; raise SystemExit(not hasattr(hashlib,"scrypt"))'], capture_output=True).returncode == 0:
            os.execv(executable, [executable, *sys.argv])
    raise SystemExit('Atomic group tests require Python with hashlib.scrypt.')


def op(identifier, kind='notes', version=0, data=None, deleted=False, op_id=None):
    return {'opId': op_id or 'op-' + identifier, 'entityType': kind, 'entityId': identifier,
            'baseVersion': version, 'deleted': deleted,
            'data': None if deleted else data if data is not None else {'id': identifier, 'title': identifier}}


def group(identifier, operations, reads=None, **extra):
    return {'version': 1, 'groupId': identifier, 'operations': operations, 'readSet': reads or [], **extra}


def read(identifier, kind='notes', version=0, data=None, deleted=False):
    return {'entityType': kind, 'entityId': identifier, 'version': version, 'deleted': deleted, 'data': data}


class AtomicGroupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aibro-atomic-group-test-')
        self.addCleanup(self.temp.cleanup)
        self.store = cloud.CloudStore(self.temp.name)
        self.store.add_user('fixture', 'fixture-password-42!')
        login = self.store.login({'username': 'fixture', 'password': 'fixture-password-42!', 'deviceName': 'fixture'}, 'test')
        self.token = login['accessToken']
        self.identity = self.store.authenticate('Bearer ' + self.token)
        self.server = cloud.CloudHTTPServer(('127.0.0.1', 0), self.store)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.02), daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)

    def close_server(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2)

    def request(self, path, payload=None, token=True):
        headers = {'Content-Type': 'application/json'}
        if token: headers['Authorization'] = 'Bearer ' + self.token
        raw = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request('http://127.0.0.1:' + str(self.server.server_port) + path, data=raw, headers=headers)
        try: response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=10)
        except urllib.error.HTTPError as error: response = error
        with response: return response.code, json.load(response)

    def push(self, payload): return self.request('/v1/sync/push-group', payload)

    def legacy(self, *operations):
        status, result = self.request('/v1/sync/push', {'operations': list(operations)})
        self.assertEqual(status, 200, result)
        return result

    def state(self):
        with self.store.db() as db:
            account = self.identity['accountId']
            return {'entities': [tuple(row) for row in db.execute('SELECT * FROM entities WHERE account_id=? ORDER BY entity_type,entity_id', (account,))],
                    'changes': [tuple(row) for row in db.execute('SELECT * FROM changes WHERE account_id=? ORDER BY seq', (account,))],
                    'sequence': db.execute('SELECT change_seq FROM accounts WHERE id=?', (account,)).fetchone()[0]}

    def test_negotiation_is_authenticated_and_legacy_shape_unchanged(self):
        self.assertEqual(self.request('/v1/health', token=False), (200, {'protocol': 1}))
        self.assertEqual(self.request('/v1/sync/capabilities', token=False)[0], 401)
        status, result = self.request('/v1/sync/capabilities')
        self.assertEqual(status, 200)
        self.assertEqual(result['atomicOperationGroups'], {'version': 1, 'maxOperations': 100, 'maxReadSet': 100, 'maxBytes': cloud.MAX_JSON})
        self.assertEqual(result['atomicGroupPull']['version'], 1)
        self.legacy(op('ordinary'))
        status, legacy = self.request('/v1/sync/pull?cursor=0&limit=100')
        self.assertEqual(status, 200)
        self.assertEqual(set(legacy), {'changes', 'cursor', 'hasMore'})
        self.assertEqual(len(legacy['changes']), 1)

    def test_complete_group_commits_receipt_targets_and_replays_after_restart(self):
        operations = [op('project', 'projects'), op('task', 'tasks'), op('agenda', data={'id': 'agenda', 'kind': '日程', 'content': '{}'}),
                      op('receipt', 'messages', data={'id': 'receipt', 'pendingPlan': {'id': 'p', 'status': 'applied'}})]
        payload = group('create-all', operations, [read('project', 'projects')], expectedCursor=0)
        status, result = self.push(payload)
        self.assertEqual(status, 200); self.assertEqual(result['status'], 'accepted')
        self.assertEqual(len(result['accepted']), 4)
        before = self.state()
        # Treat the first response as lost, then reopen the actual database.
        reopened = cloud.CloudStore(self.temp.name)
        self.assertEqual(reopened.push_group(self.identity, copy.deepcopy(payload)), result)
        self.assertEqual(self.state(), before)
        altered = copy.deepcopy(payload); altered['operations'][0]['data']['title'] = 'changed'
        self.assertEqual(self.push(altered), (409, {'code': 'group_id_reuse', 'error': '同一个操作组 ID 不能用于不同内容。'}))
        self.assertEqual(self.request('/v1/sync/push', {'operations': [operations[0]]})[1]['code'], 'atomic_group_required')
        self.assertEqual(self.push(group('different-group', [operations[0]]))[1]['code'], 'op_id_reuse')

    def test_target_conflict_does_not_publish_applied_message(self):
        self.legacy(op('task', 'tasks', data={'id': 'task', 'title': 'newer'}))
        payload = group('stale-apply', [op('receipt', 'messages', data={'id': 'receipt', 'pendingPlan': {'status': 'applied'}}), op('task', 'tasks', op_id='stale-task')])
        before = self.state(); status, result = self.push(payload)
        self.assertEqual(status, 200); self.assertEqual(result['status'], 'conflict'); self.assertEqual(result['accepted'], [])
        self.assertEqual(self.state(), before)
        self.legacy(op('task', 'tasks', version=1, data={'id': 'task', 'title': 'even-newer'}, op_id='later-task'))
        self.assertEqual(self.push(payload)[1], result, 'conflict replay must preserve the first result')
        self.assertEqual(self.request('/v1/sync/push', {'operations': [payload['operations'][0]]})[1]['code'], 'atomic_group_required')
        self.assertEqual(self.push(group('reuse-conflicted-member', [payload['operations'][0]]))[1]['code'], 'op_id_reuse')

    def test_rejected_message_blocks_whole_apply_group(self):
        self.legacy(op('receipt', 'messages', data={'id': 'receipt', 'pendingPlan': {'status': 'pending'}}))
        self.legacy(op('receipt', 'messages', version=1, data={'id': 'receipt', 'pendingPlan': {'status': 'rejected'}}, op_id='reject'))
        before = self.state()
        payload = group('apply', [op('task', 'tasks'), op('receipt', 'messages', version=1, data={'id': 'receipt', 'pendingPlan': {'status': 'applied'}}, op_id='apply-receipt')])
        self.assertEqual(self.push(payload)[1]['status'], 'conflict')
        self.assertEqual(self.state(), before)

    def test_reads_check_exact_data_absence_tombstones_and_cursor(self):
        project = {'id': 'project', 'archived': True}
        self.legacy(op('project', 'projects', data=project), op('gone', deleted=True))
        cases = [([read('project', 'projects', 1, {'id': 'project', 'archived': False})], {}),
                 ([read('gone')], {}), ([], {'expectedCursor': 0})]
        for index, (reads, extra) in enumerate(cases):
            with self.subTest(index=index):
                before = self.state()
                status, result = self.push(group('read-conflict-' + str(index), [op('target-' + str(index))], reads, **extra))
                self.assertEqual(status, 200); self.assertEqual(result['status'], 'conflict'); self.assertEqual(self.state(), before)
        payload = group('reads-match', [op('target-ok')], [read('project', 'projects', 1, project), read('gone', version=1, deleted=True), read('absent')], expectedCursor=2)
        self.assertEqual(self.push(payload)[1]['status'], 'accepted')

    def test_remove_and_restore_bundle_are_one_transaction(self):
        original = {'id': 'task', 'title': 'original'}
        self.legacy(op('task', 'tasks', data=original))
        trash = {'id': 'trash', 'data': {'tasks': [original]}}
        removed = group('remove', [op('task', 'tasks', version=1, deleted=True, op_id='remove-task'), op('trash', 'trash', data=trash), op('receipt', 'messages')])
        self.assertEqual(self.push(removed)[1]['status'], 'accepted')
        restored = group('restore', [op('task', 'tasks', version=2, data=original, op_id='restore-task'), op('trash', 'trash', version=1, deleted=True, op_id='consume-trash')], [read('trash', 'trash', 1, trash)])
        self.assertEqual(self.push(restored)[1]['status'], 'accepted')
        self.assertEqual(self.state()['sequence'], 6)

    def test_two_concurrent_groups_have_one_complete_winner(self):
        barrier = threading.Barrier(2); results = []; errors = []
        def run(label):
            try:
                barrier.wait(timeout=3)
                results.append(self.push(group(label, [op('shared', 'messages', op_id=label + '-shared'), op(label, 'tasks')]))[1])
            except Exception as error: errors.append(error)
        workers = [threading.Thread(target=run, args=(label,)) for label in ('left', 'right')]
        for worker in workers: worker.start()
        for worker in workers: worker.join(timeout=10)
        self.assertFalse(errors); self.assertEqual(sorted(result['status'] for result in results), ['accepted', 'conflict'])
        state = self.state(); self.assertEqual(len(state['entities']), 2); self.assertEqual(state['sequence'], 2)

    def test_storage_failure_rolls_back_entities_changes_operations_and_group(self):
        payload = group('crash', [op('first'), op('second')])
        with self.store.db() as db:
            db.execute("CREATE TRIGGER fixture_fail BEFORE INSERT ON atomic_group_members WHEN NEW.op_id='op-second' BEGIN SELECT RAISE(ABORT,'fixture'); END")
        before = self.state()
        self.assertEqual(self.push(payload)[0], 503); self.assertEqual(self.state(), before)
        with self.store.db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM atomic_groups').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM operations').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM atomic_group_members').fetchone()[0], 0)
            db.execute('DROP TRIGGER fixture_fail')
        self.assertEqual(self.push(payload)[1]['status'], 'accepted')

    def test_group_pull_does_not_split_and_replays_interior_cursor(self):
        self.legacy(op('ordinary'))
        self.assertEqual(self.push(group('bundle', [op('a'), op('b'), op('c')]))[1]['status'], 'accepted')
        self.legacy(op('after'))
        first = self.request('/v1/sync/pull-group?cursor=0&limit=2')[1]
        self.assertEqual(first['cursor'], 1); self.assertEqual(len(first['changes']), 1)
        whole = self.request('/v1/sync/pull-group?cursor=1&limit=1')[1]
        self.assertEqual(whole['cursor'], 4); self.assertTrue(whole['hasMore'])
        envelope = whole['changes'][0]
        self.assertEqual((envelope['type'], envelope['firstSeq'], envelope['lastSeq']), ('atomic-group', 2, 4))
        for cursor in (2, 3):
            replay = self.request('/v1/sync/pull-group?cursor=' + str(cursor) + '&limit=1')[1]
            self.assertEqual(replay, whole)
        final = self.request('/v1/sync/pull-group?cursor=4&limit=1')[1]
        self.assertEqual(final['cursor'], 5); self.assertFalse(final['hasMore'])
        self.assertEqual(final['changes'][0]['entityId'], 'after')
        legacy = self.request('/v1/sync/pull?cursor=1&limit=1')[1]
        self.assertEqual(legacy['cursor'], 2); self.assertNotIn('type', legacy['changes'][0])

    def test_pull_soft_size_limit_does_not_split_large_group(self):
        large = 'x' * (2 * 1024 * 1024 + 100)
        payload = group('large', [op('a', data={'id': 'a', 'content': large}), op('b', data={'id': 'b', 'content': large})])
        self.assertEqual(self.push(payload)[1]['status'], 'accepted')
        status, result = self.request('/v1/sync/pull-group?cursor=0&limit=100')
        self.assertEqual(status, 200); self.assertEqual(len(result['changes']), 1)
        self.assertEqual(len(result['changes'][0]['changes']), 2); self.assertEqual(result['cursor'], 2)
        self.assertGreater(len(cloud.encoded(result)), cloud.MAX_PULL_BYTES)
        self.assertLessEqual(len(cloud.encoded(result)), cloud.MAX_JSON)

    def test_invalid_groups_and_existing_operation_ids_never_write(self):
        valid = group('valid', [op('target')])
        cases = [{**valid, 'version': True}, {**valid, 'version': 2}, {**valid, 'operations': []},
                 {**valid, 'unknown': True}, {**valid, 'operations': [op('same'), op('same', op_id='different')]},
                 {**valid, 'operations': [op('a', op_id='duplicate'), op('b', op_id='duplicate')]},
                 {**valid, 'readSet': [read('a'), read('a')]}, {**valid, 'expectedCursor': True},
                 {**valid, 'readSet': [read('a', version=True)]}, {**valid, 'readSet': [read('a', data='invalid')]},
                 {**valid, 'operations': [op(str(i)) for i in range(101)]},
                 {**valid, 'readSet': [read(str(i)) for i in range(101)]}]
        for payload in cases:
            with self.subTest(payload=list(payload)):
                self.assertEqual(self.push(payload)[0], 400)
                self.assertEqual(self.state()['sequence'], 0)
        self.legacy(op('legacy'))
        self.assertEqual(self.push(group('reuse', [op('legacy')]))[1]['code'], 'op_id_reuse')
        self.assertEqual(self.request('/v1/sync/pull-group?cursor=2')[0], 409)
        self.assertEqual(self.request('/v1/sync/pull-group?cursor=0&limit=0')[0], 400)
        self.assertEqual(self.request('/v1/sync/pull-group?cursor=0&other=1')[0], 400)

    def test_hard_group_size_limit_rejects_without_splitting_or_reserving_ids(self):
        # Every record is within the entity cap; only the indivisible group
        # exceeds 16 MiB. The HTTP layer has the same pre-read MAX_JSON cap.
        large = 'x' * (7 * 1024 * 1024 // 2)
        payload = group('too-large', [op(str(i), data={'id': str(i), 'content': large}) for i in range(5)])
        self.assertGreater(len(cloud.encoded(payload)), cloud.MAX_JSON)
        with self.assertRaises(cloud.APIError) as raised: self.store.push_group(self.identity, payload)
        self.assertEqual((raised.exception.status, raised.exception.code), (413, 'group_too_large'))
        self.assertEqual(self.state()['sequence'], 0)
        with self.store.db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM atomic_groups').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM atomic_group_members').fetchone()[0], 0)
        self.assertEqual(self.push(group('too-large', [op('small')]))[1]['status'], 'accepted')

    def test_group_isolation_and_revocation(self):
        payload = group('same-name', [op('same-id')])
        self.assertEqual(self.push(payload)[1]['status'], 'accepted')
        self.store.add_user('other', 'fixture-password-42!')
        auth = self.store.login({'username': 'other', 'password': 'fixture-password-42!'}, 'other')
        identity = self.store.authenticate('Bearer ' + auth['accessToken'])
        self.assertEqual(self.store.push_group(identity, payload)['status'], 'accepted')
        self.assertEqual(self.store.pull_group(identity)['changes'][0]['groupId'], 'same-name')
        self.store.revoke_device(self.identity, self.identity['deviceId'])
        self.assertEqual(self.push(payload)[0], 401)
        with self.assertRaises(cloud.APIError) as raised: self.store.push_group(self.identity, payload)
        self.assertEqual(raised.exception.status, 401, 'even a replay rechecks current device authorization')


if __name__ == '__main__': unittest.main()
