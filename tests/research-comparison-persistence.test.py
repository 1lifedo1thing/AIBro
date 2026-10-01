"""Research comparison v2 crosses real JS, SQLite, Wiki files and sync projection.

Every workspace is disposable. No GUI, user data, network or model is involved.
Run this file directly; it imports the production server only with an isolated
AI_WORKSTATION_DATA_DIR and uses the installed Node runtime for the real producer.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'app'
sys.path.insert(0, str(APP))
from sync_store import COLLECTIONS, SyncStore, project
from wiki_vault import WikiVault


NODE_BRIDGE = r'''
const fs = require('node:fs');
const Compare = require('./app/source-comparison.js');
const Wiki = require('./app/research-wiki.js');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
(async () => {
  if (input.action === 'generate') {
    const state = input.state;
    let data = Compare.begin(state, [
      {kind: 'note', id: 'source-a'}, {kind: 'note', id: 'source-b'},
      {kind: 'paper', id: 'paper-c'},
    ], {mode: 'research', now: 1234567890000});
    if (data.version !== 2) throw new Error('Research begin must produce the real v2 schema');
    data.title = 'Research synthesis: frozen evidence';
    data.question = 'Which method is supported within the observed setting?';
    data.scope = 'Synthetic observations only; no claim of general applicability.';
    data.openQuestions = 'Does the finding hold outside this small setting?';
    data.criteria[0].id = 'criterion:observed:quality';
    const rowId = data.criteria[0].id;
    for (const source of data.sources) {
      const quote = source.kind === 'paper' ? 'Synthetic method C.' : source.id === 'source-a' ? 'Method A works in setting A.' : 'Method B fails in setting A.';
      data.criteria[0].cells[source.key] = {quote, judgment: `Manual interpretation of ${source.id}.`, relation: source.id === 'source-b' ? 'contradicts' : 'supports', reviewedStamp: ''};
      data = Compare.reviewEvidence(state, data, rowId, source.key);
    }
    data.claims = [{id: 'claim-1', text: 'The available evidence supports a limited conclusion.', evidenceIds: data.sources.map(source => Compare.evidenceId(rowId, source.key))}];
    data.conclusion = 'Use the conclusion only within the stated scope.';
    data.researchStatus = 'ready';
    let saves = 0;
    const controller = Compare.createController({getState: () => state, uid: () => 'research-output', save: async () => { saves++; return true; }});
    const session = await controller.save({data, noteId: null, base: null});
    if (saves !== 1) throw new Error('The real controller did not commit exactly once');
    process.stdout.write(JSON.stringify({state, noteId: session.noteId, base: session.base}));
    return;
  }
  const state = input.state, note = state.notes.find(item => item.id === input.noteId);
  const session = Compare.reopenSession(state, input.noteId);
  const reviewed = [];
  for (const row of session.data.criteria) for (const source of session.data.sources) {
    const old = row.cells[source.key];
    if (!old?.reviewedStamp) continue;
    const refreshed = Compare.reviewEvidence(state, session.data, row.id, source.key);
    reviewed.push({id: Compare.evidenceId(row.id, source.key), before: old.reviewedStamp, after: refreshed.criteria.find(item => item.id === row.id).cells[source.key].reviewedStamp});
  }
  process.stdout.write(JSON.stringify({
    externalChanged: session.externalChanged, base: session.base, data: session.data,
    markdown: Compare.markdown(session.data), reviewed,
    sourceStatuses: session.data.sources.map(source => Compare.sourceStatus(state, source)),
    wikiIds: Wiki.entries(state, {type: 'output'}).map(item => item.id),
    wikiType: Wiki.typeOf(note), researchView: Compare.researchView(state, session.data),
  }));
})().catch(error => { process.stderr.write(error.stack || String(error)); process.exitCode = 1; });
'''


def workspace(**values):
    state = {kind: [] for kind in COLLECTIONS}
    state.update(folders={'projects': [], 'conversations': []}, agentRuns=[], _revision=0)
    state.update(values)
    return state


def source_workspace():
    shared = {'projectId': 'research-project', 'workspace': '科研', 'createdAt': 100, 'updatedAt': 200}
    return workspace(
        projects=[{'id': 'research-project', 'name': 'Synthetic research', 'workspace': '科研'}],
        notes=[
            {**shared, 'id': 'source-a', 'title': 'Observation A', 'content': 'Method A works in setting A. Its applicability elsewhere is unknown.'},
            {**shared, 'id': 'source-b', 'title': 'Observation B', 'content': 'Method B fails in setting A. This is a synthetic negative observation.'},
        ],
        # Deliberately non-alphabetical field insertion order. Python's durable
        # JSON projection sorts keys; that must not invalidate unchanged sources.
        papers=[{**shared, 'id': 'paper-c', 'title': 'Saved paper C',
                 'structured': {'methods': 'Synthetic method C.', 'abstract': 'A bounded saved paper record.'},
                 'authors': ['Example Researcher'], 'year': 2026}],
    )


class ResearchComparisonPersistenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.node = os.environ.get('NODE') or shutil.which('node')
        if not cls.node:
            raise RuntimeError('These persistence tests require Node to generate the real comparison note')
        cls.import_home = tempfile.TemporaryDirectory(prefix='research-comparison-server-import-')
        cls.addClassCleanup(cls.import_home.cleanup)
        with patch.dict(os.environ, {'AI_WORKSTATION_DATA_DIR': cls.import_home.name, 'AI_WORKSTATION_ASSET_DIR': str(APP)}):
            spec = importlib.util.spec_from_file_location('research_comparison_test_server', APP / 'server.py')
            cls.server = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.server)
        cls.generated = cls.node_call({'action': 'generate', 'state': source_workspace()})

    @classmethod
    def node_call(cls, value):
        result = subprocess.run([cls.node, '-e', NODE_BRIDGE], cwd=ROOT,
                                input=json.dumps(value, ensure_ascii=False), text=True,
                                capture_output=True, timeout=30, check=False)
        if result.returncode:
            raise AssertionError(f'Real SourceComparison producer/reopen failed:\n{result.stderr}')
        return json.loads(result.stdout)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='research-comparison-persistence-')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.store = self.server.WorkspaceStore(self.directory / 'device-a')
        self.original = copy.deepcopy(self.generated['state'])
        self.note_id = self.generated['noteId']
        self.original_note = self.note(self.original)
        self.metadata = copy.deepcopy(self.original_note['sourceComparison'])

    def note(self, state):
        return next(item for item in state['notes'] if item['id'] == self.note_id)

    def save_and_reload(self):
        response = self.store.save(copy.deepcopy(self.original), enable_wiki=True)
        self.assertTrue(response['ok'])
        reloaded = self.server.WorkspaceStore(self.store.directory).load()
        self.assertNotIn('_wikiError', reloaded); self.assertNotIn('_wikiErrors', reloaded)
        return reloaded

    def assert_metadata(self, note):
        data = note['sourceComparison']
        self.assertEqual(data, self.metadata)
        self.assertEqual(data['version'], 2)
        self.assertEqual(data['question'], 'Which method is supported within the observed setting?')
        self.assertEqual(data['scope'], 'Synthetic observations only; no claim of general applicability.')
        self.assertEqual(data['researchStatus'], 'ready')
        self.assertEqual(len(data['claims']), 1)
        evidence_ids = data['claims'][0]['evidenceIds']
        self.assertEqual(len(evidence_ids), 3); self.assertEqual(len(set(evidence_ids)), 3)
        self.assertEqual(data['criteria'][0]['id'], 'criterion:observed:quality')
        self.assertEqual(len([cell for cell in data['criteria'][0]['cells'].values() if cell['reviewedStamp']]), 3)

    def assert_js_reopens(self, state, external=False):
        report = self.node_call({'action': 'inspect', 'state': state, 'noteId': self.note_id})
        self.assertEqual(report['externalChanged'], external)
        if not external:
            self.assertEqual(report['base'], self.generated['base'], 'Durable key ordering or Wiki metadata caused a false note version change')
        self.assertEqual(report['data'], self.metadata)
        self.assertIn(self.note_id, report['wikiIds']); self.assertEqual(report['wikiType'], 'output')
        self.assertEqual(len(report['reviewed']), 3)
        self.assertTrue(report['researchView']['ready'])
        self.assertEqual(report['researchView']['counts']['confirmed'], 3)
        self.assertTrue(all(claim['valid'] for claim in report['researchView']['claims']))
        for item in report['reviewed']:
            self.assertEqual(item['before'], item['after'], 'Unchanged evidence became unreviewed after key sorting')
        for status in report['sourceStatuses']:
            self.assertTrue(status['available']); self.assertFalse(status['stale'])
        return report

    def test_generated_research_note_survives_workspace_restart_json_and_actual_wiki_output(self):
        loaded = self.save_and_reload()
        note = self.note(loaded); self.assert_metadata(note)
        self.assertEqual(note['kind'], '科研 Wiki/output'); self.assertEqual(note['workspace'], '科研')
        self.assertEqual(note['content'], self.original_note['content'])
        exported = json.loads(self.store.path.read_text())
        self.assert_metadata(self.note(exported))
        # Force the same sorted-key transport shape used by SyncStore.dump.
        sorted_state = json.loads(json.dumps(loaded, ensure_ascii=False, sort_keys=True))
        self.assert_js_reopens(sorted_state)
        relative = loaded['_wikiFiles'][self.note_id]['path']
        self.assertTrue(relative.startswith('outputs/'), relative)
        markdown_path = self.store.wiki.path(relative)
        self.assertTrue(markdown_path.is_file())
        title, body = self.store.wiki.decode(markdown_path.read_bytes(), self.note_id)
        self.assertEqual(title, note['title']); self.assertEqual(body, note['content'])
        self.assertIn(self.metadata['question'], body); self.assertIn(self.metadata['scope'], body)
        self.assertIn(self.metadata['claims'][0]['text'], body)

    def test_sync_peer_roundtrip_preserves_claim_links_reviewed_stamps_and_research_discovery(self):
        loaded = self.save_and_reload()
        pending = self.store.sync.pending(limit=100)
        output = next(item for item in pending if item['entityType'] == 'notes' and item['entityId'] == self.note_id)
        self.assert_metadata(output['data'])
        peer = SyncStore(self.directory / 'sync-peer')
        peer.capture(workspace())
        peer.apply_changes([{**operation, 'version': 1, 'seq': index + 1} for index, operation in enumerate(pending)], len(pending))
        received = SyncStore(peer.directory).snapshot()
        self.assert_metadata(self.note(received))
        self.assertEqual(project(received), project(loaded))
        self.assert_js_reopens(received)
        # Import the peer's real projection into another WorkspaceStore and
        # publish its own Markdown, rather than merely asserting dict equality.
        peer_workspace = self.server.WorkspaceStore(self.directory / 'peer-workspace')
        received['_revision'] = 0
        peer_workspace.save(received, enable_wiki=True)
        peer_loaded = self.server.WorkspaceStore(peer_workspace.directory).load()
        self.assert_metadata(self.note(peer_loaded)); self.assert_js_reopens(peer_loaded)
        relative = peer_loaded['_wikiFiles'][self.note_id]['path']
        self.assertTrue(peer_workspace.wiki.path(relative).is_file())

    def test_external_markdown_edit_preserves_comparison_metadata_and_records_real_revision(self):
        before = self.save_and_reload(); old_note = copy.deepcopy(self.note(before))
        relative = before['_wikiFiles'][self.note_id]['path']; path = self.store.wiki.path(relative)
        outside_body = old_note['content'] + '\n## External research note\n\nA human added this observation outside the app.\n'
        outside_bytes = WikiVault.encode({**old_note, 'content': outside_body})
        path.write_bytes(outside_bytes)
        loaded = self.server.WorkspaceStore(self.store.directory).load()
        self.assertNotIn('_wikiErrors', loaded); self.assertNotIn('_wikiError', loaded)
        note = self.note(loaded); self.assertEqual(note['content'], outside_body); self.assert_metadata(note)
        self.assertEqual(loaded['_revision'], before['_revision'] + 1)
        previous = note['revisionHistory'][-1]
        self.assertEqual(previous['reason'], 'wiki-external-edit')
        self.assertEqual(previous['title'], old_note['title']); self.assertEqual(previous['content'], old_note['content'])
        self.assert_metadata(previous)
        self.assertIsNot(previous['sourceComparison'], note['sourceComparison'])
        self.assertIsNot(previous['sourceComparison']['claims'], note['sourceComparison']['claims'])
        self.assertGreater(note['updatedAt'], old_note['updatedAt'])
        self.assert_js_reopens(loaded, external=True)
        self.assertEqual(path.read_bytes(), outside_bytes, 'Loading must not rewrite the external edit')
        second = self.server.WorkspaceStore(self.store.directory).load()
        self.assertEqual(second['_revision'], loaded['_revision'])
        self.assertEqual(self.note(second)['revisionHistory'], note['revisionHistory'])
        self.assert_metadata(self.note(second)); self.assert_js_reopens(second, external=True)
        operations = self.store.sync.pending(limit=100)
        peer = SyncStore(self.directory / 'edited-peer'); peer.capture(workspace())
        peer.apply_changes([{**operation, 'version': 1, 'seq': index + 1} for index, operation in enumerate(operations)], len(operations))
        peer_state = SyncStore(peer.directory).snapshot()
        self.assert_metadata(self.note(peer_state))
        self.assert_metadata(self.note(peer_state)['revisionHistory'][-1])
        self.assert_js_reopens(peer_state, external=True)
        previous['sourceComparison']['claims'][0]['text'] = 'Mutating in-memory history only'
        first_cell = next(iter(previous['sourceComparison']['criteria'][0]['cells'].values()))
        first_cell['reviewedStamp'] = 'History-only mutation'
        self.assert_metadata(note)
        self.assert_metadata(self.note(self.server.WorkspaceStore(self.store.directory).load())['revisionHistory'][-1])


if __name__ == '__main__':
    unittest.main()
