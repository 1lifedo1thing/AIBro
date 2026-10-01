"""Full supplied-page metadata and strict excerpt-state projection; disposable data only."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from sync_store import COLLECTIONS, SyncStore, clean_provenance, record


def source(page, **extra):
    return {'type': 'import', 'id': 'long-paper', 'sourceId': f'page-evidence-{page}',
            'title': 'Long document', 'provided': True, 'page': page, 'offset': 0, 'end': 1500,
            'capturedAt': 100, 'variant': 'current', 'version': 'stable-version',
            'excerptState': 'retained' if page <= 2 else 'omitted', 'excerptCharacters': 1500,
            'textRepresentation': 'normalized-page', **extra}


def provenance(inputs=None, **extra):
    return {'version': 1, 'output': {'type': 'note', 'id': 'note-a', 'variant': 'body'},
            'origin': {'recorded': True, 'runId': 'run-a'}, 'operation': 'created',
            'inputs': inputs if inputs is not None else [source(1)],
            'omittedInputs': 0, 'evidenceLimitReached': False,
            'evidenceExcerptLimitReached': True, **extra}


def workspace(notes):
    return {**{kind: [] for kind in COLLECTIONS}, 'notes': notes,
            'folders': {'projects': [], 'conversations': []}, 'agentRuns': [], '_revision': 1}


class ProvenanceEvidenceSyncTests(unittest.TestCase):
    def test_all_1024_supplied_pages_survive_projection_with_no_body_or_secret_fields(self):
        inputs = [source(page, excerpt='SECRET_EXCERPT', text='SECRET_BODY',
                         metadata={'token': 'SECRET_NESTED'}, authorization='SECRET_AUTH')
                  for page in range(1, 1025)]
        original = provenance(inputs + [copy.deepcopy(inputs[0]), copy.deepcopy(inputs[-1])])
        before = copy.deepcopy(original)
        projected = clean_provenance(original)
        self.assertEqual(original, before)
        self.assertEqual(len(projected['inputs']), 1024)
        self.assertEqual([item['page'] for item in projected['inputs']], list(range(1, 1025)))
        self.assertEqual(projected['inputs'][-1], source(1024))
        self.assertTrue(projected['evidenceExcerptLimitReached'])
        self.assertFalse(projected['evidenceLimitReached'])
        self.assertEqual(projected['omittedInputs'], 0)
        self.assertNotIn('SECRET_', json.dumps(projected))

    def test_only_identical_portable_metadata_is_deduplicated(self):
        first = source(129)
        distinct = [source(130), source(129, sourceId='another-delivery'),
                    source(129, version='later-version'), source(129, capturedAt=200),
                    source(129, excerptState='retained'), source(129, excerptCharacters=1200)]
        saved = clean_provenance(provenance([first, {**first, 'rawPayload': 'SECRET_IGNORED'}, *distinct]))
        self.assertEqual(saved['inputs'], [first, *distinct])
        self.assertEqual(clean_provenance(saved), saved, 'projection stays idempotent across peers')

    def test_new_fields_reject_nested_values_controls_unknown_enums_and_non_integer_counts(self):
        invalids = [None, True, -1, 1.5, 9007199254740992, '1500', [], {'value': 'SECRET_COUNT'}]
        for index, invalid in enumerate(invalids):
            with self.subTest(invalid=invalid):
                saved = clean_provenance(provenance([source(index + 1,
                    excerptState=invalid, excerptCharacters=invalid, textRepresentation=invalid)],
                    evidenceExcerptLimitReached=invalid))
                item = saved['inputs'][0]
                for key in ('excerptState', 'excerptCharacters', 'textRepresentation'):
                    self.assertNotIn(key, item)
                if type(invalid) is bool:
                    self.assertEqual(saved['evidenceExcerptLimitReached'], invalid)
                else:
                    self.assertNotIn('evidenceExcerptLimitReached', saved)
                self.assertNotIn('SECRET_', json.dumps(saved))
        for value in ('retained\nSECRET_CONTROL', 'retained-other', 'normalized-page\x00'):
            item = clean_provenance(provenance([source(1, excerptState=value, textRepresentation=value)]))['inputs'][0]
            self.assertNotIn('excerptState', item)
            self.assertNotIn('textRepresentation', item)
        for characters in (0, 262144, 9007199254740991):
            self.assertEqual(clean_provenance(provenance([source(1, excerptCharacters=characters)]))['inputs'][0]['excerptCharacters'], characters)

    def test_legacy_limit_flags_keep_their_original_meaning(self):
        for old_limit, new_limit in ((True, False), (False, True), (True, True)):
            saved = clean_provenance(provenance([source(page) for page in range(1, 201)],
                omittedInputs=17, evidenceLimitReached=old_limit, evidenceExcerptLimitReached=new_limit))
            self.assertEqual(len(saved['inputs']), 200)
            self.assertEqual(saved['omittedInputs'], 17)
            self.assertIs(saved['evidenceLimitReached'], old_limit)
            self.assertIs(saved['evidenceExcerptLimitReached'], new_limit)
        legacy = provenance(); legacy.pop('evidenceExcerptLimitReached')
        self.assertNotIn('evidenceExcerptLimitReached', clean_provenance(legacy))

    def test_late_invalid_inputs_still_use_the_same_schema_and_local_path_redaction(self):
        inputs = [source(page) for page in range(1, 151)]
        inputs += [None, [], 'raw', {'type': 'import', 'id': 'bad', 'provided': 1},
                   {'type': 'unknown', 'id': 'bad', 'provided': True},
                   {'type': 'import', 'id': {'path': 'SECRET_TYPED'}, 'provided': True},
                   {'type': 'import', 'id': 'bad\nSECRET_CONTROL', 'provided': True},
                   {'type': 'local', 'id': '/private/SECRET_PATH', 'title': '/private/SECRET_TITLE',
                    'provided': True, 'sourceId': 'local-evidence', 'version': '/private/SECRET_VERSION',
                    'refKey': '/private/SECRET_REF', 'candidateId': 'SECRET_CANDIDATE',
                    'excerptState': 'omitted', 'excerptCharacters': 40, 'textRepresentation': 'normalized-page'}]
        saved = clean_provenance(provenance(inputs))
        self.assertEqual(len(saved['inputs']), 151)
        self.assertEqual(saved['inputs'][-1], {'type': 'local', 'provided': True, 'sourceId': 'local-evidence',
            'excerptState': 'omitted', 'excerptCharacters': 40, 'textRepresentation': 'normalized-page'})
        self.assertNotIn('SECRET_', json.dumps(saved))

    def test_full_metadata_survives_outbox_restart_incoming_projection_and_note_history(self):
        evidence = provenance([source(page, excerpt='SECRET_EXCERPT') for page in range(1, 301)],
                              omittedInputs=4, evidenceLimitReached=True)
        note = {'id': 'note-a', 'title': 'Fixture', 'content': 'Approved text', 'provenance': evidence,
                'aiDraft': {'content': 'Draft', 'provenance': copy.deepcopy(evidence)},
                'revisionHistory': [{'content': 'Previous', 'provenance': copy.deepcopy(evidence)}],
                'aiDraftHistory': [{'draft': {'content': 'Old draft', 'provenance': copy.deepcopy(evidence)}}]}
        original = workspace([note]); before = copy.deepcopy(original)
        with tempfile.TemporaryDirectory(prefix='aibro-provenance-evidence-sync-') as directory:
            first = SyncStore(Path(directory) / 'device-a'); first.capture(original)
            restarted = SyncStore(first.directory)
            self.assertEqual(restarted.snapshot(), before, 'exact local snapshot stays intact')
            operations = restarted.pending()
            self.assertEqual(len(operations), 1)
            self.assertNotIn('SECRET_', json.dumps(operations))
            peer = SyncStore(Path(directory) / 'device-b'); peer.capture(workspace([]))
            peer.apply_changes([{**operations[0], 'seq': 1, 'version': 1}], 1)
            received = SyncStore(peer.directory).snapshot()['notes'][0]
            self.assertEqual(received, record('notes', note))
            for holder in (received, received['aiDraft'], received['revisionHistory'][0], received['aiDraftHistory'][0]['draft']):
                saved = holder['provenance']
                self.assertEqual(len(saved['inputs']), 300)
                self.assertEqual(saved['inputs'][-1], source(300))
                self.assertTrue(saved['evidenceExcerptLimitReached'])
                self.assertTrue(saved['evidenceLimitReached'])
                self.assertEqual(saved['omittedInputs'], 4)
        self.assertEqual(original, before)


if __name__ == '__main__': unittest.main()
