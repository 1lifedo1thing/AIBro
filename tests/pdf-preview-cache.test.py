"""Bounded PDF response reuse with real MuPDF bytes and exact production handler.

AST extraction avoids starting a server or constructing the user's WorkspaceStore.
HTTP writes use an isolated sink that rejects writes while the PDF lock is held.
No credentials, real workspaces, network access or retained MuPDF documents.
"""
import ast
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import select
import socket
import stat
import tempfile
import threading
import time
from types import SimpleNamespace
import unicodedata
import unittest
from unittest.mock import patch
import urllib.parse

import fitz

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ast.parse((ROOT / 'app/server.py').read_text())
SELECTED = []
for node in SOURCE.body:
    if isinstance(node, ast.Assign) and any(isinstance(name, ast.Name) and
        (name.id.startswith('MAX_PDF_') or name.id in ('MAX_FILE', 'MAX_PREVIEW_PIXELS', 'PDF_PREVIEW_LOCK', 'PDF_RESPONSE_CACHE'))
        for name in node.targets):
        SELECTED.append(node)
    elif isinstance(node, ast.ClassDef) and node.name == 'PDFResponseCache':
        SELECTED.append(node)
    elif isinstance(node, ast.FunctionDef) and node.name.startswith('pdf_'):
        SELECTED.append(node)
HANDLER = next(node for node in ast.walk(SOURCE) if isinstance(node, ast.FunctionDef) and node.name == 'do_pdf_preview')
SELECTED.append(HANDLER)


def namespace():
    value = dict(globals())
    exec(compile(ast.Module(body=SELECTED, type_ignores=[]), 'server.py', 'exec'), value)
    return value


class PDFCacheTests(unittest.TestCase):
    def setUp(self):
        self.ns = namespace()
        class OwnedLock:
            def __init__(self): self.mutex, self.local = threading.Lock(), threading.local()
            def __enter__(self):
                self.mutex.acquire(); self.local.held = True
                return self
            def __exit__(self, *_):
                self.local.held = False; self.mutex.release()
            def locked(self): return getattr(self.local, 'held', False)
        self.ns['PDF_PREVIEW_LOCK'] = OwnedLock()
        self.temp = tempfile.TemporaryDirectory(prefix='pdf-response-cache-')
        self.addCleanup(self.temp.cleanup)
        self.files = Path(self.temp.name) / 'files'
        self.files.mkdir()
        self.source = self.files / 'source'
        self.source.write_bytes(self.pdf('A'))
        self.ns['STORE'] = SimpleNamespace(file_path=lambda identifier: self.files / identifier)

    @staticmethod
    def pdf(marker, restricted=False):
        with fitz.open() as document:
            for number in (1, 2):
                page = document.new_page(width=150, height=180)
                page.insert_text((10, 25), f'PDF {marker} page {number} alpha beta', fontsize=7)
                page.insert_text((10, 40), '中文资料', fontname='china-s', fontsize=7)
            options = dict(no_new_id=True, garbage=0)
            if restricted:
                options.update(encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw='fixture-owner', user_pw='', permissions=fitz.PDF_PERM_PRINT)
            return document.tobytes(**options)

    def request(self, action='info', query='', identifier='source', origin=True):
        ns = self.ns
        connection, peer = socket.socketpair()
        lock = ns['PDF_PREVIEW_LOCK']
        writes_unlocked = []

        class Sink(io.BytesIO):
            def write(self, value):
                writes_unlocked.append(not lock.locked())
                return super().write(value)

        class Handler:
            path = '/__files/' + identifier + '/preview' + ('?' + query if query else '')
            wfile = Sink()
            headers = {}
            code = None
            def valid_auth_origin(self): return origin
            def send_response(self, code):
                writes_unlocked.append(not lock.locked())
                self.code = code
            def send_header(self, key, value): self.headers[key] = value
            def end_headers(self): pass
            def send_json(self, value, status=200):
                self.send_response(status)
                self.wfile.write(json.dumps(value, ensure_ascii=False).encode('utf-8'))

        handler = Handler()
        handler.connection = connection
        try:
            ns['do_pdf_preview'](handler, identifier, **({'info': True} if action == 'info' else
                {'text': True} if action == 'text' else {'search': True} if action == 'search' else
                {'read_text': True} if action == 'read-text' else {}))
            self.assertTrue(all(writes_unlocked), 'A slow HTTP response may not hold the renderer lock')
            return handler.code, handler.headers, handler.wfile.getvalue()
        finally:
            connection.close()
            peer.close()

    def test_warm_success_reuses_immutable_bytes_but_opens_source_securely_each_time(self):
        before = hashlib.sha256(self.source.read_bytes()).digest()
        for action, query in [('info',''),('text','page=1'),('read-text','page=1'),('search','q=alpha'),('image','format=jpeg')]:
            with self.subTest(action=action), patch.object(fitz, 'open', wraps=fitz.open) as opened, patch.object(os, 'open', wraps=os.open) as filesystem_open:
                first = self.request(action, query)
                second = self.request(action, query)
                self.assertEqual(first, second)
                self.assertEqual(first[0], 200)
                self.assertEqual(first[1]['Cache-Control'], 'no-store')
                self.assertEqual(first[1]['X-Content-Type-Options'], 'nosniff')
                self.assertEqual(int(first[1]['Content-Length']), len(first[2]))
                self.assertEqual(opened.call_count, 1)
                self.assertEqual(filesystem_open.call_count, 4, 'Directory and file descriptors are checked even on a cache hit')
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).digest(), before)
        for content_type, body, accessed in self.ns['PDF_RESPONSE_CACHE'].entries.values():
            self.assertIsInstance(content_type, str)
            self.assertIsInstance(body, bytes)
            self.assertIsInstance(accessed, float)

    def test_action_and_effective_parameters_never_alias(self):
        cases = [('info',''),('info','page=2'),('text','page=1'),('text','page=2'),
                 ('read-text','offset=0'),('read-text','offset=1'),('search','q=alpha'),('search','q=ALPHA'),
                 ('search','q=beta'),('image','format=png'),('image','format=jpeg'),
                 ('image','format=jpeg&scale=0.5'),('image','format=jpeg&fit=1')]
        with patch.object(fitz, 'open', wraps=fitz.open) as opened:
            responses = [self.request(*case) for case in cases]
            self.assertTrue(all(response[0] == 200 for response in responses))
            self.assertEqual(opened.call_count, len(cases))
            self.assertEqual([self.request(*case) for case in cases], responses)
            self.assertEqual(opened.call_count, len(cases))
            self.assertEqual(self.request('image', 'format=jpeg&quality=1'), responses[10])
            self.assertEqual(opened.call_count, len(cases), 'Ignored caller quality must not alter fixed JPEG output')

    def test_atomic_and_same_inode_size_restored_mtime_replacement_invalidate(self):
        self.request('read-text')
        replacement = self.files / 'replacement'
        replacement.write_bytes(self.pdf('B').ljust(4096, b'\n'))
        os.replace(replacement, self.source)
        self.assertIn('PDF B', json.loads(self.request('read-text')[2])['text'])
        metadata = self.source.stat()
        alternate = self.pdf('C').ljust(4096, b'\n')
        self.assertEqual(len(alternate), metadata.st_size)
        self.source.write_bytes(alternate)
        os.utime(self.source, ns=(metadata.st_atime_ns, metadata.st_mtime_ns))
        self.assertEqual(self.source.stat().st_ino, metadata.st_ino)
        self.assertEqual(self.source.stat().st_mtime_ns, metadata.st_mtime_ns)
        self.assertIn('PDF C', json.loads(self.request('read-text')[2])['text'])

    def test_warm_permissions_are_bound_to_current_bytes_and_origin(self):
        self.assertEqual(self.request('read-text')[0], 200)
        with patch.object(fitz, 'open', wraps=fitz.open) as opened, patch.object(os, 'open', wraps=os.open) as source_open:
            self.assertEqual(self.request('read-text', origin=False)[0], 403)
            self.assertEqual(opened.call_count, 0)
            self.assertEqual(source_open.call_count, 0)
        self.source.write_bytes(self.pdf('R', restricted=True))
        for action, query in [('text',''),('read-text',''),('search','q=alpha')]:
            with self.subTest(action=action):
                status, _, body = self.request(action, query)
                self.assertEqual(status, 403)
                self.assertEqual(json.loads(body)['code'], 'PDF_COPY_RESTRICTED')
        self.assertEqual(self.request('image')[0], 200)

    def test_warm_delete_symlink_directory_swap_and_oversize_cannot_serve_old_output(self):
        self.request()
        original = self.source.read_bytes()
        outside = Path(self.temp.name) / 'outside'
        outside.write_bytes(original)
        self.source.unlink()
        with patch.object(fitz, 'open', wraps=fitz.open) as opened:
            self.assertEqual(self.request()[0], 404)
            self.source.symlink_to(outside)
            self.assertEqual(self.request()[0], 400)
            self.source.unlink()
            self.source.write_bytes(original)
            actual = self.files.with_name('actual-files')
            self.files.rename(actual)
            self.files.symlink_to(actual, target_is_directory=True)
            try: self.assertEqual(self.request()[0], 400)
            finally:
                self.files.unlink()
                actual.rename(self.files)
            with self.source.open('wb') as file: file.truncate(self.ns['MAX_FILE'] + 1)
            self.assertEqual(self.request()[0], 400)
            self.assertEqual(opened.call_count, 0)

    def test_errors_are_not_cached_and_all_responses_leave_renderer_lock(self):
        self.source.write_bytes(b'%PDF-invalid fixture')
        with patch.object(fitz, 'open', wraps=fitz.open) as opened:
            self.assertEqual(self.request()[0], 400)
            self.assertEqual(self.request()[0], 400)
            self.assertEqual(opened.call_count, 2)
        self.assertEqual(len(self.ns['PDF_RESPONSE_CACHE'].entries), 0)
        self.source.write_bytes(self.pdf('R', restricted=True))
        self.assertEqual(self.request('read-text')[0], 403)
        self.assertEqual(self.request('info', 'page=3')[0], 404)
        self.assertEqual(len(self.ns['PDF_RESPONSE_CACHE'].entries), 0)

    def test_large_success_responses_bypass_cache_without_changing_output(self):
        self.ns['PDF_RESPONSE_CACHE'] = self.ns['PDFResponseCache'](max_item_bytes=1)
        with patch.object(fitz, 'open', wraps=fitz.open) as opened:
            first = self.request('image', 'format=jpeg')
            self.assertEqual(self.request('image', 'format=jpeg'), first)
            self.assertEqual(first[0], 200)
            self.assertEqual(opened.call_count, 2)
        self.assertEqual(self.ns['PDF_RESPONSE_CACHE'].bytes, 0)

    def test_concurrent_requests_share_bytes_not_documents(self):
        with patch.object(fitz, 'open', wraps=fitz.open) as opened:
            with ThreadPoolExecutor(max_workers=4) as executor:
                values = list(executor.map(lambda _: self.request('image', 'format=jpeg'), range(8)))
            self.assertTrue(all(value == values[0] for value in values))
            self.assertEqual(values[0][0], 200)
            self.assertEqual(opened.call_count, 1)

    def test_expired_response_recomputes_once_without_timer_thread(self):
        now = [10.0]
        self.ns['PDF_RESPONSE_CACHE'] = self.ns['PDFResponseCache'](clock=lambda: now[0])
        with patch.object(fitz, 'open', wraps=fitz.open) as opened:
            first = self.request()
            now[0] += 44
            self.assertEqual(self.request(), first)
            self.assertEqual(opened.call_count, 1)
            now[0] += 45
            self.assertEqual(self.request(), first)
            self.assertEqual(opened.call_count, 2)

    def test_lru_byte_item_and_entry_limits_remain_bounded(self):
        now = [1.0]
        cache = self.ns['PDFResponseCache'](max_bytes=10, max_entries=2, max_item_bytes=6, clock=lambda: now[0])
        cache.put('a','text/plain',b'aaaa')
        cache.put('b','text/plain',b'bbbb')
        self.assertEqual(cache.get('a'), ('text/plain', b'aaaa'))
        cache.put('c','text/plain',b'cccc')
        self.assertIsNone(cache.get('b'))
        self.assertEqual(cache.bytes, 8)
        cache.put('d','text/plain',b'dddddd')
        self.assertIsNone(cache.get('a'))
        self.assertEqual(cache.bytes, 10)
        cache.put('too-large','text/plain',b'1234567')
        self.assertEqual(cache.bytes, 10)
        self.assertEqual(len(cache.entries), 2)
        now[0] += 45
        self.assertIsNone(cache.get('d'))
        self.assertEqual(cache.bytes, 0)
        self.assertEqual(len(cache.entries), 0)
        with self.assertRaises(TypeError): cache.put('mutable','text/plain',bytearray(b'abc'))
        defaults = self.ns['PDFResponseCache']()
        self.assertEqual((defaults.max_bytes, defaults.max_entries, defaults.max_item_bytes, defaults.idle_seconds), (16*1024*1024,128,2*1024*1024,45))


if __name__ == '__main__':
    unittest.main()
