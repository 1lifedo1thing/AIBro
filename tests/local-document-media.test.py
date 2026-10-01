"""Local Markdown image grants, durable files and complete portable exports."""
import base64
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.parse import unquote, urlencode
from urllib.request import Request, urlopen
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from PIL import Image
from document_media import MediaError
from local_projects import LocalProjects, LocalProjectError
from local_document_media import LocalDocumentMedia


class LocalImages(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='aibro-local-images-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.folder = self.base / 'project'
        self.folder.mkdir()
        (self.folder / 'docs').mkdir()
        self.document = self.folder / 'docs' / '原始文档.md'
        self.original = b'\xef\xbb\xbf# Original\r\n\r\nExact body\n'
        self.document.write_bytes(self.original)
        self.projects = LocalProjects(self.base / 'data')
        self.connection = self.projects.connect(str(self.folder))
        self.candidate = self.connection['candidate']['id']
        self.state = {'projects': [{'id': 'p', 'localFolder': {'id': self.candidate}}],
                      'conversations': [{'id': 'c', 'projectId': 'p'}]}
        self.media = LocalDocumentMedia(self.projects, lambda: self.state)
        output = io.BytesIO()
        Image.new('RGB', (3, 2), color=(45, 177, 102)).save(output, format='PNG')
        self.raw = output.getvalue()
        self.payload = {'projectId': 'p', 'candidateId': self.candidate, 'path': 'docs/原始文档.md',
                        'sourceConversationId': 'c', 'name': '示意图.png', 'data': base64.b64encode(self.raw).decode()}

    def upload(self, **extra):
        return self.media.upload({**self.payload, **extra})

    def read(self, image, **extra):
        return self.media.read(self.candidate, self.payload['path'], image,
                               extra.get('project_id', 'p'), extra.get('source_conversation_id', 'c'))

    def test_durable_deduped_asset_does_not_save_original(self):
        result = self.upload()
        path = self.document.parent / unquote(result['url'])
        self.assertEqual(path.read_bytes(), self.raw)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(path.stat().st_nlink, 1)
        self.assertEqual(self.document.read_bytes(), self.original)
        before = path.stat().st_mtime_ns
        self.assertEqual(self.upload()['url'], result['url'])
        self.assertEqual(path.stat().st_mtime_ns, before)
        restarted = LocalDocumentMedia(LocalProjects(self.base / 'data'), lambda: self.state)
        self.assertEqual(restarted.read(self.candidate, self.payload['path'], result['url'], 'p', 'c')['data'], self.raw)

    def test_existing_relative_image_can_traverse_to_parent_inside_grant(self):
        (self.folder / 'assets').mkdir()
        (self.folder / 'assets' / '原 图.png').write_bytes(self.raw)
        self.assertEqual(self.read('../assets/%E5%8E%9F%20%E5%9B%BE.png')['data'], self.raw)
        self.assertEqual(self.read('../assets/原 图.png')['mimeType'], 'image/png')

    def test_export_current_draft_rewrites_inline_and_reference_images_and_dedupes(self):
        result = self.upload()
        content = '\ufeff# Unsaved\r\n\r\n![one](<' + result['url'] + '>)\r\n![two][ref]\n\n[ref]: <' + result['url'] + '> "caption"\n'
        content += '\n```md\n![not an image](../../missing.png)\n```\n`![also ignored](bad.png)`\n'
        exported = self.media.export({**self.payload, 'title': 'Export.md', 'content': content})
        with zipfile.ZipFile(io.BytesIO(exported['data'])) as archive:
            names = archive.namelist()
            self.assertEqual(len(names), 2)
            image = next(name for name in names if name.startswith('assets/'))
            self.assertEqual(archive.read(image), self.raw)
            markdown = archive.read('Export.md').decode()
            self.assertEqual(markdown.count(image), 2)
            self.assertIn('![not an image](../../missing.png)', markdown)
            self.assertTrue(markdown.startswith('\ufeff# Unsaved\r\n'))
        self.assertEqual(self.document.read_bytes(), self.original)

    def test_missing_image_aborts_export_without_changing_document(self):
        with self.assertRaises((LocalProjectError, MediaError)):
            self.media.export({**self.payload, 'content': '![missing](missing.png)'})
        self.assertEqual(self.document.read_bytes(), self.original)

    def test_external_urls_never_fetch_and_traversal_never_escapes(self):
        for image in ('../../outside.png', '%2e%2e/%2e%2e/outside.png', '/etc/passwd',
                      'file:///etc/passwd', 'https://example.com/image.png', '//example.com/image.png',
                      '..\\outside.png', '../.git/config', '../assets/x.png?token=abc', 'x.png#secret'):
            with self.subTest(image=image), self.assertRaises(LocalProjectError):
                self.read(image)

    def test_symlink_image_and_directory_are_refused(self):
        outside = self.base / 'outside'
        outside.mkdir()
        (outside / 'image.png').write_bytes(self.raw)
        (self.document.parent / 'linked.png').symlink_to(outside / 'image.png')
        (self.document.parent / 'linked').symlink_to(outside, target_is_directory=True)
        for path in ('linked.png', 'linked/image.png'):
            with self.subTest(path=path), self.assertRaises(LocalProjectError):
                self.read(path)

    def test_symlink_asset_directory_never_writes_outside(self):
        outside = self.base / 'outside'
        outside.mkdir()
        (self.document.parent / '原始文档.assets').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(LocalProjectError):
            self.upload()
        self.assertEqual(list(outside.iterdir()), [])

    def test_missing_symlink_and_hardlinked_document_never_grant_upload(self):
        outside = self.base / 'other.md'
        outside.write_bytes(self.original)
        self.document.unlink()
        with self.assertRaises(LocalProjectError):
            self.upload()
        self.document.symlink_to(outside)
        with self.assertRaises(LocalProjectError):
            self.upload()
        self.document.unlink()
        os.link(outside, self.document)
        with self.assertRaises(LocalProjectError):
            self.upload()
        self.assertFalse((self.document.parent / '原始文档.assets').exists())

    def test_replaced_document_during_upload_is_not_used(self):
        scope = self.media._scope
        count = 0
        def changing(payload, write=False):
            nonlocal count
            scope(payload, write)
            count += 1
            if count == 3:
                self.document.rename(self.document.with_suffix('.original'))
                self.document.write_text('Different file')
        with patch.object(self.media, '_scope', changing), self.assertRaises(LocalProjectError):
            self.upload()
        self.assertEqual(self.document.read_text(), 'Different file')
        self.assertEqual(list((self.document.parent / '原始文档.assets').iterdir()), [])

    def test_corrupt_or_svg_payload_never_creates_asset_directory(self):
        for raw in (b'<svg><script>bad()</script></svg>', b'\x89PNG\r\n\x1a\ntruncated', b'not an image'):
            with self.subTest(raw=raw), self.assertRaises(MediaError):
                self.upload(data=base64.b64encode(raw).decode(), name='fake.png')
        self.assertFalse((self.document.parent / '原始文档.assets').exists())

    def test_mismatched_filename_uses_detected_raster_extension(self):
        result = self.upload(name='evil.html')
        self.assertTrue(result['url'].endswith('.png'))
        self.assertEqual(result['mimeType'], 'image/png')

    def test_revoked_connection_invalidates_reads_exports_and_uploads(self):
        result = self.upload()
        self.projects.disconnect(self.connection['root']['id'])
        for action in (lambda: self.upload(), lambda: self.read(result['url']),
                       lambda: self.media.export({**self.payload, 'content': '# plain'})):
            with self.assertRaises(LocalProjectError):
                action()

    def test_archived_duplicate_and_rebound_project_refused(self):
        original = dict(self.state['projects'][0])
        variants = [{**original, 'archivedAt': 1}, {**original, 'deleted': True},
                    {**original, 'status': 'archived'}, {**original, 'localFolder': {'id': 'other'}}]
        for variant in variants:
            self.state['projects'] = [variant]
            with self.assertRaises(LocalProjectError):
                self.upload()
        self.state['projects'] = [original, original]
        with self.assertRaises(LocalProjectError):
            self.upload()

    def test_private_scope_blocks_new_bytes_but_existing_images_remain_exportable(self):
        result = self.upload()
        self.state['conversations'][0]['private'] = True
        with self.assertRaises(LocalProjectError):
            self.upload()
        self.assertEqual(self.read(result['url'])['data'], self.raw)
        self.assertEqual(self.media.export({**self.payload, 'content': '![image](' + result['url'] + ')'})['mimeType'], 'application/zip')

    def test_failed_disk_flush_retains_original_and_cleans_temporary(self):
        actual = os.fsync
        def full(descriptor):
            if stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise OSError('disk full')
            return actual(descriptor)
        with patch('local_document_media.os.fsync', full), self.assertRaises(LocalProjectError):
            self.upload()
        self.assertEqual(self.document.read_bytes(), self.original)
        self.assertEqual(list((self.document.parent / '原始文档.assets').iterdir()), [])

    def test_changed_existing_hashed_image_is_not_overwritten(self):
        result = self.upload()
        asset = self.document.parent / unquote(result['url'])
        asset.write_bytes(b'changed by another program')
        with self.assertRaises(LocalProjectError):
            self.upload()
        self.assertEqual(asset.read_bytes(), b'changed by another program')
        with self.assertRaises(MediaError):
            self.read(result['url'])

    def test_export_decodes_repeated_image_only_once(self):
        result = self.upload()
        content = ('![same](' + result['url'] + ')\n') * 30
        actual = self.media._read_in_folder
        with patch.object(self.media, '_read_in_folder', wraps=actual) as reads:
            self.media.export({**self.payload, 'content': content})
            self.assertEqual(reads.call_count, 1)

    def test_document_filename_spaces_parentheses_and_unicode_have_canonical_url(self):
        renamed = self.document.with_name('我的 文档 (1).md')
        self.document.rename(renamed)
        self.document = renamed
        self.payload['path'] = 'docs/' + renamed.name
        result = self.upload()
        self.assertNotIn(' ', result['url'])
        self.assertIn('%20', result['url'])
        self.assertIn('%281%29', result['url'])
        self.assertEqual((renamed.parent / unquote(result['url'])).read_bytes(), self.raw)
        self.assertEqual(self.read(result['url'])['data'], self.raw)
        exported = self.media.export({**self.payload, 'content': '![uploaded](' + result['url'] + ')'})
        with zipfile.ZipFile(io.BytesIO(exported['data'])) as archive:
            self.assertEqual(len(archive.namelist()), 2)

    def test_existing_parenthesized_and_escaped_image_paths_are_bundled_in_lists(self):
        (self.document.parent / 'assets').mkdir()
        (self.document.parent / 'assets' / 'a(1).png').write_bytes(self.raw)
        content = '- Parent\n\n    ![nested](assets/a(1).png "Title")\n\n  - Child\n\n    ![escaped](assets/a\\(1\\).png)\n\n        ![code](missing.png)\n'
        exported = self.media.export({**self.payload, 'title': 'List.md', 'content': content})
        with zipfile.ZipFile(io.BytesIO(exported['data'])) as archive:
            image = next(name for name in archive.namelist() if name.startswith('assets/'))
            body = archive.read('List.md').decode()
            self.assertEqual(body.count(image), 2)
            self.assertIn('![code](missing.png)', body)
            self.assertEqual(archive.read(image), self.raw)

    def test_real_http_upload_read_export_and_cross_origin_denial(self):
        # Import initializes only this disposable host directory, never the
        # user's workspace. Handler globals are restored when the server stops.
        with patch.dict(os.environ, {'AI_WORKSTATION_DATA_DIR': str(self.base / 'http')}):
            import server
        store = server.WorkspaceStore(self.base / 'http')
        store.save({**self.state, 'notes': [], 'imports': [], 'tasks': [], 'trash': [], 'agentRuns': []})
        media = LocalDocumentMedia(self.projects, store.load)
        class QuietHandler(server.Handler):
            def log_message(self, *_args):
                pass
        with patch.object(server, 'STORE', store), patch.object(server, 'LOCAL_DOCUMENT_MEDIA', media):
            httpd = ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
            worker = threading.Thread(target=httpd.serve_forever, daemon=True)
            worker.start()
            origin = 'http://127.0.0.1:' + str(httpd.server_port)
            def request(path, payload=None, custom_origin=None):
                headers = {'Content-Type': 'application/json', 'Origin': custom_origin or origin}
                body = json.dumps(payload).encode() if payload is not None else None
                try:
                    with urlopen(Request(origin + path, data=body, headers=headers), timeout=3) as response:
                        return response.status, response.read(), response.headers
                except HTTPError as response:
                    return response.code, response.read(), response.headers
            try:
                self.assertEqual(request('/__local/document-images/upload', self.payload, 'https://other.invalid')[0], 403)
                status, raw, _ = request('/__local/document-images/upload', self.payload)
                self.assertEqual(status, 200, raw)
                uploaded = json.loads(raw)
                query = urlencode({key: self.payload[key] for key in ('candidateId', 'path', 'projectId', 'sourceConversationId')})
                status, raw, headers = request('/__local/document-images/read?' + query + '&' + urlencode({'image': uploaded['url']}))
                self.assertEqual(status, 200, raw)
                self.assertEqual(raw, self.raw)
                self.assertEqual(headers['Content-Type'], 'image/png')
                self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
                status, raw, headers = request('/__local/document-images/export', {**self.payload, 'title': 'Unsaved.md', 'content': '![x](' + uploaded['url'] + ')'})
                self.assertEqual(status, 200, raw)
                with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                    self.assertIn('Unsaved.md', archive.namelist())
                    self.assertEqual(len(archive.namelist()), 2)
                self.assertEqual(self.document.read_bytes(), self.original)
            finally:
                httpd.shutdown()
                httpd.server_close()
                worker.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
