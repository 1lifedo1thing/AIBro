"""Fixed remote helper for the AI Bro systemd user service; JSON on stdin/stdout.

No credentials, SSH keys, arbitrary commands or account contents are returned.
Device authorization receives only a client-generated token hash over SSH.
Path changes copy and verify while the service is stopped, retaining the source.
"""
import contextlib
import fcntl
import hashlib
import json
import os
import re
import stat
import time
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import urllib.request

UNIT = 'ai-workstation-cloud.service'


def control(*args):
    return subprocess.run(['systemctl', '--user', *args], check=True, capture_output=True, text=True, timeout=45).stdout.strip()


def plain_path(raw):
    path = Path(raw)
    if not path.is_absolute() or '..' in path.parts or any(ord(c) < 32 for c in str(path)):
        raise ValueError('请使用不含 .. 的绝对目录路径。')
    for parent in (path, *path.parents):
        if parent.is_symlink():
            raise ValueError('数据路径不能经过符号链接。')
    return path


def account_check(root, account_id, cursor=0):
    if not account_id:
        raise ValueError('请先连接云同步账号，再检查 SSH 部署。')
    dbpath = plain_path(str(root / 'cloud.sqlite3'))
    with contextlib.closing(sqlite3.connect(dbpath.as_uri() + '?mode=ro', uri=True)) as db:
        row = db.execute('SELECT change_seq FROM accounts WHERE id=?', (account_id,)).fetchone()
        if not row or row[0] < int(cursor):
            raise ValueError('SSH 目标不是当前账号的数据，或比本机同步进度更旧；未切换连接。')


def deployment(account_id=None, cursor=0):
    try:
        active = control('is-active', UNIT)
    except (subprocess.CalledProcessError, OSError):
        raise ValueError('未发现运行中的 AI Bro 云同步用户服务；请先部署或启动服务，再重新检查。') from None
    if active != 'active':
        raise ValueError('云同步用户服务未运行，请先部署或恢复服务。')
    pid = int(control('show', UNIT, '--property=MainPID', '--value'))
    process = Path(f'/proc/{pid}')
    if pid <= 1 or process.stat().st_uid != os.getuid():
        raise ValueError('云服务进程不属于当前 SSH 用户。')
    argv = (process / 'cmdline').read_bytes().decode().rstrip('\0').split('\0')
    if len(argv) < 5 or Path(argv[1]).name != 'cloud_server.py' or 'serve' not in argv:
        raise ValueError('无法识别当前云服务启动配置，未执行修改。')
    def arg(name):
        if argv.count(name) != 1:
            raise ValueError('云服务缺少明确的启动参数。')
        return argv[argv.index(name) + 1]
    root = plain_path(arg('--data-dir'))
    if not root.is_dir() or root.stat().st_uid != os.getuid():
        raise ValueError('当前账号不拥有云数据目录。')
    if arg('--host') != '127.0.0.1':
        raise ValueError('SSH 管理仅用于监听 127.0.0.1 的个人云服务。')
    port = int(arg('--port'))
    if not 1 <= port <= 65535:
        raise ValueError('云服务端口无效。')
    if account_id: account_check(root, account_id, cursor)
    return {'dataPath': str(root), 'databasePath': str(root / 'cloud.sqlite3'),
            'service': UNIT, 'remotePort': port, 'active': True, 'argv': argv}



# Compatible with the shipped protocol-1 schema. Never initialize or migrate a
# database while authorizing a device on an existing deployment.
AUTH_SCHEMA = {
    'accounts': ('id', 'username', 'salt', 'password_hash', 'created_at', 'change_seq'),
    'devices': ('id', 'account_id', 'name', 'created_at', 'last_seen_at', 'revoked_at'),
    'tokens': ('token_hash', 'account_id', 'device_id', 'expires_at'),
}


def owned_database(root, writable=False):
    root = plain_path(str(root)); path = plain_path(str(root / 'cloud.sqlite3'))
    for item, directory in ((root, True), (path, False)):
        metadata = item.stat()
        valid_type = stat.S_ISDIR(metadata.st_mode) if directory else stat.S_ISREG(metadata.st_mode)
        if not valid_type or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
            raise ValueError('云数据须由当前 SSH 用户私有持有，请检查目录 700 和数据库 600 权限。')
    connection = sqlite3.connect(path.as_uri() + ('?mode=rw' if writable else '?mode=ro'), uri=True, timeout=10, isolation_level=None)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute('PRAGMA foreign_keys=ON')
        connection.execute('PRAGMA busy_timeout=10000')
        if writable: connection.execute('PRAGMA synchronous=FULL')
        if connection.execute('PRAGMA user_version').fetchone()[0] != 1:
            raise ValueError('此服务器数据库版本不支持 SSH 设备授权，请使用账号登录。')
        for table, columns in AUTH_SCHEMA.items():
            actual = tuple(row['name'] for row in connection.execute('PRAGMA table_info(' + table + ')'))
            kind = connection.execute('SELECT type FROM sqlite_master WHERE name=?', (table,)).fetchone()
            if actual != columns or not kind or kind['type'] != 'table':
                raise ValueError('此服务器数据库结构不兼容，未修改账号或设备。')
        return connection
    except Exception:
        connection.close(); raise


def selected_accounts(db, account_id=None, cursor=0):
    if type(cursor) is not int or cursor < 0:
        raise ValueError('本机同步进度无效。')
    if account_id is not None and (not isinstance(account_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', account_id)):
        raise ValueError('同步账号标识无效。')
    rows = db.execute('SELECT id,username,change_seq FROM accounts WHERE id=?', (account_id,)).fetchall() if account_id else db.execute('SELECT id,username,change_seq FROM accounts ORDER BY username,id LIMIT 101').fetchall()
    if len(rows) > 100: raise ValueError('服务器账号过多，请使用账号登录。')
    if account_id and (not rows or rows[0]['change_seq'] < cursor):
        raise ValueError('SSH 目标不是当前账号的数据，或比本机同步进度更旧；未切换连接。')
    return [{'id': row['id'], 'username': row['username']} for row in rows]


def probe(payload):
    info = deployment(payload.get('accountId'), payload.get('cursor', 0))
    with contextlib.closing(owned_database(Path(info['dataPath']))) as db:
        accounts = selected_accounts(db, payload.get('accountId'), payload.get('cursor', 0))
    info.pop('argv', None)
    return {**info, 'accounts': accounts, 'protocol': 1}


def device_action(payload, revoke=False):
    account_id = payload.get('accountId')
    if not account_id: raise ValueError('请选择要连接的云端工作区。')
    info = deployment(account_id, payload.get('cursor', 0))
    if payload.get('expectedPath') != info['dataPath']:
        raise ValueError('服务器数据目录已变化，请重新检查连接。')
    device_id, token_hash = payload.get('deviceId'), payload.get('tokenHash')
    if not isinstance(device_id, str) or not re.fullmatch(r'[a-f0-9]{32}', device_id) or not isinstance(token_hash, str) or not re.fullmatch(r'[a-f0-9]{64}', token_hash):
        raise ValueError('设备授权信息无效。')
    name = payload.get('deviceName', '')
    if not revoke and (not isinstance(name, str) or not 1 <= len(name.strip()) <= 100 or any(ord(char) < 32 for char in name)):
        raise ValueError('请输入有效的本机设备名称。')
    with contextlib.closing(owned_database(Path(info['dataPath']), writable=True)) as db:
        try:
            db.execute('BEGIN IMMEDIATE')
            accounts = selected_accounts(db, account_id, payload.get('cursor', 0))
            if revoke:
                # A failed attempt may clean up only its own exact device/token.
                row = db.execute('SELECT 1 FROM tokens WHERE token_hash=? AND account_id=? AND device_id=?', (token_hash, account_id, device_id)).fetchone()
                if row:
                    db.execute('DELETE FROM tokens WHERE token_hash=? AND account_id=? AND device_id=?', (token_hash, account_id, device_id))
                    db.execute('UPDATE devices SET revoked_at=? WHERE id=? AND account_id=?', (int(time.time()), device_id, account_id))
            else:
                now = int(time.time())
                db.execute('INSERT INTO devices(id,account_id,name,created_at,last_seen_at) VALUES(?,?,?,?,?)', (device_id, account_id, name.strip(), now, now))
                db.execute('INSERT INTO tokens(token_hash,account_id,device_id,expires_at) VALUES(?,?,?,?)', (token_hash, account_id, device_id, now + 30 * 24 * 60 * 60))
            current = deployment(account_id, payload.get('cursor', 0))
            if current['dataPath'] != info['dataPath'] or current['remotePort'] != info['remotePort']:
                raise ValueError('云服务在授权期间发生变化，请重新检查。')
            db.commit()
        except Exception:
            db.rollback(); raise
    info.pop('argv', None)
    return {**info, 'accounts': accounts, 'protocol': 1, 'account': accounts[0], 'device': {'id': device_id, 'name': name.strip()}, 'revoked': revoke}


@contextlib.contextmanager
def mutation_lock(create=True):
    path = plain_path(str(Path.home() / '.config/systemd/user/.aibro-storage.lock'))
    descriptor = os.open(path, (os.O_CREAT if create else 0) | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        metadata = os.fstat(descriptor)
        if metadata.st_uid != os.getuid() or not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077 or metadata.st_nlink != 1:
            raise ValueError('远端管理锁的权限无效。')
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally: os.close(descriptor)

def manifest(root):
    rows = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValueError('数据目录含符号链接或特殊文件，未迁移。')
        if path.is_file():
            with path.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else None
                if digest is None:
                    h = hashlib.sha256()
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''): h.update(chunk)
                    digest = h.hexdigest()
            rows[str(path.relative_to(root))] = (path.stat().st_size, digest)
    return rows


def systemd_arg(value):
    # systemd ExecStart syntax is not shell syntax. Escape its own expansions.
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$') + '"'


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)


def sync_tree(root):
    # A checksum read can be satisfied by dirty cache. Flush copied contents
    # and their directory entries before recording durable copy verification.
    for path in sorted(root.rglob('*'), reverse=True):
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            mode = os.fstat(descriptor).st_mode
            if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                raise ValueError('复制结果包含特殊文件，未切换目录。')
            os.fsync(descriptor)
        finally: os.close(descriptor)
    sync_directory(root)
    sync_directory(root.parent)


def atomic(path, content):
    fd, name = tempfile.mkstemp(prefix='.aibro-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content); stream.flush(); os.fsync(stream.fileno())
        os.chmod(name, 0o600)
        os.replace(name, path)
        sync_directory(path.parent)
    finally:
        if os.path.exists(name): os.unlink(name)


def destination(source, raw):
    target = plain_path(raw)
    if target == source or target in source.parents or source in target.parents:
        raise ValueError('新目录不能与旧目录相同，也不能互相包含。')
    if target.exists():
        raise ValueError('目标目录已存在，请选择一个尚不存在的新目录，避免覆盖数据。')
    if (not target.parent.is_dir() or target.parent.stat().st_uid != os.getuid()
            or target.parent.stat().st_mode & 0o022 or not os.access(target.parent, os.W_OK)):
        raise ValueError('目标上级目录须已存在，由当前 SSH 用户拥有、可写，且不可由其他用户修改。')
    return target


def health(info):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(f'http://127.0.0.1:{info["remotePort"]}/v1/health', timeout=10) as response:
        if json.load(response).get('protocol') != 1: raise ValueError('云服务健康检查失败。')


def relocate(payload, checkpoint=None):
    mark = checkpoint or (lambda phase, **fields: None)
    info = deployment(payload['accountId'], payload.get('cursor', 0))
    source = Path(info['dataPath'])
    if info['dataPath'] != payload.get('expectedPath'):
        raise ValueError('服务器路径已发生变化，请重新读取后再修改。')
    target = destination(source, payload.get('dataPath', ''))
    override_dir = plain_path(str(Path.home() / '.config/systemd/user' / (UNIT + '.d')))
    override_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    sync_directory(override_dir.parent)
    override = plain_path(str(override_dir / '90-aibro-storage.conf'))
    old = override.read_bytes() if override.exists() else None
    argv = list(info['argv']); argv[argv.index('--data-dir') + 1] = str(target)
    # Later overrides could silently cancel our setting. Verify the resulting
    # process and path before reporting success; roll back if that happens.
    content = ('[Service]\nExecStart=\nExecStart=' + ' '.join(map(systemd_arg, argv)) + '\n').encode()
    stopped = False
    try:
        mark('stopping')
        # A failed/terminated systemctl reply does not prove that stop failed.
        stopped = True; control('stop', UNIT)
        if control('show', UNIT, '--property=MainPID', '--value') != '0':
            raise ValueError('服务未完全停止，未复制数据。')
        before = manifest(source)
        mark('copying')
        shutil.copytree(source, target, symlinks=True)
        os.chmod(target, 0o700)
        if before != manifest(target) or before != manifest(source):
            raise ValueError('复制校验失败或源目录仍在变化，未切换。')
        account_check(target, payload['accountId'], payload.get('cursor', 0))
        with contextlib.closing(sqlite3.connect((target / 'cloud.sqlite3').as_uri() + '?mode=ro', uri=True)) as db:
            if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise ValueError('目标数据库校验失败。')
        sync_tree(target)
        mark('copy_verified', verifiedFiles=len(before),
             manifestDigest=hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest())
        atomic(override, content)
        mark('switching')
        control('daemon-reload'); control('start', UNIT)
        current = deployment(payload['accountId'], payload.get('cursor', 0))
        if current['dataPath'] != str(target):
            raise ValueError('服务没有采用新目录。')
        health(current)
        mark('verified')
        current.pop('argv', None)
        return {**current, 'previousPath': str(source), 'verifiedFiles': len(before)}
    except Exception as error:
        if stopped:
            try:
                # A broken receipt volume must not suppress rollback itself.
                try: mark('rolling_back')
                except Exception: pass
                control('stop', UNIT)
                if old is None:
                    override.unlink(missing_ok=True)
                    sync_directory(override.parent)
                else: atomic(override, old)
                control('daemon-reload'); control('start', UNIT)
                restored = deployment(payload['accountId'], payload.get('cursor', 0))
                if restored['dataPath'] != str(source): raise ValueError()
                if checkpoint is not None: health(restored)
                mark('rolled_back')
            except Exception:
                raise ValueError('迁移未完成，自动恢复未确认。旧目录仍保留，请检查用户服务后再同步。') from None
        if isinstance(error, ValueError): raise
        raise ValueError('迁移未完成，已恢复旧服务；旧目录与已复制的目标文件均保留。') from None


MOVE_PHASES = {'accepted', 'stopping', 'copying', 'copy_verified', 'switching',
               'verified', 'rolling_back', 'rolled_back', 'rejected'}


def move_identity(payload):
    job_id = payload.get('jobId')
    account_id = payload.get('accountId')
    cursor = payload.get('cursor', 0)
    if not isinstance(job_id, str) or not re.fullmatch(r'[a-f0-9]{32}', job_id):
        raise ValueError('目录迁移缺少有效任务标识，请更新客户端后重试。')
    if not isinstance(account_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', account_id):
        raise ValueError('同步账号标识无效。')
    if type(cursor) is not int or cursor < 0:
        raise ValueError('本机同步进度无效。')
    paths = []
    for key in ('expectedPath', 'dataPath'):
        raw = payload.get(key)
        if not isinstance(raw, str) or not raw or len(raw) > 2048:
            raise ValueError('迁移目录路径无效。')
        path = plain_path(raw)
        if str(path) != raw:
            raise ValueError('迁移目录须使用规范的绝对路径。')
        paths.append(path)
    source, target = paths
    if source == target or source in target.parents or target in source.parents:
        raise ValueError('新目录不能与旧目录相同，也不能互相包含。')
    return {'jobId': job_id, 'accountId': account_id, 'cursor': cursor,
            'expectedPath': str(source), 'dataPath': str(target)}


def receipt_directory(identity, create=False):
    home = plain_path(str(Path.home()))
    base = home / '.config/systemd/user'
    root = base / '.aibro-migrations'
    for raw in (identity['expectedPath'], identity['dataPath']):
        path = Path(raw)
        if path == root or path in root.parents or root in path.parents:
            raise ValueError('数据目录不能包含远端迁移记录目录。')
    # Existing ancestors must be owned and not writable by another user; never
    # follow a symlink or repair permissions on someone else's files.
    for path in (home, home / '.config', home / '.config/systemd', base):
        plain_path(str(path))
        try: metadata = path.stat()
        except FileNotFoundError:
            if not create: return None
            raise ValueError('未找到当前用户的 systemd 配置目录。') from None
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o022:
            raise ValueError('远端迁移记录上级目录的归属或权限无效。')
    plain_path(str(root))
    if create:
        root.mkdir(mode=0o700, exist_ok=True)
        sync_directory(base)
    try: metadata = root.stat()
    except FileNotFoundError: return None
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
        raise ValueError('远端迁移记录目录必须由当前用户私有持有。')
    return root


def read_receipt(identity):
    root = receipt_directory(identity)
    if root is None: return None
    path = root / (identity['jobId'] + '.json')
    try: descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError: return None
    except OSError: raise ValueError('远端迁移记录不是可读取的普通文件。') from None
    try:
        metadata = os.fstat(descriptor)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                or metadata.st_mode & 0o077 or metadata.st_nlink != 1 or metadata.st_size > 65536):
            raise ValueError('远端迁移记录的类型、归属或权限无效。')
        with os.fdopen(descriptor, 'r', encoding='utf-8') as stream:
            descriptor = None
            record = json.load(stream)
    except (UnicodeError, json.JSONDecodeError):
        raise ValueError('远端迁移记录损坏，无法确认结果；未重新执行。') from None
    finally:
        if descriptor is not None: os.close(descriptor)
    if not isinstance(record, dict) or record.get('version') != 1 or record.get('identity') != identity:
        raise ValueError('迁移任务标识与账号、进度或目录不匹配；未重新执行。')
    job = record.get('job')
    if (not isinstance(job, dict) or job.get('id') != identity['jobId']
            or job.get('source') != identity['expectedPath'] or job.get('destination') != identity['dataPath']
            or job.get('state') not in ('running', 'completed', 'error', 'uncertain')
            or job.get('phase') not in MOVE_PHASES or type(job.get('startedAt')) not in (int, float)
            or not isinstance(job.get('message'), str)
            or (job.get('state') == 'completed' and job.get('phase') != 'verified')
            or (job.get('state') == 'error' and job.get('phase') not in ('rejected', 'rolled_back'))):
        raise ValueError('远端迁移记录结构无效，无法确认结果；未重新执行。')
    if job['phase'] in ('copy_verified', 'switching', 'verified'):
        if (type(job.get('verifiedFiles')) is not int or job['verifiedFiles'] < 1
                or not isinstance(job.get('manifestDigest'), str)
                or not re.fullmatch(r'[a-f0-9]{64}', job['manifestDigest'])):
            raise ValueError('远端迁移缺少复制校验证据，无法确认完成。')
    return record


def save_receipt(record):
    root = receipt_directory(record['identity'], create=True)
    # Validate any existing file before replacing it (symlinks/hardlinks and
    # identity reuse are rejected). All callers hold the mutation lock.
    read_receipt(record['identity'])
    atomic(root / (record['identity']['jobId'] + '.json'),
           json.dumps(record, ensure_ascii=False, sort_keys=True).encode('utf-8'))


def public_job(job):
    return {key: value for key, value in job.items() if key in {
        'id', 'state', 'source', 'destination', 'phase', 'message', 'startedAt',
        'finishedAt', 'verifiedFiles', 'recovered'}}


def observed_deployment(identity):
    try:
        info = deployment(identity['accountId'], identity['cursor'])
        health(info)
        info.pop('argv', None)
        return info
    except Exception: return {}


def receipt_result(record, locked=False):
    """Read-only projection. A running receipt with no holder is interrupted.

    A destination path alone never proves copying succeeded. The durable phase
    must prove checksum/database verification preceded the switch, and the
    current account/path plus health must still match.
    """
    job = dict(record['job']); identity = record['identity']
    if locked:
        if job['state'] == 'running':
            job['message'] = '远端管理操作仍占用锁，正在等待读取本次迁移的最终回执。'
        return {'job': public_job(job)}
    info = observed_deployment(identity)
    if job['state'] in ('completed', 'error'):
        expected = identity['dataPath'] if job['state'] == 'completed' else identity['expectedPath']
        if info.get('dataPath') != expected:
            job.update(state='uncertain', message='已保留历史迁移回执，但当前服务、账号目录或健康状态尚未重新确认；自动同步仍应暂停。')
            return {'job': public_job(job)}
        return {**info, 'job': public_job(job)}
    if job['phase'] == 'accepted':
        if info.get('dataPath') == identity['expectedPath']:
            job.update(state='error', phase='rejected', recovered=True,
                       message='远端操作在停止服务之前中断，未开始迁移，原目录服务仍健康。')
    elif job['phase'] == 'rolled_back' and info.get('dataPath') == identity['expectedPath']:
        job.update(state='error', recovered=True, message='远端已恢复原目录服务；迁移未完成，源目录与已复制文件保留。')
    elif job['phase'] in ('copy_verified', 'switching', 'verified') and info.get('dataPath') == identity['dataPath']:
        job.update(state='completed', phase='verified', recovered=True,
                   message='已根据远端复制校验记录、当前目录和健康检查确认迁移完成。')
    if job['state'] not in ('completed', 'error'):
        job.update(state='uncertain', message='远端迁移进程已结束，但完成或回滚尚未确认。未重新执行，请检查服务与保留的两个目录。')
    return {**info, 'job': public_job(job)}


def missing_receipt(identity):
    return {'job': {'id': identity['jobId'], 'state': 'uncertain', 'phase': 'missing',
                    'source': identity['expectedPath'], 'destination': identity['dataPath'],
                    'message': '未找到此任务的远端回执，不能确认是否执行；未重新执行。'}}


def move_status(payload):
    identity = move_identity(payload)
    try:
        # Inspection never creates a journal/lock or updates the receipt.
        with mutation_lock(create=False):
            record = read_receipt(identity)
            return receipt_result(record) if record else missing_receipt(identity)
    except BlockingIOError:
        record = read_receipt(identity)
        return receipt_result(record, locked=True) if record else missing_receipt(identity)
    except FileNotFoundError:
        return missing_receipt(identity)


def move_job(payload):
    identity = move_identity(payload)
    with mutation_lock():
        existing = read_receipt(identity)
        if existing: return receipt_result(existing)
        record = {'version': 1, 'identity': identity, 'job': {
            'id': identity['jobId'], 'source': identity['expectedPath'], 'destination': identity['dataPath'],
            'state': 'running', 'phase': 'accepted', 'startedAt': time.time(),
            'message': '远端已记录迁移任务，正在停止服务、复制和校验。'}}
        save_receipt(record)
        def checkpoint(phase, **fields):
            record['job'].update(phase=phase, **fields)
            save_receipt(record)
        try:
            result = relocate(identity, checkpoint=checkpoint)
            record['job'].update(state='completed', finishedAt=time.time(),
                                 message='已复制并校验，服务已切换。旧目录保留在原位置。')
            save_receipt(record)
            return {**result, 'job': public_job(record['job'])}
        except Exception as error:
            phase = record['job']['phase']
            if phase == 'accepted': phase = 'rejected'
            record['job'].update(state='error' if phase in ('rejected', 'rolled_back') else 'uncertain',
                                 phase=phase, finishedAt=time.time(),
                                 message=str(error) if isinstance(error, ValueError) else '远端迁移结果未确认，请检查用户服务；未重新执行。')
            try: save_receipt(record)
            except Exception:
                # Never report a terminal receipt that failed to reach disk.
                record['job'].update(state='uncertain', message='无法持久保存远端迁移结果，未重新执行；请恢复后读取回执。')
            # A preflight rejection or rollback is terminal only when the
            # original account/path and service health are still observed.
            if record['job']['state'] == 'error': return receipt_result(record)
            return {**observed_deployment(identity), 'job': public_job(record['job'])}


def main():
    try:
        payload = json.load(sys.stdin)
        # Serialize with a server-wide per-user lock, never stored in the data
        # directory that is being copied. Inspection stays read-only.
        action = payload.get('action')
        if action == 'move':
            result = move_job(payload)
        elif action == 'move-status':
            result = move_status(payload)
        elif action in ('authorize-device', 'revoke-device'):
            with mutation_lock():
                result = device_action(payload, revoke=action == 'revoke-device')
        elif action == 'probe':
            result = probe(payload)
        elif action == 'inspect':
            result = deployment(payload['accountId'], payload.get('cursor', 0)); result.pop('argv', None)
        else: raise ValueError('不支持的 SSH 管理操作。')
        print(json.dumps({'ok': True, **result}, ensure_ascii=False))
    except ValueError as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
    except Exception:
        print(json.dumps({'ok': False, 'error': '无法读取或修改云服务，请检查 SSH 权限和用户服务状态。'}, ensure_ascii=False))


if __name__ == '__main__': main()
