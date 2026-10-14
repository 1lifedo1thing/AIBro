"""Mobile message history through the Mac projection; all storage is disposable."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from sync_store import SyncStore, MessageBodyConflict, MESSAGE_PROCESS_FIELDS, copy, record, wire_id


def message(**changes):
    return {'id': 'answer', 'conversationId': 'chat', 'position': 1, 'role': 'assistant',
            'content': '合成答复，请审阅。', 'reasoning': '合成推理\n保留完整换行',
            'toolEvents': [{'type': 'tool-result', 'title': 'propose_changes', 'output': {'executed': False}}],
            'status': 'completed', 'error': '', 'capabilities': {'tools': True, 'writePlans': True},
            'pendingPlan': {'id': 'plan', 'status': 'pending', 'conversationID': 'chat', 'projectID': None,
                            'actions': [{'operation': 'create', 'kind': 'tasks', 'targetId': 'not-created', 'after': {'id': 'not-created'}}]},
            **changes}


def change(kind, identifier, data, version=1):
    return {'entityType': kind, 'entityId': identifier, 'data': data, 'version': version, 'deleted': False}


class MessageProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aibro-message-process-')
        self.addCleanup(self.temp.cleanup)
        self.store = SyncStore(self.temp.name)
        self.original = message()
        self.incoming = [change('conversations', 'chat', {'id': 'chat', 'title': '合成对话', 'projectId': None}),
                         change('messages', wire_id('chat', 'user'), {'id': 'user', 'conversationId': 'chat', 'position': 0, 'role': 'user', 'content': '合成请求'}),
                         change('messages', wire_id('chat', 'answer'), self.original)]
        self.store.apply_changes(self.incoming, 3)

    def answer(self, snapshot=None):
        return next(m for m in (snapshot or self.store.snapshot())['conversations'][0]['messages'] if m['id'] == 'answer')

    def ack(self):
        operations = self.store.pending()
        self.store.ack([{**{k: operation[k] for k in ('opId', 'entityType', 'entityId')}, 'version': operation['baseVersion'] + 1} for operation in operations])
        return operations

    def test_snapshot_alias_exact_history_and_unchanged_save_have_no_outbox(self):
        snapshot = self.store.snapshot()
        answer = self.answer(snapshot)
        self.assertEqual(answer['text'], self.original['content'])
        for key in MESSAGE_PROCESS_FIELDS: self.assertEqual(answer[key], self.original[key])
        self.store.capture(snapshot)
        self.assertEqual(self.store.pending(), [])
        reopened = SyncStore(self.temp.name)
        reopened.capture(reopened.snapshot())
        self.assertEqual(reopened.pending(), [])
        projected = record('messages', self.answer())
        self.assertNotIn('text', projected)
        self.assertEqual(projected['content'], self.original['content'])

    def test_old_renderer_omitting_history_and_content_keeps_exact_wire_version(self):
        snapshot = self.store.snapshot()
        for item in snapshot['conversations'][0]['messages']:
            item.pop('content', None)
            for key in MESSAGE_PROCESS_FIELDS: item.pop(key, None)
        saved = self.store.capture(snapshot)
        self.assertEqual(self.answer(saved)['pendingPlan'], self.original['pendingPlan'])
        self.assertEqual(self.store.pending(), [])

    def test_existing_snapshot_gets_read_alias_without_rewriting_database(self):
        with self.store.db() as db:
            original = self.store._get(db, 'snapshot')
            original['_revision'] = 9
            for row in original['conversations'][0]['messages']: row.pop('text', None)
            self.store._put(db, 'snapshot', original)
        self.assertEqual(self.answer()['text'], self.original['content'])
        self.assertEqual(self.answer(self.store.snapshot_at(9))['text'], self.original['content'])
        with self.store.db() as db:
            self.assertNotIn('text', self.store._get(db, 'snapshot')['conversations'][0]['messages'][1])
        self.assertEqual(self.store.pending(), [])

    def test_unrelated_save_and_normal_continuation_preserve_historical_message(self):
        snapshot = self.store.snapshot()
        snapshot['notes'].append({'id': 'unrelated', 'title': '另一条合成笔记', 'content': '只改笔记'})
        self.store.capture(snapshot)
        self.assertEqual([op['entityType'] for op in self.ack()], ['notes'])
        snapshot = self.store.snapshot()
        snapshot['conversations'][0]['messages'].extend([
            {'id': 'followup', 'role': 'user', 'text': '继续合成对话'},
            {'id': 'desktop-answer', 'role': 'agent', 'text': '桌面合成回复'}])
        self.store.capture(snapshot)
        operations = self.ack()
        self.assertEqual({op['entityId'] for op in operations}, {wire_id('chat', 'followup'), wire_id('chat', 'desktop-answer')})
        self.assertEqual(self.answer()['pendingPlan'], self.original['pendingPlan'])
        self.store.capture(self.store.snapshot())
        self.assertEqual(self.store.pending(), [])

    def test_text_edit_updates_content_invalidates_plan_and_retains_history(self):
        snapshot = self.store.snapshot()
        self.answer(snapshot)['text'] = 'Mac 实际编辑后的答复'
        saved = self.store.capture(snapshot)
        answer = self.answer(saved)
        self.assertEqual(answer['content'], answer['text'])
        self.assertEqual(answer['pendingPlan']['status'], 'invalidated')
        self.assertEqual(answer['pendingPlan']['invalidatedReason'], 'conversation-message-edited')
        for key in ('reasoning', 'toolEvents', 'status', 'error', 'capabilities'):
            self.assertEqual(answer[key], self.original[key])
        operations = self.ack()
        self.assertEqual(len(operations), 1)
        self.assertNotIn('text', operations[0]['data'])
        self.assertEqual(operations[0]['data']['content'], 'Mac 实际编辑后的答复')
        self.assertEqual(self.store.snapshot()['tasks'], [])
        self.store.capture(self.store.snapshot())
        self.assertEqual(self.store.pending(), [])

    def test_content_edit_updates_mac_alias_and_equal_dual_edit_is_unambiguous(self):
        snapshot = self.store.snapshot()
        self.answer(snapshot)['content'] = 'content 一侧编辑'
        saved = self.store.capture(snapshot)
        self.assertEqual(self.answer(saved)['text'], 'content 一侧编辑')
        self.ack()
        snapshot = self.store.snapshot()
        self.answer(snapshot).update(content='两份一致的新正文', text='两份一致的新正文')
        self.store.capture(snapshot)
        self.assertEqual(self.answer()['content'], '两份一致的新正文')

    def test_conflicting_dual_edits_reject_atomically_without_losing_either_input(self):
        before = self.store.snapshot()
        proposed = copy(before)
        self.answer(proposed).update(content='手机字段的新正文', text='桌面字段的另一份新正文')
        proposed['notes'].append({'id': 'not-written', 'content': '一起回滚'})
        with self.assertRaises(MessageBodyConflict): self.store.capture(proposed)
        self.assertEqual(self.store.snapshot(), before)
        self.assertEqual(self.store.pending(), [])
        self.assertEqual(self.answer(proposed)['text'], '桌面字段的另一份新正文')
        self.assertEqual(self.answer(proposed)['content'], '手机字段的新正文')

    def test_editing_or_removing_source_user_message_invalidates_pending_plan(self):
        snapshot = self.store.snapshot()
        snapshot['conversations'][0]['messages'][0]['text'] = '用户改了原始请求'
        self.store.capture(snapshot)
        self.assertEqual(self.answer()['pendingPlan']['status'], 'invalidated')
        self.ack()
        snapshot = self.store.snapshot()
        self.answer(snapshot)['pendingPlan'] = copy(self.original['pendingPlan'])
        snapshot['conversations'][0]['messages'].pop(0)
        self.store.capture(snapshot)
        self.assertEqual(self.answer()['pendingPlan']['status'], 'invalidated')

    def test_stale_pending_plan_cannot_rearm_after_edit_or_terminal_receipt(self):
        snapshot = self.store.snapshot()
        self.answer(snapshot)['text'] = '改变原答复'
        saved = self.store.capture(snapshot)
        invalidated = copy(self.answer(saved)['pendingPlan'])
        self.ack()
        self.answer(saved)['pendingPlan'] = copy(self.original['pendingPlan'])
        self.store.capture(saved)
        self.assertEqual(self.answer()['pendingPlan'], invalidated)
        self.assertEqual(self.store.pending(), [])
        remote = message(content='已在手机确认', pendingPlan={**self.original['pendingPlan'], 'status': 'applied', 'receipts': []})
        self.store.apply_changes([change('messages', wire_id('chat', 'answer'), remote, 3)], 4)
        replay = self.store.snapshot(); self.answer(replay)['pendingPlan'] = copy(self.original['pendingPlan'])
        self.store.capture(replay)
        self.assertEqual(self.answer()['pendingPlan']['status'], 'applied')
        self.assertEqual(self.store.pending(), [])

    def test_authoritative_remote_omission_and_explicit_null_are_not_resurrected(self):
        remote = {k: v for k, v in self.original.items() if k not in MESSAGE_PROCESS_FIELDS}
        self.store.apply_changes([change('messages', wire_id('chat', 'answer'), remote, 2)], 4)
        for key in MESSAGE_PROCESS_FIELDS: self.assertNotIn(key, self.answer())
        self.store.capture(self.store.snapshot())
        self.assertEqual(self.store.pending(), [])
        snapshot = self.store.snapshot(); self.answer(snapshot)['pendingPlan'] = None
        self.store.capture(snapshot)
        self.assertIsNone(self.answer()['pendingPlan'])

    def test_private_fields_are_filtered_and_modified_plans_become_inert(self):
        original = message(toolEvents=[{'type': 'tool-result', 'output': {'token': 'synthetic-secret', 'kept': 'history'}}])
        original['pendingPlan']['authorization'] = 'synthetic-secret'
        projected = record('messages', original)
        self.assertNotIn('synthetic-secret', json.dumps(projected))
        self.assertEqual(projected['toolEvents'][0]['output'], {'kept': 'history'})
        self.assertEqual(projected['pendingPlan']['status'], 'invalidated')

    def test_invalid_metadata_and_cloud_size_tree_limits_fail_without_partial_capture(self):
        nested = {}; cursor = nested
        for _ in range(33): cursor['child'] = {}; cursor = cursor['child']
        cases = [{'reasoning': {}}, {'status': ['completed']}, {'status': 'x' * 81}, {'pendingPlan': []},
                 {'toolEvents': ['wrong']}, {'capabilities': {'tools': 'yes'}},
                 {'reasoning': 'x' * (4 * 1024 * 1024)}, {'toolEvents': [{}] * 20000}, {'pendingPlan': nested}]
        before = self.store.snapshot()
        for fields in cases:
            with self.subTest(fields=list(fields)):
                snapshot = copy(before); self.answer(snapshot).update(fields)
                with self.assertRaises(ValueError): self.store.capture(snapshot)
                self.assertEqual(self.store.snapshot(), before)
                self.assertEqual(self.store.pending(), [])

    def test_legacy_text_only_messages_keep_their_shape(self):
        legacy = {'id': 'legacy', 'role': 'agent', 'text': '旧版桌面正文'}
        self.assertEqual(record('messages', legacy), legacy)
        snapshot = self.store.snapshot(); snapshot['conversations'][0]['messages'].append(legacy)
        self.store.capture(snapshot); self.ack()
        snapshot = self.store.snapshot()
        row = next(m for m in snapshot['conversations'][0]['messages'] if m['id'] == 'legacy')
        row['content'] = row['text']
        self.store.capture(snapshot)
        self.assertEqual(self.store.pending(), [])
        self.assertNotIn('content', next(m for m in self.store.snapshot()['conversations'][0]['messages'] if m['id'] == 'legacy'))


if __name__ == '__main__': unittest.main()
