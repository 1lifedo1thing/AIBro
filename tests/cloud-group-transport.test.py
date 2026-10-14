"""Whole envelopes survive transport; invalid pages never reach workspace apply."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('sync_transport_fixture', Path(__file__).with_name('cloud-sync.test.py'))
fixture = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixture)
from cloud_sync import CloudSyncError, grouped_pull_supported, validate_pull_page


def change(seq, entity='notes', identifier=None):
    identifier = identifier or 'n' + str(seq)
    return dict(seq=seq, entityType=entity, entityId=identifier, version=1, deleted=False,
                data={'id': identifier, 'title': 'Synthetic note', 'content': 'Test body'})


def envelope(start=1):
    return dict(type='atomic-group', groupId='group-test', firstSeq=start, lastSeq=start + 1,
                changes=[change(start), change(start + 1)])


class ValidationTests(unittest.TestCase):
    def test_negotiation_old_server_and_supported_version(self):
        self.assertFalse(grouped_pull_supported(False))
        self.assertFalse(grouped_pull_supported({'protocol': 1}))
        self.assertTrue(grouped_pull_supported({'protocol': 1, 'atomicGroupPull': {'version': 1, 'maxGroupBytes': 16777216}}))
        for value in ({}, {'protocol': True}, {'protocol': 1, 'atomicGroupPull': {'version': 2, 'maxGroupBytes': 16777216}},
                      {'protocol': 1, 'atomicGroupPull': {'version': 1, 'maxGroupBytes': 16777217}}):
            with self.subTest(value=value), self.assertRaises(CloudSyncError): grouped_pull_supported(value)

    def test_interior_legacy_cursor_replays_whole_group(self):
        page = {'version': 1, 'changes': [envelope()], 'cursor': 2, 'hasMore': False}
        for cursor in [0, 1]:
            changes, end = validate_pull_page(page, cursor, True)
            self.assertEqual(changes, [envelope()]); self.assertEqual(end, 2)

    def test_gap_duplicate_truncation_and_false_terminal_cursor_are_rejected(self):
        page = {'version': 1, 'changes': [envelope()], 'cursor': 2, 'hasMore': False}
        bad = []
        for field, value in [('firstSeq', 0), ('lastSeq', 3), ('groupId', '../invalid'), ('changes', [change(1)])]:
            item = copy.deepcopy(page); item['changes'][0][field] = value; bad.append(item)
        item = copy.deepcopy(page); item['changes'][0]['changes'][1]['entityId'] = 'n1'; bad.append(item)
        item = copy.deepcopy(page); item['changes'][0]['changes'][1]['seq'] = 1; bad.append(item)
        item = copy.deepcopy(page); item['cursor'] = 3; bad.append(item)
        item = copy.deepcopy(page); item['changes'].append(change(4)); item['cursor'] = 4; bad.append(item)
        item = copy.deepcopy(page); item['version'] = True; bad.append(item)
        for value in bad:
            with self.subTest(value=value), self.assertRaises(CloudSyncError): validate_pull_page(value, 0, True)
        with self.assertRaises(CloudSyncError): validate_pull_page(page, 0, False)


class ManagerEnvelopeTests(unittest.TestCase):
    setUp = fixture.ManagerTests.setUp
    connect = fixture.ManagerTests.connect


def test_apply_only_complete_page(self):
    self.connect()
    original = self.manager._client_factory
    page = {'version': 1, 'changes': [envelope()], 'cursor': 2, 'hasMore': False}
    def factory(url, token):
        client = original(url, token); request = client.request
        def wrapped(method, path, payload=None, **kwargs):
            if path == '/v1/sync/capabilities': return {'protocol': 1, 'atomicGroupPull': {'version': 1, 'maxGroupBytes': 16777216}}
            if path.startswith('/v1/sync/pull-group?'): return page
            return request(method, path, payload, **kwargs)
        client.request = wrapped; return client
    self.manager._client_factory = factory
    self.manager.sync_once()
    self.assertEqual(len(self.workspace.applied), 1)
    self.assertEqual(self.workspace.applied[0][:2], ([envelope()], 2))
    page['changes'] = [envelope(4)]; page['cursor'] = 5
    with self.assertRaises(CloudSyncError): self.manager.sync_once()
    self.assertEqual(len(self.workspace.applied), 1); self.assertEqual(self.store.cursor, 2)


ManagerEnvelopeTests.test_apply_only_complete_page = test_apply_only_complete_page


class RealServerGroupTests(unittest.TestCase):
    setUp = fixture.ProtocolIntegrationTests.setUp
    device = fixture.ProtocolIntegrationTests.device

    def source(self):
        client = fixture.CloudClient(self.url)
        session = client.request('POST', '/v1/auth/login', {'username': 'student', 'password': 'isolated-test-password', 'deviceName': 'synthetic-phone'})
        return fixture.CloudClient(self.url, session['accessToken'])

    def test_http_group_conflict_preserves_all_members_until_one_remote_choice(self):
        manager, store, workspace = self.device('mac', {'_revision': 1, 'notes': [{'id': 'n1', 'title': 'Initial', 'content': 'Original'}]})
        manager.sync_once()
        client = self.source()
        result = client.request('POST', '/v1/sync/push-group', {'version': 1, 'groupId': 'phone-reviewed', 'readSet': [], 'operations': [
            {'opId': 'phone-first', 'entityType': 'notes', 'entityId': 'n1', 'baseVersion': 1, 'deleted': False,
             'data': {'id': 'n1', 'title': 'Phone result', 'content': 'Phone changed body'}},
            {'opId': 'phone-related', 'entityType': 'notes', 'entityId': 'n2', 'baseVersion': 0, 'deleted': False,
             'data': {'id': 'n2', 'title': 'Related result', 'content': 'Same operation'}}]})
        self.assertEqual(result['status'], 'accepted')
        edited = store.snapshot(); edited['notes'][0]['content'] = 'Local unsent edit'; store.capture(edited)
        manager.sync_once()
        self.assertEqual([(n['id'], n['content']) for n in store.snapshot()['notes']], [('n1', 'Local unsent edit')])
        entries = manager.conflicts()['conflicts']; self.assertEqual(len(entries), 1)
        entry = entries[0]; self.assertEqual(entry['memberCount'], 2)
        manager.resolve(entry['id'], 'remote', entry['revision'])
        self.assertEqual({n['id']: n['content'] for n in store.snapshot()['notes']}, {'n1': 'Phone changed body', 'n2': 'Same operation'})
        self.assertEqual(manager.conflicts()['conflicts'], [])

    def test_http_new_group_arrives_as_one_snapshot_revision(self):
        manager, store, _ = self.device('mac', {'_revision': 1})
        before = store.snapshot()['_revision']
        result = self.source().request('POST', '/v1/sync/push-group', {'version': 1, 'groupId': 'phone-created', 'readSet': [], 'operations': [
            {'opId': 'new-' + key, 'entityType': 'notes', 'entityId': key, 'baseVersion': 0, 'deleted': False,
             'data': {'id': key, 'title': key, 'content': 'Created together'}} for key in ['n1', 'n2']]})
        self.assertEqual(result['status'], 'accepted')
        manager.sync_once()
        self.assertEqual({n['id'] for n in store.snapshot()['notes']}, {'n1', 'n2'})
        self.assertEqual(store.snapshot()['_revision'], before + 1)
        self.assertEqual(store.status()['cursor'], result['cursor'])

if __name__ == '__main__': unittest.main()
