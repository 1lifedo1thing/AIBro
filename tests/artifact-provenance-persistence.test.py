"""Portable artifact origins and Wiki revisions, using disposable data only."""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from sync_store import COLLECTIONS, SyncStore, project, record
from wiki_vault import WikiVault


def workspace(**values):
    state = {kind: [] for kind in COLLECTIONS}
    state.update(folders={'projects': [], 'conversations': []}, agentRuns=[], _revision=1)
    state.update(values)
    return state


def provenance(kind='note', identifier='note-a', variant='body', run='run-a'):
    return {
        'version': 1, 'output': {'type': kind, 'id': identifier, 'variant': variant},
        'operation': 'drafted' if variant == 'draft' else 'created', 'outputStamp': 'artifact-v1-example',
        'origin': {'recorded': True, 'runId': run, 'conversationId': 'chat-a', 'userMessageId': 'message-a',
                   'at': 100, 'model': 'fixture-model', 'provider': 'fixture-provider', 'effort': 'high', 'private': False},
        'inputs': [{'type': 'note', 'id': 'source-a', 'title': 'Historical source title', 'sourceId': 'ev1-1',
                    'projectId': None, 'variant': 'draft', 'provided': True, 'page': None, 'offset': 0, 'end': 8,
                    'version': None, 'capturedAt': 90, 'origin': 'read', 'media': None,
                    'bodyHash': 'draft-hash', 'bodyVariant': 'draft', 'bodyFormat': 'canonical-v1', 'private': False}],
        'omittedInputs': 0, 'evidenceLimitReached': False,
    }


def rich_note():
    return {'id': 'note-a', 'title': 'Synthetic note', 'content': 'Approved body', 'workspace': '科研',
            'provenance': provenance(),
            'aiDraft': {'title': 'Pending', 'content': 'Pending body', 'provenance': provenance(variant='draft', run='run-b')},
            'revisionHistory': [{'title': 'Previous', 'content': 'Previous body', 'provenance': provenance(run='run-old')}],
            'aiDraftHistory': [
                {'title': 'Old proposal', 'content': 'Old draft', 'provenance': provenance(variant='draft', run='run-old-draft'), 'reason': 'extended'},
                {'action': 'discard', 'draft': {'content': 'Discarded', 'provenance': provenance(variant='draft', run='run-discarded')}}]}


def dirty(value):
    value = copy.deepcopy(value)
    value.update(extra={'innocentName': 'SECRET_EXTRA'}, apiKey='SECRET_API', path='/private/SECRET_PATH',
                 provenance={'version': 99, 'payload': 'SECRET_UNKNOWN'})
    value['output'].update(unknown={'value': 'SECRET_OUTPUT'}, credentials={'token': 'SECRET_CREDENTIALS'})
    value['origin'].update(auth={'token': 'SECRET_AUTH'}, metadata={'value': 'SECRET_ORIGIN'}, API_Key='SECRET_API')
    value['inputs'][0].update(refKey='/private/SECRET_REF', candidateId='SECRET_CANDIDATE', path='/private/SECRET_PATH',
                              unknown={'value': 'SECRET_INPUT'}, secret='SECRET_INPUT_KEY')
    value['inputs'].append({'type': 'local', 'id': '["local","folder","/private/SECRET_LOCAL"]',
        'title': '/private/SECRET_LOCAL', 'sourceId': 'ev1-2', 'projectId': None, 'candidateId': 'SECRET_CANDIDATE',
        'refKey': '/private/SECRET_REF', 'path': '/private/SECRET_LOCAL', 'variant': 'current', 'provided': True,
        'version': 'a' * 64, 'capturedAt': 90, 'origin': 'read_file', 'page': None, 'offset': 0, 'end': 8})
    return value


class ArtifactProvenancePersistenceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='artifact-provenance-persistence-')
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.store = SyncStore(self.directory / 'device-a')

    def peer(self, operations, name='device-b'):
        peer = SyncStore(self.directory / name)
        peer.capture(workspace())
        peer.apply_changes([{**op, 'version': 1, 'seq': index + 1} for index, op in enumerate(operations)], len(operations))
        return peer

    def test_all_artifact_and_note_history_origins_survive_restart_and_peer_without_run_logs(self):
        note = rich_note()
        task = {'id': 'task-a', 'title': 'Task', 'provenance': provenance('task', 'task-a')}
        paper = {'id': 'paper-a', 'title': 'Paper', 'provenance': provenance('paper', 'paper-a')}
        snapshot = workspace(notes=[note], tasks=[task], papers=[paper])
        self.store.capture(snapshot)
        restarted = SyncStore(self.store.directory)
        self.assertEqual(restarted.snapshot(), snapshot)
        peer = self.peer(restarted.pending())
        received = peer.snapshot()
        for kind in ('notes', 'tasks', 'papers'): self.assertEqual(received[kind], snapshot[kind])
        self.assertEqual(received['agentRuns'], [])
        self.assertEqual(project(received), project(snapshot))

    def test_nested_schema_and_local_path_redaction_preserve_the_exact_local_snapshot(self):
        note = rich_note()
        for holder in [note, note['aiDraft'], note['revisionHistory'][0], note['aiDraftHistory'][0], note['aiDraftHistory'][1]['draft']]:
            holder['provenance'] = dirty(holder['provenance'])
            holder['credentials'] = {'token': 'SECRET_HOLDER'}
        note['aiDraft']['metadata'] = {'provenance': dirty(provenance()), 'path': '/private/SECRET_METADATA'}
        note['revisionHistory'].append({'content': 'Keep body', 'provenance': {'version': 99, 'payload': 'SECRET_UNKNOWN'}})
        snapshot = workspace(notes=[note])
        before = copy.deepcopy(snapshot)
        self.store.capture(snapshot)
        self.assertEqual(snapshot, before)
        self.assertEqual(SyncStore(self.store.directory).snapshot(), before)
        operations = self.store.pending()
        self.assertNotIn('SECRET_', json.dumps(operations))
        public = operations[0]['data']
        for holder in [public, public['aiDraft'], public['revisionHistory'][0], public['aiDraftHistory'][0], public['aiDraftHistory'][1]['draft']]:
            saved = holder['provenance']
            self.assertEqual(saved['inputs'][0]['bodyVariant'], 'draft')
            self.assertEqual(saved['inputs'][0]['bodyFormat'], 'canonical-v1')
            local = saved['inputs'][1]
            for field in ('id', 'title', 'candidateId', 'refKey', 'path'): self.assertNotIn(field, local)
            self.assertEqual(local['version'], 'a' * 64)
            self.assertEqual(local['sourceId'], 'ev1-2')
        self.assertNotIn('provenance', public['revisionHistory'][1])
        self.assertNotIn('provenance', public['aiDraft']['metadata'])
        self.assertEqual(self.peer(operations).snapshot()['notes'][0], public)

    def test_incoming_records_and_trash_use_the_same_strict_projection(self):
        note = rich_note(); note['provenance'] = dirty(note['provenance'])
        trash = {'id': 'trash-a', 'type': 'note', 'data': {'notes': [copy.deepcopy(note)]}}
        peer = self.peer([{'entityType': 'notes', 'entityId': 'note-a', 'deleted': False, 'data': note},
                          {'entityType': 'trash', 'entityId': 'trash-a', 'deleted': False, 'data': trash}])
        received = peer.snapshot()
        self.assertEqual(received['notes'][0], record('notes', note))
        self.assertEqual(received['trash'][0]['data']['notes'][0], record('notes', note))
        self.assertNotIn('SECRET_', json.dumps(received))

    def test_provenance_is_allowed_only_at_supported_artifact_positions(self):
        for kind in ('projects', 'imports', 'conversations', 'attachments', 'links', 'skills', 'messages'):
            self.assertNotIn('provenance', record(kind, {'id': 'x', 'provenance': provenance()}))
        note = rich_note()
        note['sourceComparison'] = {'provenance': provenance(), 'criteria': [{'provenance': provenance()}]}
        task = {'id': 'task-a', 'checklist': [{'title': 'Keep', 'provenance': provenance()}]}
        paper = {'id': 'paper-a', 'metadata': {'provenance': provenance()}}
        public = record('notes', note)
        self.assertEqual(public['sourceComparison'], {'criteria': [{}]})
        self.assertEqual(record('tasks', task)['checklist'], [{'title': 'Keep'}])
        self.assertEqual(record('papers', paper)['metadata'], {})

    def test_invalid_types_unknown_versions_and_scalar_path_smuggling_do_not_expand_schema(self):
        for invalid in (None, [], 'raw', {'version': True}, {'version': 2}):
            self.assertNotIn('provenance', record('notes', {'provenance': invalid}))
        saved = provenance()
        saved['origin']['model'] = {'token': 'SECRET_TYPED'}
        saved['inputs'][0]['title'] = {'nested': 'SECRET_TYPED'}
        saved['inputs'][0]['bodyFormat'] = 'unknown-format'
        saved['inputs'].extend([None, 'wrong', {'type': 'note', 'id': {'path': 'SECRET_TYPED'}, 'provided': True},
                               {'type': 'local', 'provided': True, 'version': '/private/SECRET_VERSION'}])
        saved['omittedInputs'] = True
        projected = record('notes', {'provenance': saved})['provenance']
        self.assertNotIn('model', projected['origin'])
        self.assertNotIn('title', projected['inputs'][0])
        self.assertNotIn('bodyFormat', projected['inputs'][0])
        self.assertEqual(len(projected['inputs']), 2)
        self.assertNotIn('version', projected['inputs'][1])
        self.assertNotIn('omittedInputs', projected)
        self.assertNotIn('SECRET_', json.dumps(projected))

    def test_remote_removal_does_not_restore_provenance_or_draft_history_as_local_fields(self):
        self.store.capture(workspace(notes=[rich_note()]))
        operation = self.store.pending()[0]
        self.store.ack([{'opId': operation['opId'], 'version': 1}])
        self.store.apply_changes([{'entityType': 'notes', 'entityId': 'note-a', 'version': 2, 'deleted': False,
                                   'data': {'id': 'note-a', 'title': 'Manual', 'content': 'No origin'}}], 1)
        received = self.store.snapshot()['notes'][0]
        self.assertNotIn('provenance', received)
        self.assertNotIn('aiDraftHistory', received)

    def test_workspace_save_restart_and_json_restore_keep_all_provenance_versions(self):
        # server constructs a default WorkspaceStore on import; keep that
        # import and both real persistence paths inside disposable directories.
        with patch.dict(os.environ, {'AI_WORKSTATION_DATA_DIR': str(self.directory / 'server-host')}):
            from server import WorkspaceStore
        original = rich_note()
        first = WorkspaceStore(self.directory / 'workspace-a')
        first.save(workspace(notes=[original], _revision=0))
        restarted = WorkspaceStore(first.directory).load()
        self.assertEqual(restarted['notes'][0], original)
        exported = first.path.read_bytes()
        restored = json.loads(exported)
        self.assertEqual(restored['notes'][0], original)
        restored['_revision'] = 0
        second = WorkspaceStore(self.directory / 'workspace-b')
        second.save(restored)
        received = WorkspaceStore(second.directory).load()
        self.assertEqual(received['notes'][0], original)
        self.assertEqual(project(received)[('notes', original['id'])], project(restarted)[('notes', original['id'])])

    def test_external_wiki_edits_keep_old_body_sources_without_changing_current_origin_or_draft(self):
        for in_trash in (False, True):
            with self.subTest(in_trash=in_trash):
                root = self.directory / ('trashed' if in_trash else 'active'); root.mkdir()
                vault = WikiVault(root)
                note = rich_note()
                note.update(kind='科研 Wiki/method', sourceNoteIds=['source-note'], sourceAttachmentIds=['source-pdf'],
                            wikiSourceLinks={'figure.png': 'source-image'})
                relative = vault.relative(note); raw = vault.encode(note)
                path = vault.path(relative); path.parent.mkdir(parents=True); path.write_bytes(raw)
                snapshot = workspace(notes=[] if in_trash else [note],
                    trash=[{'id': 'trash-a', 'data': {'notes': [note]}}] if in_trash else [],
                    _wikiFiles={note['id']: {'path': relative, 'hash': vault.digest(raw)}})
                before = copy.deepcopy(snapshot)
                external = vault.encode({**note, 'content': 'Edited outside the app'})
                path.write_bytes(external)
                result, changed, errors = vault.reconcile(snapshot)
                self.assertTrue(changed); self.assertEqual(errors, []); self.assertEqual(snapshot, before)
                current = WikiVault.notes(result)[0]; previous = current['revisionHistory'][-1]
                self.assertEqual(previous['content'], note['content'])
                self.assertEqual(previous['reason'], 'wiki-external-edit')
                for field in ('provenance', 'sourceNoteIds', 'sourceAttachmentIds', 'wikiSourceLinks'):
                    self.assertEqual(previous[field], note[field])
                    self.assertEqual(current[field], note[field])
                    self.assertIsNot(previous[field], current[field])
                self.assertEqual(current['aiDraft'], note['aiDraft'])
                self.assertEqual(path.read_bytes(), external)
                persisted = SyncStore(root / 'database'); persisted.capture(result)
                self.assertEqual(SyncStore(persisted.directory).snapshot(), result)
                again, changed, errors = vault.reconcile(result)
                self.assertFalse(changed); self.assertEqual(errors, [])
                self.assertEqual(again, result)
                previous['provenance']['origin']['runId'] = 'mutated-history'
                previous['sourceNoteIds'].append('history-only')
                self.assertEqual(current['provenance']['origin']['runId'], note['provenance']['origin']['runId'])
                self.assertEqual(current['sourceNoteIds'], ['source-note'])


if __name__ == '__main__': unittest.main()
