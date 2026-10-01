"""Raster images belonging to a Markdown file in an explicitly connected folder.

An image insertion writes an immutable sibling asset, never the Markdown file.
All filesystem access stays beneath the current grant using no-follow dirfds.
"""
import hashlib
import io
import os
from pathlib import PurePosixPath
import posixpath
import re
import stat
from urllib.parse import quote, unquote, urlsplit
import uuid
import zipfile

from comparison_drafts import _is_private
from document_media import MAX_IMAGE_BYTES, MediaError, decode_image, portable_markdown, safe_name, validate_image
from local_projects import LocalProjectError


def _inactive(value):
    return any(value.get(key) for key in ('archived', 'archivedAt', 'deleted', 'deletedAt')) or value.get('status') in ('archived', 'deleted')


class LocalDocumentMedia:
    def __init__(self, projects, load_state=None):
        self.projects = projects
        self.load_state = load_state

    def _scope(self, payload, write=False):
        if not isinstance(payload, dict):
            raise LocalProjectError('本机图片请求格式无效。')
        if self.load_state is None:
            return
        state = self.load_state()
        if not isinstance(state, dict):
            raise LocalProjectError('文档所属工作区暂不可访问。', 409)
        identifier = payload.get('projectId')
        projects = [p for p in state.get('projects', []) if isinstance(p, dict) and p.get('id') == identifier]
        if len(projects) != 1 or _inactive(projects[0]):
            raise LocalProjectError('文档所属项目已不可访问。', 409)
        project = projects[0]
        if not isinstance(project.get('localFolder'), dict) or project['localFolder'].get('id') != payload.get('candidateId'):
            raise LocalProjectError('本机目录连接已变化，请重新打开文件。', 409)
        private = _is_private(project)
        origin = payload.get('sourceConversationId')
        if origin is not None:
            conversations = [c for c in state.get('conversations', []) if isinstance(c, dict) and c.get('id') == origin]
            if len(conversations) != 1 or _inactive(conversations[0]):
                raise LocalProjectError('文档来源对话已不可访问。', 409)
            private = private or _is_private(conversations[0])
            owner = conversations[0].get('projectId')
            if owner:
                parents = [p for p in state.get('projects', []) if isinstance(p, dict) and p.get('id') == owner]
                if len(parents) != 1 or _inactive(parents[0]):
                    raise LocalProjectError('来源对话所属项目已不可访问。', 409)
                private = private or _is_private(parents[0])
        if write and private:
            raise LocalProjectError('私密对话不向磁盘保存新图片。请在普通项目中插入图片。', 403)

    def _document_parts(self, path):
        parts = self.projects._parts(path)
        if not parts or PurePosixPath(parts[-1]).suffix.lower() not in ('.md', '.markdown', '.mdx'):
            raise LocalProjectError('图片只能插入 Markdown 文档。', 415)
        return parts

    @staticmethod
    def _file(parent, name, limit=None):
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                raise LocalProjectError('不支持链接或特殊文件。', 403)
            if limit is None:
                return before, None
            if before.st_size > limit:
                raise LocalProjectError('图片超过 16 MB，请压缩后重试。', 413)
            with os.fdopen(os.dup(descriptor), 'rb') as handle:
                raw = handle.read(limit + 1)
            after = os.fstat(descriptor)
            if len(raw) > limit or (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size):
                raise LocalProjectError('读取期间文件发生变化，请稍后重试。', 409)
            return after, raw
        finally:
            os.close(descriptor)

    @staticmethod
    def _identity(value):
        return value.st_dev, value.st_ino

    def _relative(self, document_parts, image):
        if not isinstance(image, str) or not image or re.search(r'[\x00-\x1f\x7f\\]', image):
            raise LocalProjectError('图片路径无效。')
        try:
            parsed = urlsplit(image)
            if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment or parsed.path.startswith('/'):
                raise ValueError()
            decoded = unquote(parsed.path, encoding='utf-8', errors='strict')
            if decoded.startswith('/') or '\\' in decoded or '\x00' in decoded:
                raise ValueError()
            path = posixpath.normpath(posixpath.join(*document_parts[:-1], decoded))
            # Relative ../ images are valid only while they stay in this grant.
            if path in ('.', '..') or path.startswith('../'):
                raise ValueError()
            return '/'.join(self.projects._parts(path))
        except (ValueError, UnicodeError):
            raise LocalProjectError('图片必须位于当前已连接的本机项目中。', 403)

    def upload(self, payload):
        self._scope(payload, write=True)
        parts = self._document_parts(payload.get('path'))
        raw, metadata = decode_image(payload.get('data'))
        digest = hashlib.sha256(raw).hexdigest()
        extension = metadata['extension'].lstrip('.')
        image_name = digest + '.' + extension
        stem = PurePosixPath(parts[-1]).stem.encode('utf-8')[:180].decode('utf-8', errors='ignore')
        asset_name = stem + '.assets'
        self.projects._parts(asset_name)
        with self.projects._connected_folder(payload.get('candidateId')) as folder:
            self._scope(payload, write=True)
            parent = self.projects._open_below(folder, '/'.join(parts[:-1]))
            try:
                original, _ = self._file(parent, parts[-1])
                try:
                    os.mkdir(asset_name, mode=0o700, dir_fd=parent)
                    os.fsync(parent)
                except FileExistsError:
                    pass
                assets = self.projects._open_below(parent, asset_name)
                temporary = '.image-' + uuid.uuid4().hex
                try:
                    try:
                        _, existing = self._file(assets, image_name, MAX_IMAGE_BYTES)
                    except FileNotFoundError:
                        existing = None
                    if existing is not None:
                        if existing != raw:
                            raise LocalProjectError('同名图片内容已变化，未覆盖现有文件。', 409)
                    else:
                        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=assets)
                        with os.fdopen(descriptor, 'wb') as handle:
                            handle.write(raw)
                            handle.flush()
                            os.fsync(handle.fileno())
                        self._scope(payload, write=True)
                        # Reopen the same path before publication, so replaced
                        # document/parent/asset directories cannot redirect it.
                        fresh_parent = self.projects._open_below(folder, '/'.join(parts[:-1]))
                        try:
                            fresh, _ = self._file(fresh_parent, parts[-1])
                            fresh_assets = self.projects._open_below(fresh_parent, asset_name)
                            try:
                                if (self._identity(original) != self._identity(fresh)
                                        or self._identity(os.fstat(parent)) != self._identity(os.fstat(fresh_parent))
                                        or self._identity(os.fstat(assets)) != self._identity(os.fstat(fresh_assets))):
                                    raise LocalProjectError('文档位置已变化，图片未插入，请重新打开文件。', 409)
                                try:
                                    os.link(temporary, image_name, src_dir_fd=assets, dst_dir_fd=assets, follow_symlinks=False)
                                except FileExistsError:
                                    _, existing = self._file(assets, image_name, MAX_IMAGE_BYTES)
                                    if existing != raw:
                                        raise LocalProjectError('同名图片内容已变化，未覆盖现有文件。', 409)
                                os.unlink(temporary, dir_fd=assets)
                                os.fsync(assets)
                            finally:
                                os.close(fresh_assets)
                        finally:
                            os.close(fresh_parent)
                finally:
                    try:
                        os.unlink(temporary, dir_fd=assets)
                    except FileNotFoundError:
                        pass
                    os.close(assets)
            finally:
                os.close(parent)
        return {'url': quote(asset_name + '/' + image_name, safe='/'), 'alt': safe_name(payload.get('name'), '图片'),
                'mimeType': metadata['mimeType'], 'size': len(raw)}

    def _read_in_folder(self, folder, document_parts, image):
        path = self._relative(document_parts, image)
        parts = self.projects._parts(path)
        parent = self.projects._open_below(folder, '/'.join(parts[:-1]))
        try:
            _, raw = self._file(parent, parts[-1], MAX_IMAGE_BYTES)
            metadata = validate_image(raw)
            return {'data': raw, 'mimeType': metadata['mimeType'], 'name': parts[-1], 'metadata': metadata}
        finally:
            os.close(parent)

    def read(self, candidate_id, path, image, project_id=None, source_conversation_id=None):
        payload = {'candidateId': candidate_id, 'path': path, 'projectId': project_id,
                   **({'sourceConversationId': source_conversation_id} if source_conversation_id else {})}
        self._scope(payload)
        parts = self._document_parts(path)
        with self.projects._connected_folder(candidate_id) as folder:
            parent = self.projects._open_below(folder, '/'.join(parts[:-1]))
            try:
                self._file(parent, parts[-1])
                return self._read_in_folder(folder, parts, image)
            finally:
                os.close(parent)

    def export(self, payload):
        self._scope(payload)
        parts = self._document_parts(payload.get('path'))
        content = payload.get('content')
        if not isinstance(content, str):
            raise LocalProjectError('导出需要完整 Markdown 内容。')
        if len(content.encode('utf-8')) > 4 * 1024 * 1024:
            raise LocalProjectError('文档超过 4 MB，暂不能导出图片包。', 413)
        with self.projects._connected_folder(payload.get('candidateId')) as folder:
            parent = self.projects._open_below(folder, '/'.join(parts[:-1]))
            try:
                self._file(parent, parts[-1])
                resolved = {}
                def resolve(image):
                    key = self._relative(parts, image)
                    if key in resolved:
                        return resolved[key]
                    value = self._read_in_folder(folder, parts, image)
                    name = hashlib.sha256(value['data']).hexdigest() + '.' + value['metadata']['extension'].lstrip('.')
                    resolved[key] = {'path': 'assets/' + name, 'data': value['data']}
                    return resolved[key]
                rewritten, files = portable_markdown(content, resolve)
            finally:
                os.close(parent)
        name = safe_name(payload.get('title') or parts[-1], 'document.md')
        if not name.lower().endswith(('.md', '.markdown', '.mdx')):
            name += '.md'
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(name, rewritten.encode('utf-8'))
            for path, raw in files.items():
                archive.writestr(path, raw)
        return {'data': output.getvalue(), 'mimeType': 'application/zip', 'name': str(PurePosixPath(name).with_suffix('.zip'))}
