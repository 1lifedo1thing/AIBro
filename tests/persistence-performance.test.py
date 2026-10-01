"""Observable save-efficiency contracts with isolated rollback and merge fixtures."""
import copy
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

_host = tempfile.TemporaryDirectory(prefix='aibro-save-test-host-')
os.environ.setdefault('AI_WORKSTATION_DATA_DIR', _host.name)
from server import ConflictError, WorkspaceStore
from sync_store import SyncStore


def fixture():
    value = {key: [] for key in ('projects', 'tasks', 'notes', 'imports', 'conversations', 'trash', 'agentRuns', 'papers', 'links', 'attachments')}
    value.update(_revision=0, ui={})
    value['notes'] = [dict(id='note', title='Synthetic note', content='Original evidence', workspace='科研', kind='科研 Wiki/method')]
    value['conversations'] = [dict(id='chat', title='Synthetic chat', messages=[dict(id=f'm{i}', text='Preserved transcript ' * 100, role='user') for i in range(80)])]
    return value


class SavePerformanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aibro-save-regression-'); self.addCleanup(self.temp.cleanup)
        self.store = WorkspaceStore(self.temp.name); self.store.save(fixture())

    def database(self):
        with self.store.sync.db() as db:
            return {table: sorted(tuple(row) for row in db.execute('SELECT * FROM ' + table)) for table in ('meta', 'entities', 'outbox', 'sent', 'conflicts')}

    def test_first_save_and_status_initialize_fresh_database_concurrently(self):
        for index in range(40):
            with self.subTest(index=index):
                directory = Path(self.temp.name) / ('fresh-' + str(index))
                store = WorkspaceStore(directory); peer = SyncStore(directory)
                barrier = threading.Barrier(2)
                def save():
                    barrier.wait(timeout=5)
                    return store.save(fixture())
                def status():
                    barrier.wait(timeout=5)
                    return peer.status()
                with ThreadPoolExecutor(max_workers=2) as pool:
                    pending = [pool.submit(save), pool.submit(status)]
                    result, _ = [future.result(timeout=15) for future in pending]
                self.assertTrue(result['ok'])
                self.assertEqual(store.load()['notes'][0]['content'], 'Original evidence')
                with store.sync.db() as db:
                    self.assertEqual(db.execute('PRAGMA journal_mode').fetchone()[0], 'wal')
                    self.assertEqual(db.execute('PRAGMA synchronous').fetchone()[0], 2)
                    self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')

    def test_configuration_waits_for_other_process_transaction_and_lock_releases_after_failure(self):
        child_source = '''
import sys
from sync_store import SyncStore
with SyncStore(sys.argv[1]).db() as db:
    print('ready', flush=True)
    sys.stdin.readline()
'''
        environment = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1] / 'app'), PYTHONDONTWRITEBYTECODE='1')
        child = subprocess.Popen([sys.executable, '-c', child_source, self.temp.name], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=environment)
        attempted, connected = threading.Event(), threading.Event()
        connect = sqlite3.connect
        def observe_connection(*args, **kwargs):
            connected.set()
            return connect(*args, **kwargs)
        def status():
            attempted.set()
            return SyncStore(self.temp.name).status()
        try:
            self.assertEqual(child.stdout.readline().strip(), 'ready')
            with patch('sync_store.sqlite3.connect', side_effect=observe_connection), ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(status)
                try:
                    self.assertTrue(attempted.wait(5))
                    self.assertFalse(connected.wait(0.15), 'A second process must not configure WAL before the first transaction ends')
                finally:
                    child.stdin.write('\n'); child.stdin.flush()
                pending.result(timeout=15)
            self.assertEqual(child.wait(timeout=5), 0)
            self.assertTrue(connected.is_set())
        finally:
            if child.poll() is None: child.kill()
            child.communicate(timeout=5)
        with self.assertRaisesRegex(OSError, 'Synthetic failure'):
            with self.store.sync.db() as db:
                db.execute("INSERT INTO meta VALUES ('must-rollback', 'true')")
                raise OSError('Synthetic failure')
        with SyncStore(self.temp.name).db() as db:
            self.assertIsNone(db.execute("SELECT 1 FROM meta WHERE key='must-rollback'").fetchone())
        self.store.save(self.store.load())

    def test_sqlite_coordination_lock_rejects_symlink_without_touching_target(self):
        directory = Path(self.temp.name) / 'unsafe-lock'; directory.mkdir()
        target = Path(self.temp.name) / 'unrelated'; target.write_text('untouched')
        (directory / '.sqlite.lock').symlink_to(target)
        with self.assertRaises(OSError): SyncStore(directory).status()
        self.assertEqual(target.read_text(), 'untouched')
        self.assertFalse((directory / 'workspace.sqlite3').exists())

    def test_ui_only_save_preserves_outbox_operations_and_full_history(self):
        before = self.store.load(); pending = self.store.sync.pending(); baseline = self.database()
        draft = copy.deepcopy(before); draft['ui']['activitySeenAt'] = 42
        result = self.store.save(draft)
        self.assertEqual(result['revision'], before['_revision'] + 1)
        self.assertEqual(self.store.sync.pending(), pending)
        self.assertEqual(self.database()['entities'], baseline['entities'])
        self.assertEqual(self.store.sync.snapshot_at(before['_revision']), before)
        self.assertEqual(WorkspaceStore(self.temp.name).load()['ui'], draft['ui'])

    def test_matching_projection_skips_entity_read_but_not_validation_or_durable_snapshot(self):
        draft = self.store.load(); draft['ui']['expanded'] = True
        with patch.object(self.store.sync, '_capture_entities', side_effect=AssertionError('Unchanged entities must not be reread')):
            self.store.save(draft)
            invalid = self.store.load(); invalid['notes'].append(copy.deepcopy(invalid['notes'][0]))
            with self.assertRaisesRegex(ValueError, '重复 ID'): self.store.save(invalid)
        self.assertTrue(WorkspaceStore(self.temp.name).load()['ui']['expanded'])

    def test_external_entity_writes_invalidate_projection_even_without_using_syncstore(self):
        for operation in ('update', 'delete', 'insert'):
            baseline = self.store.load()
            with sqlite3.connect(self.store.sync.path) as db:
                if operation == 'update': db.execute("UPDATE entities SET data='{}' WHERE kind='notes' AND id='note'")
                elif operation == 'delete': db.execute("DELETE FROM entities WHERE kind='notes' AND id='note'")
                else: db.execute("INSERT INTO entities(kind,id,data,deleted) VALUES ('notes','unexpected','{}',0)")
                self.assertIsNone(db.execute("SELECT value FROM meta WHERE key='captureProjectionDigest'").fetchone())
            with patch.object(self.store.sync, '_capture_entities', wraps=self.store.sync._capture_entities) as capture:
                self.store.save(baseline)
                self.assertEqual(capture.call_count, 1)
            with self.store.sync.db() as db:
                self.assertEqual(json.loads(db.execute("SELECT data FROM entities WHERE kind='notes' AND id='note'").fetchone()['data']), baseline['notes'][0])
                if operation == 'insert': self.assertEqual(db.execute("SELECT deleted FROM entities WHERE kind='notes' AND id='unexpected'").fetchone()['deleted'], 1)

    def test_second_store_ack_invalidates_certificate_and_preserves_new_remote_version(self):
        other = WorkspaceStore(self.temp.name); operation = next(row for row in other.sync.pending() if row['entityType'] == 'notes')
        other.sync.ack([{key: operation[key] for key in ('opId', 'entityType', 'entityId')} | {'version': 12}])
        draft = self.store.load(); draft['notes'][0]['content'] = 'After peer acknowledgement'; self.store.save(draft)
        pending = next(row for row in self.store.sync.pending() if row['entityType'] == 'notes')
        self.assertEqual(pending['baseVersion'], 12); self.assertEqual(pending['data']['content'], 'After peer acknowledgement')

    def test_one_changed_message_preserves_every_other_queued_operation_id(self):
        operations = self.store.sync.pending(); old = {(row['entityType'], row['entityId']): row for row in operations}
        draft = self.store.load(); draft['conversations'][0]['messages'][42]['text'] = 'New one-message content'
        self.store.save(draft)
        new = {(row['entityType'], row['entityId']): row for row in self.store.sync.pending()}
        changed = [key for key in old if old[key] != new[key]]
        self.assertEqual(len(changed), 1); self.assertEqual(changed[0][0], 'messages')
        self.assertEqual(new[changed[0]]['data']['text'], 'New one-message content')
        self.assertNotEqual(new[changed[0]]['opId'], old[changed[0]]['opId'])

    def test_repeated_deletion_keeps_same_pending_tombstone(self):
        draft = self.store.load(); draft['notes'] = []; self.store.save(draft)
        first = next(row for row in self.store.sync.pending() if row['entityType'] == 'notes')
        self.assertTrue(first['deleted'])
        draft = self.store.load(); draft['ui']['expanded'] = True; self.store.save(draft)
        second = next(row for row in self.store.sync.pending() if row['entityType'] == 'notes')
        self.assertEqual(first, second)

    def test_legacy_backup_checks_existence_without_decoding_a_second_snapshot(self):
        with patch.object(self.store.sync, 'snapshot', side_effect=AssertionError('No full snapshot read needed')):
            self.store._backup_legacy()
        self.assertFalse((Path(self.temp.name) / 'workspace.pre-sqlite.json').exists())

    def test_failure_after_publication_rolls_back_snapshot_outbox_and_mirror(self):
        for mode in ('changed-entity', 'matching-projection'):
            with self.subTest(mode=mode):
                before = self.store.load(); original_bytes = self.store.path.read_bytes(); database = self.database()
                draft = copy.deepcopy(before); original = self.store.sync._save_snapshot; count = 0
                if mode == 'changed-entity': draft['notes'][0]['content'] = 'Must roll back'
                else: draft['ui']['expanded'] = 'Must roll back'
                def fail_second(db, snapshot):
                    nonlocal count
                    count += 1
                    if count == 2: raise OSError('Synthetic failure after mirror publication')
                    return original(db, snapshot)
                with patch.object(self.store.sync, '_save_snapshot', side_effect=fail_second):
                    with self.assertRaises(OSError): self.store.save(draft)
                self.assertEqual(self.database(), database); self.assertEqual(self.store.load(), before)
                self.assertEqual(json.loads(self.store.path.read_bytes()), json.loads(original_bytes))

    def test_two_store_instances_merge_parallel_disjoint_changes(self):
        first = self.store.load(); second = copy.deepcopy(first)
        first['notes'][0]['title'] = 'Title from window A'; second['notes'][0]['content'] = 'Content from window B'
        def save(payload): return WorkspaceStore(self.temp.name).save(payload)
        with ThreadPoolExecutor(max_workers=2) as pool: results = list(pool.map(save, [first, second]))
        self.assertEqual(sum('mergedSnapshot' in result for result in results), 1)
        loaded = self.store.load()['notes'][0]
        self.assertEqual(loaded['title'], first['notes'][0]['title']); self.assertEqual(loaded['content'], second['notes'][0]['content'])
        with sqlite3.connect(self.store.sync.path) as db: self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')

    def test_ui_save_preserves_external_wiki_edit_and_conflicting_note_still_rejects(self):
        self.store.enable_wiki(); stale = self.store.load(); entry = stale['_wikiFiles']['note']; path = self.store.wiki.path(entry['path'])
        path.write_text(path.read_text().replace('Original evidence', 'External evidence'))
        draft = copy.deepcopy(stale); draft['ui']['activitySeenAt'] = 10
        result = self.store.save(draft)
        self.assertIn('mergedSnapshot', result); self.assertIn('External evidence', self.store.load()['notes'][0]['content'])
        self.assertIn('External evidence', path.read_text())
        stale['notes'][0]['content'] = 'Conflicting stale edit'
        with self.assertRaises(ConflictError): self.store.save(stale)
        self.assertIn('External evidence', path.read_text())

    def test_failed_wiki_commit_restores_file_and_clears_journal(self):
        self.store.enable_wiki(); before = self.store.load(); path = self.store.wiki.path(before['_wikiFiles']['note']['path']); raw = path.read_bytes()
        draft = copy.deepcopy(before); draft['notes'][0]['content'] = 'Uncommitted wiki body'
        with patch.object(self.store, '_mirror', side_effect=OSError('Synthetic disk failure')):
            with self.assertRaises(OSError): self.store.save(draft)
        self.assertEqual(self.store.load(), before); self.assertEqual(path.read_bytes(), raw); self.assertFalse(self.store.wiki.journal.exists())

    def test_paper_exports_skip_identical_bytes_and_repair_changed_or_missing_exports(self):
        paper = dict(id='paper', title='Synthetic study', workspace='科研', year=2026, structured={'tldr': 'Evidence'})
        draft = self.store.load(); draft['papers'] = [paper]; self.store.save(draft)
        folder = self.store.paper_directory(paper); paths = [folder / 'note.md', folder / 'paper.json']
        expected = [path.read_bytes() for path in paths]; identities = [path.stat().st_ino for path in paths]
        draft = self.store.load(); draft['ui']['expanded'] = True; self.store.save(draft)
        self.assertEqual([path.stat().st_ino for path in paths], identities)
        paths[0].write_text('External change to derived export'); paths[1].unlink()
        self.store.save(self.store.load()); self.assertEqual([path.read_bytes() for path in paths], expected)


if __name__ == '__main__': unittest.main()
