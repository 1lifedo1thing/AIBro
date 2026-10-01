"""Literal current-page PDF search groups phrases and reports word-precision geometry."""
import ast
import hashlib
import math
import re
import select
import socket
import stat
import unicodedata
from types import SimpleNamespace
from unittest.mock import patch
import json
import os
from pathlib import Path
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import fitz
from http_test_support import python_http_service
ROOT=Path(__file__).resolve().parents[1]/'app'
def request(origin,url):
    try:r=urllib.request.urlopen(origin+url,timeout=10)
    except urllib.error.HTTPError as error:return error.code,error.headers,error.read()
    with r:return r.status,r.headers,r.read()
def find(origin,identifier,query,page=1):
    status,headers,body=request(origin,f'/__files/{identifier}/preview-search?'+urllib.parse.urlencode({'q':query,'page':page}))
    assert status==200,(identifier,query,status,body)
    assert headers['Cache-Control']=='no-store' and len(body)<=1024*1024
    return json.loads(body)
with tempfile.TemporaryDirectory(prefix='pdf-search-fixture-') as temp:
    directory=Path(temp);files=directory/'files';files.mkdir();checks=0
    with fitz.open() as pdf:
        page=pdf.new_page(width=600,height=800)
        page.insert_text((50,70),'ALPHA beta\nGamma delta',fontsize=15)
        page.insert_text((50,150),'Repeat repeat REPEAT banana',fontsize=15)
        page.insert_text((50,200),'Straße CAFÉ',fontsize=15)
        page.insert_text((50,250),'ＡＩ 学习 神经网络',fontname='china-s',fontsize=15)
        page.insert_text((50,320),'深度\n学习',fontname='china-s',fontsize=15)
        page.insert_text((50,420),'神经网络 学习',fontname='china-s',fontsize=15)
        pdf.new_page(width=600,height=800).insert_text((50,70),'ONLY_PAGE_TWO',fontsize=15)
        (files/'literal').write_bytes(pdf.tobytes())
    with fitz.open() as pdf:
        for angle in (0,90,180,270):
            page=pdf.new_page(width=400,height=300);page.insert_text((100,100),'Cropped Phrase',fontsize=15)
            page.set_cropbox(fitz.Rect(50,30,350,230));page.set_rotation(angle)
        (files/'rotated').write_bytes(pdf.tobytes())
    with fitz.open() as pdf:
        page=pdf.new_page(width=300,height=400)
        page.insert_text((40,50),'Start',fontsize=14)
        page.insert_text((150,150),'OMITTED',rotate=90,fontsize=14)
        page.insert_text((40,200),'End',fontsize=14)
        (files/'partial').write_bytes(pdf.tobytes())
    with fitz.open() as pdf:
        page=pdf.new_page(width=300,height=400);page.insert_text((150,150),'ONLY_ROTATED',rotate=90,fontsize=14)
        (files/'unsupported').write_bytes(pdf.tobytes())
        pixmap=page.get_pixmap().tobytes('png')
    with fitz.open() as pdf:
        pdf.new_page(width=300,height=400).insert_image(fitz.Rect(0,0,300,400),stream=pixmap)
        pdf.new_page(width=300,height=400)
        (files/'scan').write_bytes(pdf.tobytes())
    with fitz.open() as pdf:
        pdf.new_page(width=300,height=400).insert_text((30,50),'Secret text')
        (files/'restricted').write_bytes(pdf.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256,user_pw='',owner_pw='synthetic-owner',permissions=fitz.PDF_PERM_PRINT))
        (files/'encrypted').write_bytes(pdf.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256,user_pw='synthetic-user',owner_pw='synthetic-owner'))
    with fitz.open() as pdf:
        page=pdf.new_page(width=1000,height=1000)
        for row in range(120):page.insert_text((10,10+row*6),' '.join(['repeat']*50),fontsize=2)
        (files/'dense').write_bytes(pdf.tobytes())
    (files/'broken').write_bytes(b'%PDF bad')
    (directory/'outside').write_bytes((files/'literal').read_bytes());(files/'linked').symlink_to(directory/'outside')
    with (files/'oversized').open('wb') as file:file.truncate(64*1024*1024+1)
    (files/'literal.meta.json').write_text(json.dumps({'name':'Synthetic literal.pdf','mimeType':'application/pdf'}))
    before={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in files.iterdir() if not p.is_symlink()}
    with python_http_service(ROOT/'server.py',cwd=directory,env={**os.environ,'AI_WORKSTATION_PORT':'0','AI_WORKSTATION_DATA_DIR':str(directory),'AI_WORKSTATION_ASSET_DIR':str(ROOT)}) as origin:
        for query,count in [('alpha',1),('ALPHA BETA',1),('beta\n   gamma',1),('repeat',3),('ana',1),('STRASSE',1),('cafe\u0301',1),('AI',1),('神经网络',2),('深度学习',1),('神经网络 学习',1),('ONLY_PAGE_TWO',0),('delta repeat',0),('.*',0)]:
            result=find(origin,'literal',query)
            assert len(result['matches'])==count,(query,result)
            assert not result['partial'] and not result['truncated'] and not result['unsearchable']
            assert all(hit['precision']=='word' for hit in result['matches'])
            assert 'words' not in result and 'text' not in result
            assert [hit['index'] for hit in result['matches']]==list(range(count));checks+=1
        result=find(origin,'literal','beta gamma');hit=result['matches'][0]
        assert len(hit['rects'])==2 and hit['rects'][0]['line']!=hit['rects'][1]['line'];checks+=1
        result=find(origin,'literal','banana');whole=result['matches'][0]['rects']
        assert find(origin,'literal','ana')['matches'][0]['rects']==whole,'In-word match explicitly has whole-word geometry';checks+=1
        assert len(find(origin,'literal','ONLY_PAGE_TWO',2)['matches'])==1;checks+=1
        first=find(origin,'literal','repeat');second=find(origin,'literal','repeat');assert first==second;checks+=1
        for page,angle in enumerate((0,90,180,270),1):
            found=find(origin,'rotated','cropped phrase',page)
            status,_,raw=request(origin,f'/__files/rotated/preview-text?page={page}');text=json.loads(raw)
            assert status==200 and found['rotation']==angle and len(found['matches'])==1 and len(found['matches'][0]['rects'])==2
            assert (found['width'],found['height'])==(text['width'],text['height'])
            for rect,word in zip(found['matches'][0]['rects'],text['words']):
                assert rect=={key:word[key] for key in ('x','y','width','height','angle','line')}
            checks+=1
        result=find(origin,'partial','start end')
        assert result['partial'] and not result['matches'],'Never invent a phrase across omitted text'
        assert len(find(origin,'partial','start')['matches'])==1;checks+=1
        result=find(origin,'unsupported','only')
        assert result['partial'] and result['unsearchable'] and not result['matches'];checks+=1
        for page in (1,2):
            result=find(origin,'scan','text',page);assert result['unsearchable'] and not result['matches'] and not result['partial'];checks+=1
        result=find(origin,'dense','repeat');assert len(result['matches'])==200 and result['truncated'] and result['code']=='PDF_SEARCH_TRUNCATED';checks+=1
        for identifier,status in [('restricted',403),('encrypted',400),('broken',400),('linked',400),('oversized',400),('missing',404),('bad%2Fid',400),('%2e%2e',400)]:
            actual,_,body=request(origin,f'/__files/{identifier}/preview-search?q=text');assert actual==status,(identifier,actual,body)
            assert str(directory).encode() not in body
            if identifier=='restricted':assert json.loads(body)['code']=='PDF_COPY_RESTRICTED'
            checks+=1
        assert request(origin,'/__files/restricted/preview')[0]==200;checks+=1
        for query,status in [('q=x&page=0',404),('q=x&page=3',404),('q=x&page=-1',400),('q=x&page=1&page=2',400),('q=x&q=y',400),('q=',400),('',400),('q=%20%09%0A',400),('q=%00',400),('q=%FF',400),('q='+('x'*257),400),('q='+urllib.parse.quote('ﷺ'*20),400)]:
            actual,_,body=request(origin,'/__files/literal/preview-search?'+query);assert actual==status,(query,actual,body);checks+=1
        files.rename(directory/'real-files');files.symlink_to(directory/'real-files',target_is_directory=True)
        try:assert request(origin,'/__files/literal/preview-search?q=alpha')[0]==400
        finally:files.unlink();(directory/'real-files').rename(files)
        checks+=1
    after={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in files.iterdir() if not p.is_symlink()}
    assert before==after,'Search must not modify source PDFs or metadata';checks+=1
# Execute the production handler against a disconnected synthetic socket after
# lock acquisition. It must not open / parse the PDF or start another page job.
server_ast=ast.parse((ROOT/'server.py').read_text())
helpers=[node for node in server_ast.body if isinstance(node,ast.FunctionDef) and node.name=='pdf_search_query']
handler=next(node for node in ast.walk(server_ast) if isinstance(node,ast.FunctionDef) and node.name=='do_pdf_preview')
with tempfile.TemporaryDirectory(prefix='pdf-search-cancel-') as temporary:
    original=Path(temporary)/'cancelled';original.write_bytes(b'synthetic bytes that must not be read')
    connection,peer=socket.socketpair();responses=[]
    class Lock:
        def __enter__(self):peer.close()
        def __exit__(self,*args):return False
    namespace={**globals(),'STORE':SimpleNamespace(file_path=lambda _:original),'PDF_PREVIEW_LOCK':Lock()}
    exec(compile(ast.Module(body=[*helpers,handler],type_ignores=[]),'server.py','exec'),namespace)
    with patch.object(fitz,'open',side_effect=AssertionError('Cancelled search must not open PDF')) as opened:
        try:namespace['do_pdf_preview'](SimpleNamespace(path='/__files/cancelled/preview-search?q=test',connection=connection,send_json=lambda *args:responses.append(args)),'cancelled',search=True)
        finally:connection.close();peer.close()
        assert not opened.called and responses==[],responses
    checks+=1
print(f'PDF search: {checks} checks passed (literal Unicode/phrases, one-page scope, grouped word geometry, crop/rotation, limits, permissions, invalid requests, original bytes unchanged)')
