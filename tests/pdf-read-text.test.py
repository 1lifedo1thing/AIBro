"""Real read-only PDF text HTTP reads: rotation, CJK, continuation, scope and bounds."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import urllib.error
import urllib.request
import fitz
from http_test_support import python_http_service

ROOT = Path(__file__).resolve().parents[1] / 'app'


def response(origin, suffix, headers=None):
    request = urllib.request.Request(origin + suffix, headers=headers or {})
    try:
        result = urllib.request.urlopen(request, timeout=15)
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()
    with result:
        return result.status, result.headers, result.read()


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


with tempfile.TemporaryDirectory(prefix='workstation-pdf-read-text-') as temporary:
    data = Path(temporary)
    files = data / 'files'
    files.mkdir()
    with fitz.open() as document:
        for rotation in (0, 90, 180, 270):
            page = document.new_page(width=400, height=400)
            page.insert_text((25, 40), f'Page rotation {rotation}: original text')
            page.insert_text((25, 75), '中文资料完整读取', fontname='china-s', fontsize=12)
            page.insert_text((260, 320), 'ROTATED_TEXT_PRESERVED', rotate=90, fontsize=10)
            page.insert_text((200, 300), '旋转中文仍可读取', fontname='china-s', rotate=90, fontsize=12)
            page.set_rotation(rotation)
        source = document.tobytes()
        (files / 'text').write_bytes(source)
        (files / 'encrypted').write_bytes(document.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw='fixture-owner', user_pw='fixture-user'))
        (files / 'restricted').write_bytes(document.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw='fixture-owner', user_pw='', permissions=fitz.PDF_PERM_PRINT))
        expected = [page.get_text('text', sort=True, flags=fitz.TEXTFLAGS_TEXT & ~fitz.TEXT_PRESERVE_IMAGES) for page in document]
    with fitz.open() as document:
        page = document.new_page(width=1000, height=2500)
        for row in range(400):
            page.insert_text((10, 20 + row * 6), f'ROW{row:04d} ' + 'paginated evidence ' * 4, fontsize=5)
        page.insert_text((10, 2450), '最后一行不可遗漏', fontname='china-s', fontsize=12)
        (files / 'dense').write_bytes(document.tobytes())
        dense_text = page.get_text('text', sort=True, flags=fitz.TEXTFLAGS_TEXT & ~fitz.TEXT_PRESERVE_IMAGES)
        assert len(dense_text) > 24000 and '最后一行不可遗漏' in dense_text
    with fitz.open() as raster_source:
        page = raster_source.new_page(width=300, height=150)
        page.insert_text((30, 40), 'Scanned ink is not text evidence')
        raster = page.get_pixmap().tobytes('png')
    with fitz.open() as document:
        document.new_page(width=300, height=150).insert_image(fitz.Rect(0, 0, 300, 150), stream=raster)
        document.new_page(width=300, height=150)
        (files / 'scan').write_bytes(document.tobytes())
    (files / 'not-pdf').write_bytes(raster)
    (files / 'corrupt').write_bytes(b'%PDF corrupted fixture')
    (files / 'text.meta.json').write_text(json.dumps({'name': 'Synthetic original.pdf', 'mimeType': 'application/pdf'}))
    (data / 'outside.pdf').write_bytes(source)
    (files / 'linked').symlink_to(data / 'outside.pdf')
    with (files / 'oversized').open('wb') as stream:
        stream.truncate(64 * 1024 * 1024 + 1)
    before = {file.name: digest(file) for file in files.iterdir() if not file.is_symlink()}
    checks = 0
    with python_http_service(ROOT / 'server.py', cwd=data, env={**os.environ, 'AI_WORKSTATION_PORT': '0', 'AI_WORKSTATION_DATA_DIR': str(data), 'AI_WORKSTATION_ASSET_DIR': str(ROOT)}) as origin:
        for page_number, expected_text in enumerate(expected, 1):
            status, headers, body = response(origin, f'/__files/text/read-text?page={page_number}&offset=0')
            assert status == 200, (status, body)
            payload = json.loads(body)
            assert payload['text'] == expected_text
            assert 'ROTATED_TEXT_PRESERVED' in payload['text'] and '旋转中文仍可读取' in payload['text'] and '中文资料完整读取' in payload['text']
            assert payload['page'] == page_number and payload['pageCount'] == 4
            assert payload['offset'] == 0 and payload['totalChars'] == len(expected_text) and payload['nextOffset'] is None
            assert payload['originalRead'] is True and payload['imagesIncluded'] is False and payload['textAvailable'] is True
            assert payload['readMode'] == 'extracted_text' and payload['cursorUnit'] == 'unicode_codepoints'
            assert not any(key in payload for key in ('words', 'blocks', 'image', 'imageUrl', 'data'))
            assert headers['Content-Type'].startswith('application/json') and headers['Cache-Control'] == 'no-store'
            assert int(headers['Content-Length']) == len(body)
            checks += 1
        # Old geometry layer still truthfully omits internally rotated text;
        # the new evidence endpoint must not inherit that omission.
        overlay = json.loads(response(origin, '/__files/text/preview-text?page=1')[2])
        assert overlay['partial'] and all('ROTATED_TEXT_PRESERVED' not in word['text'] for word in overlay['words'])
        assert json.loads(response(origin, '/__files/text/preview-info')[2])['pageCount'] == 4
        assert response(origin, '/__files/text/preview?scale=0.5')[2].startswith(b'\x89PNG')
        checks += 1

        assembled, offset, requests = '', 0, 0
        while True:
            status, _, body = response(origin, f'/__files/dense/read-text?page=1&offset={offset}')
            payload = json.loads(body)
            assert status == 200 and payload['offset'] == offset
            assert payload['totalChars'] == len(dense_text) and 0 < len(payload['text']) <= 12000
            assert len(body) < 100000, 'A bounded text chunk must not include image payloads'
            assembled += payload['text']
            requests += 1
            next_offset = payload['nextOffset']
            if next_offset is None:
                break
            assert next_offset == offset + len(payload['text']) and next_offset < len(dense_text)
            offset = next_offset
        assert requests >= 3 and assembled == dense_text, 'Continuation must reconstruct every extracted character exactly once'
        eof = json.loads(response(origin, f'/__files/dense/read-text?offset={len(dense_text)}')[2])
        assert eof['text'] == '' and eof['nextOffset'] is None and eof['textAvailable'] is True
        assert response(origin, f'/__files/dense/read-text?offset={len(dense_text) + 1}')[0] == 400
        assert json.loads(response(origin, '/__files/text/read-text')[2]) == json.loads(response(origin, '/__files/text/read-text?page=1&offset=0')[2])
        checks += 1

        for page_number in (1, 2):
            status, _, body = response(origin, f'/__files/scan/read-text?page={page_number}')
            payload = json.loads(body)
            assert status == 200 and payload['text'] == '' and payload['totalChars'] == 0 and payload['nextOffset'] is None
            assert payload['textAvailable'] is False and payload['imagesIncluded'] is False
            assert payload['code'] == 'PDF_TEXT_UNAVAILABLE' and 'OCR' in payload['warning']
            assert 'Scanned ink' not in payload['text']
            checks += 1

        invalid_queries = ['?offset=-1', '?offset=1.1', '?offset=', '?offset=nan', '?offset=Infinity', '?offset=true', '?offset=1e3', '?offset=%2B1', '?offset=%201', '?offset=0&offset=0', '?offset=0&offset=1', '?offset=9007199254740992', '?offset=00000000000000000', '?page=-1', '?page=1.5', '?page=', '?page=1&page=1', '?page=one']
        for query in invalid_queries:
            status, _, body = response(origin, '/__files/text/read-text' + query)
            assert status == 400 and json.loads(body).get('error'), (query, status, body)
            assert str(data).encode() not in body
            checks += 1
        for query in ('?page=0', '?page=5'):
            assert response(origin, '/__files/text/read-text' + query)[0] == 404
            checks += 1
        for identifier, expected_status in [('missing', 404), ('bad%2Fid', 400), ('%2e%2e', 400), ('linked', 400), ('oversized', 400), ('encrypted', 400), ('restricted', 403), ('corrupt', 400), ('not-pdf', 400)]:
            status, _, body = response(origin, f'/__files/{identifier}/read-text')
            assert status == expected_status, (identifier, status, body)
            assert str(data).encode() not in body
            if identifier == 'restricted':
                assert json.loads(body)['code'] == 'PDF_COPY_RESTRICTED'
            checks += 1
        for headers in ({'Origin': 'https://outside.invalid'}, {'Host': 'outside.invalid'}, {'Sec-Fetch-Site': 'cross-site'}):
            status, _, body = response(origin, '/__files/text/read-text', headers)
            assert status == 403 and json.loads(body)['code'] == 'INVALID_ORIGIN'
            checks += 1
        assert response(origin, '/__files/text/read-text', {'Origin': origin})[0] == 200
        files.rename(data / 'real-files')
        files.symlink_to(data / 'real-files', target_is_directory=True)
        try:
            assert response(origin, '/__files/text/read-text')[0] == 400
        finally:
            files.unlink()
            (data / 'real-files').rename(files)
        checks += 1
        assert response(origin, '/__files/text')[2] == source
    after = {file.name: digest(file) for file in files.iterdir() if not file.is_symlink()}
    assert before == after, 'Every original PDF, image and metadata byte must remain unchanged'
    checks += 1

print(f'PDF text-only read: {checks} checks passed (real HTTP, CJK/rotated text, exact continuation, scanned pages, permissions, no-follow paths, origins, bounded chunks, originals preserved)')
