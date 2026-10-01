"""Manage the user's existing cloud SSH tunnel without exposing SSH credentials."""
import json
import contextlib
import fcntl
import glob
import hashlib
import secrets
import stat
import uuid
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import shlex
import subprocess
import threading
import time
import urllib.parse
from cloud_sync import CloudSyncError

LABEL = 'app.ai-workstation.cloud-tunnel'
JOURNAL_LIMIT = 256 * 1024
PENDING = ('running', 'uncertain')


def config(value):
    if not isinstance(value, dict) or not isinstance(value.get('target', ''), str):
        raise CloudSyncError('SSH 配置格式无效。')
    target = value.get('target', '').strip()
    if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.@-]{0,250}', target) or target.count('@') > 1:
        raise CloudSyncError('请填写 SSH 主机别名或 用户名@主机；不填写命令或密码。')
    result = {'target': target}
    for key, fallback in [('sshPort', 0), ('localPort', 18787), ('remotePort', 8787)]:
        raw = value.get(key, fallback)
        if type(raw) is not int and (not isinstance(raw, str) or not re.fullmatch(r'[0-9]{1,5}', raw)):
            raise CloudSyncError('端口必须为整数。')
        port = int(raw)
        if not (0 if key == 'sshPort' else 1) <= port <= 65535:
            raise CloudSyncError('端口范围无效。')
        result[key] = port
    return result


def ssh_args(value):
    c = config(value)
    args = ['/usr/bin/ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
            '-o', 'ControlPath=none']
    if c['sshPort']: args += ['-p', str(c['sshPort'])]
    return args


def read_tunnel(path):
    if path.is_symlink(): raise CloudSyncError('SSH 启动项路径不安全。')
    if not path.exists(): return None
    metadata = path.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o022 or metadata.st_size > 1024 * 1024:
        raise CloudSyncError('SSH 启动项路径不安全。')
    try:
        value = plistlib.loads(path.read_bytes()); args = value['ProgramArguments']
        if value.get('Label') != LABEL or args[0] != '/usr/bin/ssh' or '-L' not in args: return None
        forward = args[args.index('-L') + 1]
        match = re.fullmatch(r'127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)', forward)
        if not match: return None
        return config({'target': args[-1], 'sshPort': args[args.index('-p') + 1] if '-p' in args else 0,
                       'localPort': match[1], 'remotePort': match[2]})
    except (KeyError, ValueError, IndexError, TypeError):
        raise CloudSyncError('无法识别已有 SSH 启动项，未覆盖。') from None


def discover_hosts(home):
    """Read literal Host aliases and Includes; never evaluate Match/exec/commands."""
    home = Path(home); seen, aliases = set(), set(); budget = [2 * 1024 * 1024]
    def visit(path, depth=0):
        if depth > 8 or len(seen) >= 128: return
        path = Path(path).expanduser()
        try:
            resolved = path.resolve()
            if resolved in seen: return
            seen.add(resolved)
            descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            try:
                metadata = os.fstat(descriptor)
                if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid not in (0, os.getuid()) or metadata.st_mode & 0o022 or metadata.st_size > min(1024 * 1024, budget[0]): return
                with os.fdopen(descriptor, 'r', encoding='utf-8', errors='replace', closefd=False) as stream: raw = stream.read(1024 * 1024 + 1)
                budget[0] -= len(raw.encode())
            finally: os.close(descriptor)
            for line in raw.splitlines():
                try: parts = shlex.split(line, comments=True)
                except ValueError: continue
                if not parts: continue
                # OpenSSH accepts both Keyword value and Keyword=value.
                if '=' in parts[0]:
                    keyword, value = parts[0].split('=', 1); parts = [keyword, value, *parts[1:]]
                key = parts[0].lower()
                if key == 'host':
                    for alias in parts[1:]:
                        if re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,250}', alias): aliases.add(alias)
                elif key == 'include':
                    for pattern in parts[1:]:
                        # Tokens, variables, commands and dynamic Match conditions
                        # are deliberately not expanded during discovery.
                        if any(char in pattern for char in ('%', '$', '`', '\n')): continue
                        candidate = Path(pattern).expanduser()
                        if not candidate.is_absolute(): candidate = home / '.ssh' / candidate
                        for included in sorted(glob.glob(str(candidate)))[:128]: visit(included, depth + 1)
        except (OSError, ValueError): return
    visit(home / '.ssh/config')
    return [{'target': alias, 'label': alias} for alias in sorted(aliases, key=str.casefold)[:200]]


def public_remote(value):
    """Allowlist remote metadata: authorization internals never enter UI state."""
    result = {key: value[key] for key in ('dataPath', 'databasePath', 'service', 'remotePort', 'active', 'protocol') if key in value}
    result['accounts'] = [{'id': item['id'], 'username': item['username']} for item in value.get('accounts', []) if isinstance(item, dict) and isinstance(item.get('id'), str) and isinstance(item.get('username'), str)]
    return result


class CloudSSH:
    def __init__(self, service, *, home=None, runner=subprocess.run):
        self.service = service; self.home = Path(home or Path.home()); self.runner = runner
        self.path = self.home / 'Library/LaunchAgents' / (LABEL + '.plist')
        self.lock = threading.Lock(); self.job = None; self.remote_info = None
        directory = getattr(service, 'directory', None)
        self.journal_directory = Path(directory if directory is not None else self.home) / '.cloud-ssh-maintenance'
        self.journal_path = self.journal_directory / 'job.json'
        self.operation_path = self.journal_directory / 'operation.lock'
        self._record = None; self._history = []; self._journal_error = None; self._active_job = None; self._persistence_failed = False
        self._read_journal()

    @staticmethod
    def _public_job(record):
        if not record: return None
        job = {key: record[key] for key in ('id', 'state', 'source', 'destination', 'phase', 'message', 'recovered', 'autoSyncPaused') if key in record}
        job['config'] = dict(record['config'])
        return job

    def _private_directory(self, *, create=False):
        path = self.journal_directory
        if path.is_symlink(): raise ValueError('journal directory is a symbolic link')
        if not path.exists():
            if not create: return False
            path.parent.mkdir(parents=True, exist_ok=True)
            path.mkdir(mode=0o700, exist_ok=True)
        metadata = path.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
            raise ValueError('journal directory is not private')
        return True

    @staticmethod
    def _private_file(fd):
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077 or metadata.st_nlink != 1 or metadata.st_size > JOURNAL_LIMIT:
            raise ValueError('journal file is not private')

    @staticmethod
    def _move_paths(source, destination):
        paths = []
        for value in (source, destination):
            if not isinstance(value, str) or len(value) > 2048 or not value.startswith('/') or any(ord(char) < 32 for char in value):
                raise ValueError('invalid path')
            path = PurePosixPath(value)
            if str(path) != value or '..' in path.parts: raise ValueError('noncanonical path')
            paths.append(path)
        source, destination = paths
        if source == destination or source in destination.parents or destination in source.parents:
            raise ValueError('overlapping paths')

    @staticmethod
    def _validate_record(record):
        if not isinstance(record, dict) or not isinstance(record.get('id'), str) or not re.fullmatch(r'[a-f0-9]{32}', record['id']): raise ValueError('invalid job')
        if record.get('state') not in (*PENDING, 'completed', 'error'): raise ValueError('invalid job state')
        CloudSSH._move_paths(record.get('source'), record.get('destination'))
        for key in ('phase', 'message'):
            if not isinstance(record.get(key), str) or len(record[key]) > 4096: raise ValueError('invalid job text')
        phases = {'prepared', 'accepted', 'stopping', 'copying', 'copy_verified', 'switching', 'verified',
                  'rolling_back', 'rolled_back', 'rejected', 'missing', 'not-dispatched'}
        if record['phase'] not in phases: raise ValueError('invalid job phase')
        if record['state'] == 'completed' and record['phase'] != 'verified': raise ValueError('contradictory completion')
        if record['state'] == 'error' and record['phase'] not in ('rejected', 'rolled_back', 'not-dispatched'):
            raise ValueError('contradictory failure')
        if config(record.get('config')) != record['config']: raise ValueError('invalid config')
        identity = record.get('identity')
        if not isinstance(identity, dict) or not isinstance(identity.get('accountId'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', identity['accountId']): raise ValueError('invalid identity')
        if type(identity.get('cursor')) is not int or identity['cursor'] < 0: raise ValueError('invalid cursor')
        if identity.get('serverUrl') not in (f'http://127.0.0.1:{record["config"]["localPort"]}', f'http://localhost:{record["config"]["localPort"]}'):
            raise ValueError('invalid binding')
        if type(record.get('restoreAuto')) is not bool: raise ValueError('invalid preference')
        if any(key in record and type(record[key]) is not bool for key in ('recovered', 'autoSyncPaused')):
            raise ValueError('invalid status flag')
        return record

    def _read_journal(self):
        """Read only. A restarted process never dispatches SSH or rewrites state."""
        if self._persistence_failed: return
        try:
            if not self._private_directory():
                if self._record: raise ValueError('existing journal disappeared')
                return
            try: fd = os.open(self.journal_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            except FileNotFoundError:
                if self._record: raise ValueError('existing journal disappeared')
                return
            try:
                self._private_file(fd)
                with os.fdopen(fd, 'rb', closefd=False) as stream: raw = stream.read(JOURNAL_LIMIT + 1)
            finally: os.close(fd)
            value = json.loads(raw)
            if not isinstance(value, dict) or value.get('version') != 1 or not isinstance(value.get('history'), list) or len(value['history']) > 32:
                raise ValueError('invalid journal')
            record = self._validate_record(value.get('job'))
            identifiers = {record['id']}
            for previous in value['history']:
                self._validate_record(previous)
                if previous['state'] in PENDING or previous['id'] in identifiers: raise ValueError('invalid historical job')
                identifiers.add(previous['id'])
            self._record = record; self._history = value['history']
            visible = dict(record)
            if record['state'] == 'running' and self._active_job != record['id']:
                visible.update(state='uncertain', recovered=True, autoSyncPaused=True,
                               message='发现上次尚未确认的目录迁移。自动同步已暂停，请检查迁移结果；不会自动重新执行迁移。')
            self.job = self._public_job(visible)
        except (OSError, ValueError, TypeError, KeyError, RecursionError, CloudSyncError):
            self._journal_error = '迁移记录无法安全读取，已暂停同步和连接修改。请保留本机迁移记录并检查文件权限或恢复备份；不会覆盖原记录。'
            self.job = {'state': 'uncertain', 'phase': 'journal-invalid', 'message': self._journal_error, 'autoSyncPaused': True}

    def _persist(self, record, *, new=False):
        """Caller owns the process lock. Publish only after durable replacement."""
        if self._journal_error: raise CloudSyncError(self._journal_error, 'SSH_JOURNAL_INVALID', 409)
        self._validate_record(record)
        history = list(self._history)
        if new and self._record and self._record['id'] != record['id']:
            history = (history + [self._record])[-32:]
        raw = json.dumps({'version': 1, 'job': record, 'history': history}, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
        if len(raw) > JOURNAL_LIMIT: raise ValueError('journal size limit')
        self._private_directory(create=True)
        # Never replace a path that became unsafe after the previous read.
        if self.journal_path.exists() or self.journal_path.is_symlink():
            fd = os.open(self.journal_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try: self._private_file(fd)
            finally: os.close(fd)
        temporary = self.journal_directory / ('.job-' + uuid.uuid4().hex)
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(raw); stream.flush(); os.fsync(stream.fileno())
            os.replace(temporary, self.journal_path)
            fd = os.open(self.journal_directory, os.O_RDONLY)
            try: os.fsync(fd)
            finally: os.close(fd)
        finally: temporary.unlink(missing_ok=True)
        self._record = dict(record); self._history = history; self.job = self._public_job(record)

    def assert_not_pending(self):
        self._read_journal()
        if self._journal_error: raise CloudSyncError(self._journal_error, 'SSH_JOURNAL_INVALID', 409)
        if self._persistence_failed or self._record and self._record['state'] in PENDING:
            raise CloudSyncError('服务器目录迁移尚未确认，已暂停同步和连接修改。请先检查迁移结果。', 'SSH_MOVE_PENDING', 409)

    def _acquire_operation(self, *, pending=False):
        fd = None
        try:
            self._private_directory(create=True)
            fd = os.open(self.operation_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
            self._private_file(fd)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self._read_journal()
            if self._journal_error: raise CloudSyncError(self._journal_error, 'SSH_JOURNAL_INVALID', 409)
            if not pending: self.assert_not_pending()
            return fd
        except BlockingIOError:
            if fd is not None: os.close(fd)
            raise CloudSyncError('此工作区的 SSH 或同步操作正在进行，请稍后再试。', 'SSH_BUSY', 409) from None
        except Exception as error:
            if fd is not None: os.close(fd)
            if isinstance(error, CloudSyncError): raise
            raise CloudSyncError('无法安全锁定本机迁移记录，未执行远程操作。', 'SSH_JOURNAL_INVALID', 409) from None

    @contextlib.contextmanager
    def operation_guard(self):
        fd = self._acquire_operation()
        try: yield
        finally: os.close(fd)

    def status(self):
        self._read_journal()
        current = read_tunnel(self.path)
        return {'config': current, 'remote': self.remote_info, 'job': self.job,
                'configPath': str(self.path), 'available': bool(current), 'hosts': discover_hosts(self.home)}

    def _bound(self, c):
        status = self.service.status(); target = status.get('target') or {}
        parsed = urllib.parse.urlsplit(target.get('serverUrl') or '')
        if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost') or parsed.port != c['localPort']:
            raise CloudSyncError('SSH 本机端口必须对应此工作区已绑定的同步地址，未改动现有连接。')
        if not target.get('accountId'): raise CloudSyncError('请先连接同步账号。')
        return {'accountId': target['accountId'], 'cursor': status.get('cursor', 0)}

    def _remote(self, c, payload, timeout=40):
        program = Path(__file__).with_name('cloud_ssh_remote.py').read_text()
        args = ssh_args(c) + ['-o', 'ClearAllForwardings=yes', c['target'], 'python3 -c ' + shlex.quote(program)]
        try:
            r = self.runner(args, input=json.dumps(payload), capture_output=True, text=True, timeout=timeout)
            if r.returncode: raise CloudSyncError('SSH 未连接。请检查主机、端口、密钥登录及已确认的主机指纹。')
            value = json.loads(r.stdout)
        except CloudSyncError: raise
        except (subprocess.TimeoutExpired, OSError, ValueError):
            raise CloudSyncError('SSH 操作未得到明确结果，请重新读取服务器状态后再操作。') from None
        if not isinstance(value, dict) or value.get('ok') is not True:
            raise CloudSyncError(value.get('error', 'SSH 云服务检查失败。') if isinstance(value, dict) else 'SSH 返回格式无效。')
        if value.get('remotePort') != c['remotePort'] and not (payload.get('action') in ('move', 'move-status') and value.get('remotePort') is None and isinstance(value.get('job'), dict)):
            raise CloudSyncError('SSH 转发端口与服务器实际监听端口不同，请修正远程端口。')
        return value

    def _connection_identity(self, c):
        status = self.service.status(); target = status.get('target')
        if target:
            return self._bound(c), target['serverUrl']
        return {'cursor': 0}, f'http://127.0.0.1:{c["localPort"]}'

    def probe(self, payload):
        with self.operation_guard():
            c = config(payload.get('config') or read_tunnel(self.path) or {})
            identity, _ = self._connection_identity(c)
            remote = self._remote(c, {**identity, 'action': 'probe'})
            if remote.get('protocol') != 1 or not isinstance(remote.get('accounts'), list):
                raise CloudSyncError('服务器未返回兼容的云端工作区信息。', 'SSH_PROTOCOL')
            return {'config': c, 'remote': public_remote(remote)}

    def _tunnel_snapshot(self):
        for parent in (self.path.parent, *self.path.parent.parents):
            if parent.is_symlink(): raise CloudSyncError('SSH 启动项目录不能经过符号链接。')
        if self.path.is_symlink(): raise CloudSyncError('SSH 启动项路径不安全。')
        if self.path.exists():
            if not read_tunnel(self.path): raise CloudSyncError('现有启动项不属于可识别的 AI Bro 隧道，未覆盖。')
            original = self.path.read_bytes()
        else: original = None
        parent = self.path.parent
        if parent.exists() and (not parent.is_dir() or parent.stat().st_uid != os.getuid() or parent.stat().st_mode & 0o022):
            raise CloudSyncError('SSH 启动项目录权限不安全。')
        loaded = self._tunnel_loaded()
        if original is None and loaded: raise CloudSyncError('已有同名 SSH 任务但配置不可识别，未替换。')
        return original, loaded

    def _tunnel_loaded(self):
        result = self.runner(['/bin/launchctl', 'print', f'gui/{os.getuid()}/{LABEL}'], capture_output=True, text=True, timeout=10)
        if result.returncode == 0: return True
        # launchctl uses 113 when this service is absent. Permission errors and
        # timeouts do not establish absence and must never permit unlinking it.
        if result.returncode == 113: return False
        raise CloudSyncError('无法确认 SSH 启动项状态，现有配置已保留。', 'SSH_JOB_STATUS', 503)

    def _stop_tunnel(self, *, rollback=False):
        try:
            try: self._launch('bootout')
            except (subprocess.TimeoutExpired, OSError): pass
            if not self._tunnel_loaded(): return
        except (CloudSyncError, subprocess.TimeoutExpired, OSError): pass
        raise CloudSyncError('无法确认 SSH 隧道已停止，当前启动项仍保留；请检查连接状态后重试。',
                             'SSH_ROLLBACK' if rollback else 'SSH_TUNNEL', 503)

    def _install_tunnel(self, c, original, loaded):
        if original is not None and loaded and read_tunnel(self.path) == c:
            return False
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        value = plistlib.loads(original) if original else {'Label': LABEL, 'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 10}
        value['ProgramArguments'] = ssh_args(c) + ['-N', '-o', 'ExitOnForwardFailure=yes', '-L',
            f'127.0.0.1:{c["localPort"]}:127.0.0.1:{c["remotePort"]}', c['target']]
        if original is not None:
            backup = self.path.with_name(self.path.name + f'.backup-{time.time_ns()}')
            descriptor = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(descriptor, 'wb') as stream: stream.write(original)
        from cloud_ssh_remote import atomic
        # Keep the running job's configuration available until it is confirmed
        # stopped. A failed bootout must not replace it with another host.
        if loaded: self._stop_tunnel()
        atomic(self.path, plistlib.dumps(value))
        if self._launch('bootstrap').returncode: raise CloudSyncError('SSH 隧道启动失败，请检查端口占用与系统密钥登录。', 'SSH_TUNNEL')
        if not self._tunnel_loaded(): raise CloudSyncError('SSH 启动项未保持运行，请检查连接配置。', 'SSH_TUNNEL')
        return True

    def _restore_tunnel(self, original, loaded):
        from cloud_ssh_remote import atomic
        # Do not remove/restore the plist while the replacement job might still
        # be running: that leaves an unmanageable job occupying the local port.
        self._stop_tunnel(rollback=True)
        if original is None: self.path.unlink(missing_ok=True)
        else: atomic(self.path, original)
        if loaded:
            try:
                if self._launch('bootstrap').returncode or not self._tunnel_loaded(): raise ValueError()
            except (CloudSyncError, subprocess.TimeoutExpired, OSError, ValueError):
                raise CloudSyncError('连接未完成，旧 SSH 配置已恢复，但旧隧道需要重新启动。', 'SSH_ROLLBACK', 503) from None

    def connect(self, payload):
        if payload.get('mergeConfirmed') is not True:
            raise CloudSyncError('请先确认连接该工作区并合并本机与云端内容。', 'MERGE_CONFIRMATION_REQUIRED')
        c = config(payload.get('config') or read_tunnel(self.path) or {})
        account_id, name = payload.get('accountId'), payload.get('deviceName')
        if not isinstance(account_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', account_id):
            raise CloudSyncError('请选择检查结果中的云端工作区。', 'INVALID_ACCOUNT')
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 100 or any(ord(char) < 32 for char in name):
            raise CloudSyncError('请输入有效的本机设备名称。', 'INVALID_DEVICE')
        if not self.lock.acquire(blocking=False): raise CloudSyncError('SSH 操作正在进行。', 'SSH_BUSY', 409)
        if not self.service._sync_lock.acquire(blocking=False):
            self.lock.release(); raise CloudSyncError('正在同步，请稍后再更改连接。', 'SYNC_BUSY', 409)
        authorized = False; attempt = None; tunnel_changed = False; snapshot = None; committed = False
        operation = None
        try:
            operation = self._acquire_operation()
            with self.service._lock: epoch = self.service._epoch
            identity, url = self._connection_identity(c)
            if identity.get('accountId') and identity['accountId'] != account_id:
                raise CloudSyncError('此工作区只能恢复原云端账号，未更换同步目标。', 'TARGET_MISMATCH', 409)
            remote = self._remote(c, {**identity, 'action': 'probe'})
            accounts = public_remote(remote)['accounts']
            if remote.get('protocol') != 1 or not any(item['id'] == account_id for item in accounts):
                raise CloudSyncError('所选工作区不在当前服务器，请重新检查连接。', 'TARGET_MISMATCH', 409)
            self.service._check_epoch(epoch)
            snapshot = self._tunnel_snapshot()
            # Generate the token locally. Only its hash crosses SSH; the helper
            # response and all status objects contain no credential material.
            token = secrets.token_urlsafe(32)
            attempt = {**identity, 'accountId': account_id, 'expectedPath': remote['dataPath'], 'deviceId': uuid.uuid4().hex,
                       'deviceName': name.strip(), 'tokenHash': hashlib.sha256(token.encode()).hexdigest()}
            authorized = True  # Even a timeout may have committed remotely.
            issued = self._remote(c, {**attempt, 'action': 'authorize-device'})
            account = self.service._identity(issued.get('account'), ('username',))
            device = self.service._identity(issued.get('device'), ('name',))
            if account['id'] != account_id or device['id'] != attempt['deviceId']:
                raise CloudSyncError('服务器设备授权结果不匹配。', 'INVALID_SESSION')
            self.service._check_epoch(epoch)
            original, loaded = snapshot
            tunnel_changed = not (original is not None and loaded and read_tunnel(self.path) == c)
            self._install_tunnel(c, original, loaded)
            client = self.service._client_factory(url, token)
            client.timeout = 2  # Bound tunnel startup checks; do not wait 25s per attempt.
            for attempt_index in range(6):
                self.service._check_epoch(epoch)
                try:
                    client.health()
                    result = client.request('GET', '/v1/devices')
                    rows = result.get('devices')
                    if not isinstance(rows, list) or not any(isinstance(item, dict) and item.get('id') == device['id'] and item.get('current') is True and item.get('revokedAt') is None for item in rows):
                        raise CloudSyncError('SSH 隧道未连接到刚授权的设备，请检查本机端口占用。', 'SSH_IDENTITY_MISMATCH')
                    break
                except CloudSyncError as error:
                    if error.code != 'NETWORK_ERROR' or attempt_index == 5: raise
                    time.sleep(0.25)
            session = {'serverUrl': url, 'account': account, 'device': device, 'accessToken': token, 'autoSync': payload.get('autoSync', True) is not False}
            self.service._adopt_ssh_session(session, epoch)
            committed = True
            self.remote_info = public_remote(remote)
            return {'status': self.service.status(), 'config': c, 'remote': self.remote_info}
        except Exception as error:
            if committed:
                raise CloudSyncError('SSH 会话已保存，但状态读取暂时失败；请刷新连接状态。', 'STATUS_REFRESH_REQUIRED', 503) from None
            cleanup_failed = False
            if authorized and attempt:
                try: self._remote(c, {**attempt, 'action': 'revoke-device'})
                except Exception: cleanup_failed = True
            rollback_error = None
            if tunnel_changed and snapshot:
                try: self._restore_tunnel(*snapshot)
                except Exception as failure: rollback_error = failure
            if rollback_error: raise rollback_error from None
            if cleanup_failed:
                raise CloudSyncError('连接未完成，本机未采用新会话；远端设备清理未确认，请重新检查服务器后在设备列表撤销本次设备。', 'SSH_CLEANUP_REQUIRED', 503) from None
            if isinstance(error, CloudSyncError): raise
            raise CloudSyncError('SSH 连接未完成，原连接和本机资料已保留。', 'SSH_CONNECT_FAILED', 503) from None
        finally:
            if operation is not None: os.close(operation)
            self.service._sync_lock.release(); self.lock.release()
            if committed and self.service._auto: self.service._wake.set()

    def inspect(self, payload):
        with self.operation_guard():
            c = config(payload.get('config') or read_tunnel(self.path) or {})
            result = self._remote(c, {**self._bound(c), 'action': 'inspect'})
            if c == read_tunnel(self.path): self.remote_info = result
            return {'config': c, 'remote': result}

    def _launch(self, action):
        return self.runner(['/bin/launchctl', action, f'gui/{os.getuid()}', str(self.path)],
                           capture_output=True, text=True, timeout=20)

    def save(self, payload):
        c = config(payload.get('config') or {})
        if not self.lock.acquire(blocking=False): raise CloudSyncError('SSH 操作正在进行。')
        if not self.service._sync_lock.acquire(blocking=False):
            self.lock.release(); raise CloudSyncError('正在同步，请稍后再修改 SSH 连接。')
        operation = None
        try:
            operation = self._acquire_operation()
            remote = self._remote(c, {**self._bound(c), 'action': 'inspect'})
            if not self.path.exists(): raise CloudSyncError('未找到已有 SSH 启动项，请先配置初次部署。')
            original, loaded = self._tunnel_snapshot()
            changed = not (loaded and read_tunnel(self.path) == c)
            try:
                self._install_tunnel(c, original, loaded)
                # Do not declare success just because launchd accepted a job.
                from cloud_sync import CloudClient
                for attempt in range(12):
                    try:
                        CloudClient(f'http://127.0.0.1:{c["localPort"]}', timeout=2).health(); break
                    except CloudSyncError:
                        if attempt == 11: raise
                        time.sleep(0.5)
            except Exception:
                if changed: self._restore_tunnel(original, loaded)
                raise CloudSyncError('新连接未通过检查，已还原旧配置。') from None
            self.remote_info = remote
            return self.status()
        finally:
            if operation is not None: os.close(operation)
            self.service._sync_lock.release(); self.lock.release()

    def _pause_auto(self):
        # Called with _sync_lock and the workspace file lock already held.
        if hasattr(self.service, '_set_auto'):
            self.service._set_auto(False)
        else:
            self.service.settings({'autoSync': False})

    def _validate_receipt(self, result, record):
        job = result.get('job')
        if not isinstance(job, dict) or any(job.get(key) != record[key] for key in ('id', 'source', 'destination')):
            raise CloudSyncError('服务器返回了其他迁移任务的记录，当前结果仍未确认。', 'SSH_RECEIPT_MISMATCH', 409)
        if job.get('state') not in (*PENDING, 'completed', 'error'):
            raise CloudSyncError('服务器迁移状态无法识别，当前结果仍未确认。', 'SSH_RECEIPT_INVALID', 503)
        if any(not isinstance(job.get(key), str) or len(job[key]) > 4096 for key in ('phase', 'message')):
            raise CloudSyncError('服务器迁移记录不完整，当前结果仍未确认。', 'SSH_RECEIPT_INVALID', 503)
        if job['state'] in ('completed', 'error'):
            expected = record['destination'] if job['state'] == 'completed' else record['source']
            safe_phase = job['phase'] == 'verified' if job['state'] == 'completed' else job['phase'] in ('rejected', 'rolled_back')
            if not safe_phase or result.get('dataPath') != expected or result.get('active') is not True or result.get('remotePort') != record['config']['remotePort']:
                raise CloudSyncError('服务器尚未确认迁移结果对应的目录服务正在正常运行，当前结果仍未确认。', 'SSH_RECEIPT_INVALID', 503)
        return {**record, **{key: job[key] for key in ('state', 'phase', 'message')}, 'autoSyncPaused': True}

    def _uncertain(self, record, message):
        uncertain = {**record, 'state': 'uncertain', 'autoSyncPaused': True, 'message': message}
        try: self._persist(uncertain)
        except Exception:
            self._persistence_failed = True
            self._record = uncertain
            self.job = self._public_job({**uncertain, 'message': '迁移结果和本机记录尚未确认，自动同步已暂停。请保留记录并重新检查迁移结果。'})

    def _consume_receipt(self, result, record, *, recovered=False):
        next_record = self._validate_receipt(result, record)
        # Recovery deliberately does not resume transfers. Even a completed
        # receipt can be read days later; resuming is an explicit user choice.
        next_record['recovered'] = recovered
        if next_record['state'] in ('completed', 'error'):
            next_record['message'] += ' 自动同步保持暂停，可检查后手动恢复。'
        self._persist(next_record)
        if next_record['state'] in ('completed', 'error') and hasattr(self.service, '_clear_maintenance_error'):
            self.service._clear_maintenance_error()
        if result.get('dataPath'):
            self.remote_info = public_remote(result)

    def move(self, payload):
        if payload.get('confirmed') is not True: raise CloudSyncError('请先确认复制校验后切换目录。')
        c = read_tunnel(self.path)
        if not c: raise CloudSyncError('未找到 SSH 隧道。')
        if not self.lock.acquire(blocking=False): raise CloudSyncError('SSH 操作正在进行。', 'SSH_BUSY', 409)
        if not self.service._sync_lock.acquire(blocking=False):
            self.lock.release(); raise CloudSyncError('正在同步，请稍后再迁移。', 'SYNC_BUSY', 409)
        operation = None; record = None; journaled = False
        try:
            operation = self._acquire_operation()
            epoch = getattr(self.service, '_epoch', None)
            if epoch is not None: self.service._check_epoch(epoch)
            identity = self._bound(c)
            raw = payload.get('dataPath')
            if not isinstance(raw, str) or len(raw) > 2048 or not raw.startswith('/') or '\x00' in raw:
                raise CloudSyncError('请输入服务器上的绝对目录路径。')
            expected = payload.get('expectedPath')
            if not self.remote_info or expected != self.remote_info.get('dataPath') or expected == raw:
                raise CloudSyncError('请先读取当前服务器目录，并选择不同的新目录。')
            try: self._move_paths(expected, raw)
            except ValueError:
                raise CloudSyncError('请使用规范的服务器绝对目录路径，不含末尾斜杠、.. 或控制字符；新旧目录不能互相包含。', 'INVALID_PATH') from None
            snapshot = self.service.status()
            record = {'id': uuid.uuid4().hex, 'state': 'running', 'source': expected, 'destination': raw,
                      'config': c, 'identity': {**identity, 'cursor': identity.get('cursor', 0), 'serverUrl': snapshot['target']['serverUrl']},
                      'restoreAuto': snapshot.get('autoSync') is True, 'autoSyncPaused': True, 'phase': 'prepared',
                      'message': '正在停止服务、复制校验并切换目录；旧目录将保留。'}
            # The intent must reach disk before pausing the account or sending
            # SSH. A crash in either following step is therefore recoverable.
            self._persist(record, new=True); journaled = True
            self._pause_auto()
            if epoch is not None: self.service._check_epoch(epoch)
            self._active_job = record['id']

            def work():
                try:
                    result = self._remote(c, {**identity, 'jobId': record['id'], 'action': 'move', 'expectedPath': expected, 'dataPath': raw}, timeout=600)
                    self._consume_receipt(result, record)
                except Exception:
                    self._uncertain(record, '迁移未收到可核对的最终结果，自动同步已暂停。请检查迁移结果；不会重新执行迁移。')
                finally:
                    self._active_job = None
                    os.close(operation)
                    self.service._sync_lock.release(); self.lock.release()

            threading.Thread(target=work, daemon=True, name='cloud-storage-move').start()
        except Exception:
            if journaled:
                try:
                    self._persist({**record, 'state': 'error', 'phase': 'not-dispatched', 'message': '本机未能启动迁移，未向服务器发送迁移请求。请检查本机状态后重试。'})
                except Exception:
                    self._uncertain(record, '本机未启动远程迁移，但记录未能保存；请检查本机迁移记录。')
            self._active_job = None
            if operation is not None: os.close(operation)
            self.service._sync_lock.release(); self.lock.release()
            raise
        return self.status()

    def reconcile(self, payload):
        """Explicit, readonly SSH receipt lookup; never replays a move."""
        if not self.lock.acquire(blocking=False): raise CloudSyncError('SSH 操作正在进行。', 'SSH_BUSY', 409)
        if not self.service._sync_lock.acquire(blocking=False):
            self.lock.release(); raise CloudSyncError('正在同步，请稍后再检查迁移。', 'SYNC_BUSY', 409)
        operation = None; record = None
        try:
            operation = self._acquire_operation(pending=True)
            record = self._record
            if not record or payload.get('jobId') != record['id']:
                raise CloudSyncError('本机迁移任务已变化，请刷新后重新检查。', 'SSH_JOB_MISMATCH', 409)
            current = self._bound(record['config'])
            target = self.service.status().get('target') or {}
            identity = record['identity']
            if current['accountId'] != identity['accountId'] or target.get('serverUrl') != identity['serverUrl']:
                raise CloudSyncError('当前工作区绑定与迁移记录不同，未连接其他服务器。', 'TARGET_MISMATCH', 409)
            self._pause_auto()
            result = self._remote(record['config'], {**{key: identity[key] for key in ('accountId', 'cursor')},
                'action': 'move-status', 'jobId': record['id'], 'expectedPath': record['source'], 'dataPath': record['destination']}, timeout=40)
            self._consume_receipt(result, record, recovered=True)
            self._persistence_failed = False
            response = self.status(); response['cloudStatus'] = self.service.status()
            return response
        except Exception as error:
            # Identity/preflight rejections do not rewrite the saved operation.
            if record and not (isinstance(error, CloudSyncError) and error.code in ('TARGET_MISMATCH', 'SSH_JOB_MISMATCH')):
                self._uncertain(record, '暂时无法确认服务器上的迁移结果，自动同步保持暂停。请稍后再次检查；不会重新执行迁移。')
            raise
        finally:
            if operation is not None: os.close(operation)
            self.service._sync_lock.release(); self.lock.release()
