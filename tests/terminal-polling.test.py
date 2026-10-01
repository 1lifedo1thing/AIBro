"""Real isolated processes: silent progress causes no writes; cancellation kills descendants."""
import json, os, sys, tempfile, time
from pathlib import Path
from local_projects import LocalProjects
from local_commands import LocalCommands


def until(service, identifier, predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = service.access(identifier)
        if predicate(value):
            return value
        time.sleep(.02)
    raise AssertionError('authoritative command state did not reach expected condition')


with tempfile.TemporaryDirectory(prefix='aibro-terminal-polling-') as temp:
    base = Path(temp)
    folder = base / 'isolated-project'
    folder.mkdir()
    projects = LocalProjects(base / 'data')
    candidate = projects.connect(str(folder))['candidate']['id']
    service = LocalCommands(projects)
    saves = []
    original_save = service._save

    def observed_save(entry):
        saves.append((entry['id'], entry['status'], entry['output'], entry['truncated']))
        original_save(entry)

    service._save = observed_save
    try:
        # Actual output appears, then the process stays silent while still live.
        code = 'import time;print("READY",flush=True);time.sleep(1.4);print("PROGRESS",flush=True);time.sleep(.7);print("DONE",flush=True)'
        entry = service.propose({'candidateId': candidate, 'projectId': 'p', 'runId': 'r', 'argv': [sys.executable, '-c', code], 'timeout': 10})
        identifier = entry['id']
        service.access(identifier, 'start')
        control = service.running[identifier]
        repeated = service.access(identifier, 'start')
        assert repeated['status'] == 'running'
        assert service.running[identifier] is control, 'start must reuse the existing handle, never spawn a duplicate'
        until(service, identifier, lambda item: 'READY' in item['output'])
        before = len(saves)
        time.sleep(.65)
        current = service.access(identifier)
        assert current['status'] == 'running' and control['process'].poll() is None
        assert len(saves) == before, 'unchanged output must not cause periodic fsync writes'
        progress = until(service, identifier, lambda item: 'PROGRESS' in item['output'])
        assert progress['status'] == 'running'
        result = until(service, identifier, lambda item: item['status'] in service.TERMINAL)
        assert result['status'] == 'succeeded' and result['exitCode'] == 0
        assert result['output'] == 'READY\nPROGRESS\nDONE\n'
        assert identifier not in service.running
        assert service.access(identifier, 'start')['output'] == result['output']
        snapshots = [snapshot for snapshot in saves if snapshot[0] == identifier]
        assert all(left != right for left, right in zip(snapshots, snapshots[1:])), 'only state or output changes may persist'
        print('PASS: real silent process stays live with zero unchanged writes; progress persists; start is idempotent')

        # A child that would write later must be killed with the approved process group.
        marker = folder / 'must-not-appear.txt'
        child = 'import time;from pathlib import Path;time.sleep(1.2);Path(' + repr(str(marker)) + ').write_text("orphan")'
        parent = 'import subprocess,sys,time;subprocess.Popen([sys.executable,"-c",' + repr(child) + ']);print("CHILD_READY",flush=True);time.sleep(10)'
        entry = service.propose({'candidateId': candidate, 'argv': [sys.executable, '-c', parent], 'timeout': 10})
        identifier = entry['id']
        service.access(identifier, 'start')
        until(service, identifier, lambda item: 'CHILD_READY' in item['output'])
        started = time.monotonic()
        service.access(identifier, 'cancel')
        result = until(service, identifier, lambda item: item['status'] in service.TERMINAL)
        assert result['status'] == 'cancelled'
        assert time.monotonic() - started < 1, 'stop is independent of the renderer polling backoff'
        assert result['output'] == 'CHILD_READY\n' and identifier not in service.running
        time.sleep(1.3)
        assert not marker.exists(), 'a cancelled child must not outlive the command group'
        assert service.access(identifier, 'start')['status'] == 'cancelled'
        print('PASS: real cancellation retains partial output, removes handle, kills descendants, and never restarts')
    finally:
        service.close()

# A cleanup denial after observed exit is different from denial for a live process.
from unittest.mock import patch, Mock
with patch('local_commands.os.killpg', side_effect=PermissionError('denied')):
    assert LocalCommands._kill(Mock(pid=123, poll=lambda: 0)) is False
    try:
        LocalCommands._kill(Mock(pid=123, poll=lambda: None))
    except PermissionError:
        pass
    else:
        raise AssertionError('must not hide failure to stop a confirmed live process')
print('PASS: redundant post-exit group signal denial is distinguished from live cancellation failure')
