#!/usr/bin/env python3
"""Bounded PDF HTTP baseline; run explicitly, never as part of the test sweep.

Uses the production server module, Handler routes, WorkspaceStore and PyMuPDF
against a fresh temporary workspace. Only timing/counting wrappers are added.
No formal workspace, credentials, models, network services or UI are accessed.

Default workload: three alternating-order rounds of info plus eight pages of
text/read-text/search/JPEG; one complete 100-page text read; two 20-page search
vs ten foreground JPEG races. Safety probes are separately labelled and excluded
from latency summaries. This is backend HTTP time, not native screen latency.

Example (run alone, after permission from the coordinating agent):
  PYTHONDONTWRITEBYTECODE=1 python3 tests/pdf-preview-performance.py --label before

An alternate --source-dir permits comparing a preserved complete app snapshot.
The output path is restricted to test-results/native-performance-20260930/.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib
import json
import os
from pathlib import Path
import random
import resource
import socket
import statistics
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'test-results/native-performance-20260930'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def summary(values):
    return {'count': len(values), 'median': statistics.median(values),
            'min': min(values), 'max': max(values)} if values else None


def rss_kib():
    # ru_maxrss is a lifetime peak, includes fixture/client, not current RSS.
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak / 1024 if sys.platform == 'darwin' else peak


def make_pdf(fitz, pages=100, marker='A', image=True):
    expected = []
    ppm = b'P6\n512 512\n255\n' + random.Random(1700).randbytes(512 * 512 * 3) if image else None
    with fitz.open() as doc:
        xref = 0
        for number in range(1, pages + 1):
            page = doc.new_page(width=612, height=792)
            page.insert_text((32, 40), f'Fixture {marker} / page {number:03d} / PDF evidence', fontsize=14)
            rows = [f'Row {row:02d}: alpha evidence on page {number:03d}. Retain complete source text.' for row in range(32)]
            page.insert_text((32, 66), '\n'.join(rows), fontsize=10)
            if image and number % 5 == 0:
                xref = page.insert_image(fitz.Rect(350, 560, 550, 760), stream=ppm, xref=xref)
            expected.append(page.get_text('text', sort=True, flags=fitz.TEXTFLAGS_TEXT & ~fitz.TEXT_PRESERVE_IMAGES))
        return doc.tobytes(garbage=0, deflate=False, expand=255, no_new_id=True), expected


class Measurements:
    def __init__(self):
        self.local = threading.local()
        self.mutex = threading.Lock()
        self.records = {}
        self.active = self.maximum_active = 0

    def add(self, key, amount=1):
        record = getattr(self.local, 'record', None)
        if record is not None:
            record[key] = record.get(key, 0) + amount

    def begin(self, identifier):
        self.local.record = {'id': identifier, 'sourceReadCalls': 0, 'sourceReadBytes': 0,
                             'sourceReadMs': 0, 'documentOpenCalls': 0, 'documentOpenMs': 0,
                             'lockWaitMs': 0, 'lockHeldMs': 0}

    def finish(self, started, cpu):
        record = self.local.record
        record.update(handlerMs=(time.perf_counter() - started) * 1000,
                      handlerCpuMs=(time.thread_time() - cpu) * 1000)
        with self.mutex:
            self.records[record['id']] = record
        del self.local.record


class MeasuredLock:
    def __init__(self, underlying, measurements):
        self.underlying, self.measurements = underlying, measurements
        self.local = threading.local()

    def __enter__(self):
        start = time.perf_counter()
        self.underlying.acquire()
        self.local.acquired = time.perf_counter()
        self.measurements.add('lockWaitMs', (self.local.acquired - start) * 1000)
        with self.measurements.mutex:
            self.measurements.active += 1
            self.measurements.maximum_active = max(self.measurements.maximum_active, self.measurements.active)
        return self

    def __exit__(self, *args):
        self.measurements.add('lockHeldMs', (time.perf_counter() - self.local.acquired) * 1000)
        with self.measurements.mutex:
            self.measurements.active -= 1
        self.underlying.release()


class MeasuredFile:
    def __init__(self, original, measurements):
        self.original, self.measurements = original, measurements

    def __getattr__(self, name):
        return getattr(self.original, name)

    def __enter__(self):
        self.original.__enter__()
        return self

    def __exit__(self, *args):
        return self.original.__exit__(*args)

    def read(self, *args):
        started = time.perf_counter()
        raw = self.original.read(*args)
        self.measurements.add('sourceReadCalls')
        self.measurements.add('sourceReadBytes', len(raw))
        self.measurements.add('sourceReadMs', (time.perf_counter() - started) * 1000)
        return raw


class MeasuredOS:
    """Proxy only server.os; never patch the process-wide os module."""
    def __init__(self, measurements):
        self.measurements = measurements

    def __getattr__(self, name):
        return getattr(os, name)

    def fdopen(self, *args, **kwargs):
        file = os.fdopen(*args, **kwargs)
        # Only do_pdf_preview executes with a per-request measurement record.
        return MeasuredFile(file, self.measurements) if getattr(self.measurements.local, 'record', None) is not None else file


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', type=Path, default=ROOT / 'app')
    parser.add_argument('--label', default='baseline')
    parser.add_argument('--rounds', type=int, default=3, choices=range(1, 6))
    args = parser.parse_args()
    if not args.label or any(char not in 'abcdefghijklmnopqrstuvwxyz0123456789-_' for char in args.label):
        parser.error('label must contain only lowercase letters, digits, dash or underscore')
    source = args.source_dir.resolve()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    destination = OUTPUT / f'pdf-{args.label}.json'
    if destination.exists():
        parser.error(f'Refusing to overwrite existing evidence: {destination.name}')
    report = {'scope': 'production Python HTTP handler, not native WKWebView or whole-app memory/FPS',
              'label': args.label, 'modelCalls': 0, 'externalConnections': 0,
              'formalWorkspaceAccessed': False, 'rounds': args.rounds, 'samples': [], 'safety': [],
              'limitations': ['Instrumented handlers include timing-wrapper overhead.',
                              'OS page cache is not purged; no physical-disk-read claim.',
                              'RSS peak includes fixture generation and the in-process HTTP client.',
                              'Small synthetic PDF does not prove 64 MiB source or 390-page user workload performance.',
                              'No retained-memory or native rendering conclusion is inferred from backend timings.']}
    server_instance = worker = None
    try:
        with tempfile.TemporaryDirectory(prefix='aibro-pdf-performance-') as temporary:
            data = Path(temporary)
            for folder in ('files', 'home', 'codex-home'):
                (data / folder).mkdir()
            environment = {'AI_WORKSTATION_DATA_DIR': str(data), 'AI_WORKSTATION_ASSET_DIR': str(source),
                           'AI_WORKSTATION_PORT': '0', 'AI_WORKSTATION_CODEX_RUNTIME_SMOKE': '0',
                           'HOME': str(data / 'home'), 'CODEX_HOME': str(data / 'codex-home'),
                           'PYTHONDONTWRITEBYTECODE': '1'}
            with patch.dict(os.environ, environment):
                sys.dont_write_bytecode = True
                sys.path.insert(0, str(source))
                server = importlib.import_module('server')
                import fitz
                assert server.DATA_DIR == data and server.STORE.directory == data
                original, expected = make_pdf(fitz)
                alternate, alternate_expected = make_pdf(fitz, 2, marker='B', image=False)
                # Independently generated PDFs may differ in internal object
                # lengths. Change only an equal-length hex-encoded literal in
                # this uncompressed synthetic source, preserving xref offsets.
                old_literal = b'466978747572652042'
                assert alternate.count(old_literal) == 2
                same_length = alternate.replace(old_literal, b'466978747572652043')
                same_length_expected = [text.replace('Fixture B /', 'Fixture C /') for text in alternate_expected]
                with fitz.open(stream=alternate, filetype='pdf') as document:
                    restricted = document.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256,
                        owner_pw='synthetic-fixture-owner', user_pw='', permissions=fitz.PDF_PERM_PRINT)
                fixture = data / 'files/fixture-pdf'
                fixture.write_bytes(original)
                (data / 'files/alternate-pdf').write_bytes(alternate)
                original_hash = sha(original)
                report.update(sourceDir=str(source), sourceHash=sha((source / 'server.py').read_bytes()),
                              assetFingerprint=server.ASSET_FINGERPRINT, python=sys.version.split()[0],
                              pymupdf=fitz.VersionBind, fixture={'pages': 100, 'bytes': len(original),
                              'sha256': original_hash, 'extractedChars': sum(map(len, expected)),
                              'sharedImageBytes': 512 * 512 * 3}, peakRssKiBBefore=rss_kib())
                meter = Measurements()

                class Handler(server.Handler):
                    def log_message(self, *_):
                        pass

                    def do_pdf_preview(self, *a, **kw):
                        meter.begin(self.headers.get('X-PDF-Benchmark-Id', 'missing-id'))
                        started, cpu = time.perf_counter(), time.thread_time()
                        try:
                            return super().do_pdf_preview(*a, **kw)
                        finally:
                            meter.finish(started, cpu)

                server_instance = server.LoopbackHTTPServer(('127.0.0.1', 0), Handler)
                server.PORT = server_instance.server_port
                origin = f'http://127.0.0.1:{server.PORT}'
                worker = threading.Thread(target=server_instance.serve_forever, daemon=True)
                worker.start()
                sequence, sequence_lock = 0, threading.Lock()

                def request(kind, page=1, phase='sequential', round_number=0, identifier='fixture-pdf', expected_status=200):
                    nonlocal sequence
                    with sequence_lock:
                        sequence += 1
                        request_id = f'pdf-{sequence}'
                    endpoints = {'info': 'preview-info', 'text': 'preview-text', 'read-text': 'read-text',
                                 'search': 'preview-search', 'page': 'preview'}
                    query = {'page': page}
                    if kind == 'page':
                        query.update(scale=1.5, format='jpeg', fit=1)
                    if kind == 'search':
                        query['q'] = 'alpha evidence'
                    url = origin + f'/__files/{identifier}/{endpoints[kind]}?' + urllib.parse.urlencode(query)
                    start = time.perf_counter()
                    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                    req = urllib.request.Request(url, headers={'X-PDF-Benchmark-Id': request_id, 'Origin': origin})
                    try:
                        response = opener.open(req, timeout=20)
                    except urllib.error.HTTPError as error:
                        response = error
                    with response:
                        body, status, content_type = response.read(), response.status, response.headers.get('Content-Type', '')
                    elapsed = (time.perf_counter() - start) * 1000
                    assert status == expected_status, (phase, kind, page, status, expected_status)
                    deadline = time.monotonic() + 2
                    while request_id not in meter.records:
                        if time.monotonic() > deadline:
                            raise AssertionError('Handler measurement did not finish')
                        time.sleep(.001)
                    sample = {**meter.records[request_id], 'phase': phase, 'round': round_number,
                              'kind': kind, 'page': page, 'status': status, 'httpMs': elapsed,
                              'responseBytes': len(body), 'responseSha256': sha(body)}
                    with meter.mutex:
                        report['samples'].append(sample)
                    if status != 200:
                        assert str(data).encode() not in body
                        return sample, json.loads(body)
                    if kind == 'page':
                        assert content_type == 'image/jpeg' and body[:2] == b'\xff\xd8' and body[-2:] == b'\xff\xd9'
                        return sample, None
                    return sample, json.loads(body)

                native_open = fitz.open

                def measured_open(*a, **kw):
                    started = time.perf_counter()
                    try:
                        return native_open(*a, **kw)
                    finally:
                        if getattr(meter.local, 'record', None) is not None:
                            meter.add('documentOpenCalls')
                            meter.add('documentOpenMs', (time.perf_counter() - started) * 1000)

                # No outgoing HTTP is used. Reject any accidental socket connect
                # other than the isolated server before it reaches the network.
                socket_connect = socket.socket.connect

                def local_connect(sock, address):
                    if not (isinstance(address, tuple) and address[0] == '127.0.0.1' and address[1] == server.PORT):
                        report['externalConnections'] += 1
                        raise AssertionError('Unexpected non-fixture socket connection')
                    return socket_connect(sock, address)

                with patch.object(server, 'os', MeasuredOS(meter)), patch.object(fitz, 'open', measured_open), \
                     patch.object(server, 'PDF_PREVIEW_LOCK', MeasuredLock(server.PDF_PREVIEW_LOCK, meter)), \
                     patch.object(socket.socket, 'connect', local_connect):
                    pages = [1, 2, 15, 25, 50, 75, 99, 100]
                    for round_number in range(args.rounds):
                        _, info = request('info', round_number=round_number)
                        assert info['pageCount'] == 100
                        for page in (pages if round_number % 2 == 0 else list(reversed(pages))):
                            order = ('text', 'read-text', 'search', 'page') if round_number % 2 == 0 else ('page', 'search', 'read-text', 'text')
                            for kind in order:
                                _, value = request(kind, page, round_number=round_number)
                                if kind == 'read-text':
                                    assert value['text'] == expected[page - 1] and value['nextOffset'] is None
                                elif kind == 'search':
                                    assert len(value['matches']) == 32 and not value['truncated']
                                elif kind == 'text':
                                    assert value['words'] and not value['truncated'] and value['page'] == page
                    print('Sequential rounds complete', flush=True)
                    for page in range(1, 101):
                        _, value = request('read-text', page, phase='complete-text-scan')
                        assert value['text'] == expected[page - 1]
                    print('Complete 100-page text scan verified', flush=True)
                    for round_number in range(2):
                        start_race = threading.Barrier(2)
                        def background():
                            start_race.wait(timeout=5)
                            for page in range(1, 21):
                                request('search', page, phase='concurrent-search', round_number=round_number)
                        def foreground():
                            start_race.wait(timeout=5)
                            for page in (1, 15, 25, 50, 75, 100, 50, 25, 15, 1):
                                request('page', page, phase='concurrent-foreground', round_number=round_number)
                        with ThreadPoolExecutor(max_workers=2) as pool:
                            jobs = [pool.submit(background), pool.submit(foreground)]
                            for job in jobs:
                                job.result(timeout=60)
                    assert meter.maximum_active == 1
                    report['maximumConcurrentPdfCriticalSections'] = meter.maximum_active
                    assert sha(fixture.read_bytes()) == original_hash
                    report['sourcePreservedAfterMeasuredWorkload'] = True

                    # Post-warm safety is deliberately outside timing summaries.
                    replacement = fixture.with_name('replacement')
                    replacement.write_bytes(alternate)
                    os.replace(replacement, fixture)
                    _, value = request('read-text', phase='safety')
                    assert value['text'] == alternate_expected[0] and value['pageCount'] == 2
                    report['safety'].append('atomic same-ID replacement returns new bytes/page count')
                    metadata = fixture.stat()
                    fixture.write_bytes(same_length)
                    os.utime(fixture, ns=(metadata.st_atime_ns, metadata.st_mtime_ns))
                    assert fixture.stat().st_ino == metadata.st_ino and fixture.stat().st_size == metadata.st_size
                    _, value = request('read-text', phase='safety')
                    assert value['text'] == same_length_expected[0]
                    report['safety'].append('same-inode same-size overwrite with restored mtime returns new text')
                    fixture.write_bytes(restricted)
                    _, value = request('read-text', phase='safety', expected_status=403)
                    assert value['code'] == 'PDF_COPY_RESTRICTED'
                    report['safety'].append('warm same-ID replacement enforces new copy permission')
                    fixture.unlink()
                    sample, _ = request('info', phase='safety', expected_status=404)
                    assert sample['sourceReadBytes'] == sample['documentOpenCalls'] == 0
                    report['safety'].append('deleted warm source is 404 without stale read/open')
                    fixture.symlink_to(data / 'files/alternate-pdf')
                    request('info', phase='safety', expected_status=400)
                    fixture.unlink()
                    report['safety'].append('warm source replaced by symlink is rejected')
                    fixture.write_bytes(original)
                    for identifier, count in [('fixture-pdf', 100), ('alternate-pdf', 2), ('fixture-pdf', 100)]:
                        _, value = request('info', phase='safety', identifier=identifier)
                        assert value['pageCount'] == count
                    report['safety'].append('alternating document IDs retains correct identity')
                    with fixture.open('wb') as stream:
                        stream.truncate(server.MAX_FILE + 1)
                    sample, _ = request('info', phase='safety', expected_status=400)
                    assert sample['sourceReadBytes'] == sample['documentOpenCalls'] == 0
                    report['safety'].append('oversized source rejected before read/open')
                    fixture.write_bytes(original)
                    assert sha(fixture.read_bytes()) == original_hash
                    report['sourceRestoredAfterSafetyProbes'] = True

                server_instance.shutdown()
                server_instance.server_close()
                worker.join(timeout=5)
                assert not worker.is_alive()
                server_instance = worker = None
                groups = defaultdict(list)
                for sample in report['samples']:
                    if sample['phase'] != 'safety':
                        groups[(sample['phase'], sample['kind'])].append(sample)
                fields = ('httpMs', 'handlerMs', 'handlerCpuMs', 'sourceReadMs', 'documentOpenMs', 'lockWaitMs', 'lockHeldMs')
                report['groups'] = [{'phase': phase, 'kind': kind, 'requests': len(samples),
                    'sourceReadCalls': sum(item['sourceReadCalls'] for item in samples),
                    'sourceReadBytes': sum(item['sourceReadBytes'] for item in samples),
                    'documentOpenCalls': sum(item['documentOpenCalls'] for item in samples),
                    **{field: summary([item[field] for item in samples]) for field in fields}}
                    for (phase, kind), samples in groups.items()]
                report.update(peakRssKiBAfter=rss_kib(), passed=True,
                              sourceHashAfter=sha((source / 'server.py').read_bytes()))
                assert report['sourceHashAfter'] == report['sourceHash'], 'Production source changed during measurement'
        report['temporaryWorkspaceRemoved'] = not data.exists()
    except BaseException as error:
        report.update(passed=False, failure=f'{type(error).__name__}: {error}')
        raise
    finally:
        if server_instance is not None:
            server_instance.shutdown()
            server_instance.server_close()
        if worker is not None:
            worker.join(timeout=5)
        report['samples'].sort(key=lambda item: int(item['id'].split('-')[1]))
        destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(f'PDF baseline evidence: {destination}', flush=True)


if __name__ == '__main__':
    main()
