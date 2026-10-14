"""Portable reminder settings: disposable mobile/Desktop projection fixtures only."""
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from sync_store import SyncStore, project, record


class TaskReminderSyncTests(unittest.TestCase):
    def test_mobile_desktop_edit_mobile_roundtrip_preserves_override_and_inherit(self):
        with tempfile.TemporaryDirectory(prefix='aibro-reminder-sync-') as directory:
            desktop = SyncStore(directory)
            values = [('off', None), ('due', 0), ('early', 15), ('week', 10080)]
            changes = [dict(entityType='tasks', entityId=identifier, version=1, deleted=False,
                            data=dict(id=identifier, title=identifier, reminderMinutes=minutes))
                       for identifier, minutes in values]
            changes.append(dict(entityType='tasks', entityId='inherit', version=1, deleted=False,
                                data=dict(id='inherit', title='inherit')))
            desktop.apply_changes(changes, len(changes))
            snapshot = desktop.snapshot()
            for task in snapshot['tasks']:
                task['title'] += ' edited on desktop'
            desktop.capture(snapshot)
            outgoing = {op['entityId']: op['data'] for op in desktop.pending() if op['entityType'] == 'tasks'}
            for identifier, minutes in values:
                self.assertEqual(outgoing[identifier]['reminderMinutes'], minutes)
            self.assertNotIn('reminderMinutes', outgoing['inherit'])

    def test_remote_removal_restores_inheritance_instead_of_retaining_old_override(self):
        with tempfile.TemporaryDirectory(prefix='aibro-reminder-sync-') as directory:
            desktop = SyncStore(directory)
            for version, data in [(1, dict(id='task', title='Fixture', reminderMinutes=0)),
                                  (2, dict(id='task', title='Fixture'))]:
                desktop.apply_changes([dict(entityType='tasks', entityId='task', version=version,
                                            deleted=False, data=data)], version)
            self.assertNotIn('reminderMinutes', desktop.snapshot()['tasks'][0])
            self.assertNotIn('reminderMinutes', project(desktop.snapshot())[('tasks', 'task')])

    def test_invalid_overrides_are_rejected_without_changing_the_snapshot_or_cursor(self):
        for value in (-1, 10081, 1.5, True, False, '15', [], {}, float('inf')):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, '任务提醒'):
                    record('tasks', dict(id='task', reminderMinutes=value))
        with tempfile.TemporaryDirectory(prefix='aibro-reminder-sync-') as directory:
            desktop = SyncStore(directory)
            baseline = desktop.snapshot()
            with self.assertRaises(ValueError):
                desktop.apply_changes([dict(entityType='tasks', entityId='task', version=1,
                                            deleted=False, data=dict(id='task', reminderMinutes=-1))], 1)
            self.assertEqual(desktop.snapshot(), baseline)
            self.assertEqual(desktop.status()['cursor'], 0)


if __name__ == '__main__':
    unittest.main()
