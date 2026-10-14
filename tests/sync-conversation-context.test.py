"""Portable mobile references through Mac SQLite; no production database/server."""
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from cloud_server import CloudStore
from sync_store import SyncStore, copy, record, wire_id


def context(**updates):
    return {'version': 1, 'keys': ['notes:source', 'imports:file'],
            'source': {'kind': 'notes', 'id': 'source', 'conversationId': 'origin'}, **updates}


def change(kind, identifier, data, version=1):
    return {'entityType': kind, 'entityId': identifier, 'data': data, 'version': version, 'deleted': False}


class ConversationContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aibro-conversation-context-')
        self.addCleanup(self.temp.cleanup)
        self.store = SyncStore(self.temp.name)
        self.conversation = {'id': 'chat', 'title': '合成资料讨论', 'projectId': None, 'mobileContext': context()}
        self.store.apply_changes([
            change('conversations', 'chat', self.conversation),
            change('notes', 'source', {'id': 'source', 'title': '合成资料', 'content': '正文仅存资料记录'}),
            change('imports', 'file', {'id': 'file', 'originalName': '合成文件.txt', 'content': '文件正文'}),
        ], 3)

    def chat(self, snapshot=None):
        return next(item for item in (snapshot or self.store.snapshot())['conversations'] if item['id'] == 'chat')

    def ack(self):
        operations = self.store.pending()
        self.store.ack([{**{key: op[key] for key in ('opId', 'entityType', 'entityId')},
                         'version': op['baseVersion'] + 1} for op in operations])
        return operations

    def test_snapshot_sqlite_reopen_and_unchanged_save_keep_exact_context_without_new_version(self):
        self.assertEqual(self.chat()['mobileContext'], context())
        self.store.capture(self.store.snapshot())
        self.assertEqual(self.store.pending(), [])
        reopened = SyncStore(self.temp.name)
        reopened.capture(reopened.snapshot())
        self.assertEqual(reopened.snapshot()['conversations'][0]['mobileContext'], context())
        self.assertEqual(reopened.pending(), [])
        self.assertNotIn('正文', str(record('conversations', self.chat())['mobileContext']))

    def test_old_renderer_omission_unrelated_save_and_continuation_keep_selection(self):
        snapshot = self.store.snapshot()
        self.chat(snapshot).pop('mobileContext')
        self.store.capture(snapshot)
        self.assertEqual(self.chat()['mobileContext'], context())
        self.assertEqual(self.store.pending(), [])
        snapshot = self.store.snapshot()
        self.chat(snapshot).pop('mobileContext')
        snapshot['notes'][0]['title'] = '仅修改另一项元数据'
        self.store.capture(snapshot)
        self.assertEqual([op['entityType'] for op in self.ack()], ['notes'])
        snapshot = self.store.snapshot()
        self.chat(snapshot).pop('mobileContext')
        self.chat(snapshot)['messages'].append({'id': 'followup', 'role': 'user', 'text': '继续讨论明确引用的资料'})
        saved = self.store.capture(snapshot)
        self.assertEqual(self.chat(saved)['mobileContext'], context())
        operations = self.ack()
        self.assertEqual([(op['entityType'], op['entityId']) for op in operations], [('messages', wire_id('chat', 'followup'))])
        self.store.capture(self.store.snapshot())
        self.assertEqual(self.store.pending(), [])

    def test_renaming_old_renderer_conversation_sends_context_and_explicit_empty_clears(self):
        snapshot = self.store.snapshot()
        self.chat(snapshot).pop('mobileContext')
        self.chat(snapshot)['title'] = '在 Mac 改名'
        self.store.capture(snapshot)
        self.assertEqual(self.ack()[0]['data']['mobileContext'], context())
        snapshot = self.store.snapshot()
        self.chat(snapshot)['mobileContext'] = context(keys=[], source=None)
        self.store.capture(snapshot)
        self.assertEqual(self.ack()[0]['data']['mobileContext'], context(keys=[], source=None))
        self.assertEqual(self.chat()['mobileContext'], context(keys=[], source=None))

    def test_remote_omission_clears_context_and_deleted_conversation_is_not_resurrected(self):
        remote = {key: value for key, value in self.conversation.items() if key != 'mobileContext'}
        self.store.apply_changes([change('conversations', 'chat', remote, 2)], 4)
        self.assertNotIn('mobileContext', self.chat())
        self.store.capture(self.store.snapshot())
        self.assertEqual(self.store.pending(), [])
        self.store.apply_changes([{**change('conversations', 'chat', None, 3), 'deleted': True}], 5)
        self.store.capture(self.store.snapshot())
        self.assertEqual(self.store.snapshot()['conversations'], [])
        self.assertEqual(self.store.pending(), [])

    def test_raw_shape_type_and_size_rejected_atomically_before_sensitive_field_cleaning(self):
        invalid = [None, [], context(version=True), context(version=2), context(keys='notes:source'),
                   context(keys=['notes:source', 'tasks:task']), context(keys=['notes:../path']),
                   context(keys=['notes:' + 'a' * 201]), context(keys=['notes:x'] * 51),
                   context(source={'kind': 'imports', 'id': 'file'}), context(source={'kind': 'notes', 'id': 'source', 'conversationId': None}),
                   context(source={'kind': 'notes', 'id': 'source', 'content': 'not portable'}),
                   context(source={'kind': 'notes', 'id': 'source', 'localPath': '/synthetic/path'}),
                   context(password='synthetic-not-a-real-secret'), {'version': 1, 'keys': []}]
        before = self.store.snapshot()
        for value in invalid:
            with self.subTest(value=value):
                proposed = copy(before)
                self.chat(proposed)['mobileContext'] = value
                proposed['notes'][0]['title'] = 'Must roll back'
                with self.assertRaises(ValueError): self.store.capture(proposed)
                with self.assertRaises(ValueError): self.store.apply_changes([
                    change('notes', 'source', {'id': 'source', 'content': 'Must also roll back'}, 2),
                    change('conversations', 'chat', {**self.conversation, 'mobileContext': value}, 2)], 5)
                self.assertEqual(self.store.snapshot(), before)
                self.assertEqual(self.store.pending(), [])

    def test_stable_dedup_optional_origin_and_legacy_absence(self):
        original = context(keys=['notes:source', 'notes:source', 'imports:file'], source={'kind': 'notes', 'id': 'source'})
        projected = record('conversations', {**self.conversation, 'mobileContext': original})['mobileContext']
        self.assertEqual(projected, context(source={'kind': 'notes', 'id': 'source'}))
        self.assertEqual(len(original['keys']), 3)
        self.assertEqual(record('conversations', {'id': 'legacy', 'title': '兼容旧会话'}), {'id': 'legacy', 'title': '兼容旧会话'})
        self.assertEqual(len(record('conversations', {'mobileContext': context(keys=['notes:n' + str(n) for n in range(50)])})['mobileContext']['keys']), 50)

    def test_cloud_schema_is_opaque_and_mac_performs_typed_validation(self):
        operation = {'opId': 'synthetic-op', 'entityType': 'conversations', 'entityId': 'chat',
                     'baseVersion': 0, 'deleted': False, 'data': self.conversation}
        checked = CloudStore.validate_operation(operation)
        self.assertEqual(checked['data']['mobileContext'], context())
        # The cloud envelope intentionally does not own per-client typed schema.
        # A future/invalid context survives it but cannot become usable on Mac.
        invalid = {**self.conversation, 'mobileContext': context(version=99)}
        self.assertEqual(CloudStore.validate_operation({**operation, 'data': invalid})['data'], invalid)
        with self.assertRaises(ValueError): record('conversations', invalid)


if __name__ == '__main__': unittest.main()
