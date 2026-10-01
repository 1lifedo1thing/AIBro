"""Current-page text layer: real PDFs, pixel alignment, permissions and bounded output."""
import ast
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
import urllib.error
import urllib.request
import fitz
from http_test_support import python_http_service

ROOT = Path(__file__).resolve().parents[1] / 'app'

def response(origin, suffix):
    try:
        result = urllib.request.urlopen(origin + suffix, timeout=10)
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()
    with result:
        return result.status, result.headers, result.read()

def corners(word):
    angle = math.radians(word['angle']); c, s = math.cos(angle), math.sin(angle)
    return [(word['x'] + x*c-y*s, word['y'] + x*s+y*c)
            for x, y in ((0,0),(word['width'],0),(word['width'],word['height']),(0,word['height']))]

with tempfile.TemporaryDirectory(prefix='workstation-pdf-text-') as temporary:
    data=Path(temporary);files=data/'files';files.mkdir();original_words={}
    with fitz.open() as document:
        for angle in (0,90,180,270):
            page=document.new_page(width=400,height=300)
            page.insert_text((100,100),f'Rotation{angle} selectable',fontsize=16)
            page.insert_text((100,135),'Next line',fontsize=16)
            page.insert_text((5,15),'OUTSIDE_CROP',fontsize=8)
            page.set_cropbox(fitz.Rect(50,30,350,230));page.set_rotation(angle)
            original_words[angle]=page.get_text('words')
        (files/'rotated').write_bytes(document.tobytes())
    with fitz.open() as document:
        page=document.new_page(width=300,height=200)
        page.insert_text((30,40),'Allowed horizontal',fontsize=12)
        page.insert_text((150,150),'ROTATED',rotate=90,fontsize=12)
        (files/'mixed').write_bytes(document.tobytes())
    with fitz.open() as document:
        page=document.new_page(width=300,height=200)
        page.insert_text((150,150),'ROTATED',rotate=90,fontsize=12)
        (files/'vertical-only').write_bytes(document.tobytes())
    with fitz.open() as document:
        image_page=document.new_page(width=300,height=200)
        image_page.insert_text((30,40),'Raster text is not extractable')
        raster=image_page.get_pixmap().tobytes('png')
    with fitz.open() as document:
        document.new_page(width=300,height=200).insert_image(fitz.Rect(0,0,300,200),stream=raster)
        document.new_page(width=300,height=200)
        (files/'scan').write_bytes(document.tobytes())
    with fitz.open() as document:
        document.new_page(width=300,height=200).insert_text((30,40),'Do not copy')
        (files/'restricted').write_bytes(document.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256,owner_pw='fixture-owner',user_pw='',permissions=fitz.PDF_PERM_PRINT))
        (files/'encrypted').write_bytes(document.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256,owner_pw='fixture-owner',user_pw='fixture-user'))
    with fitz.open() as document:
        page=document.new_page(width=1000,height=1000)
        for row in range(120):page.insert_text((10,10+row*6),' '.join(['word']*50),fontsize=2)
        (files/'dense').write_bytes(document.tobytes())
    (files/'not-pdf').write_bytes(raster)
    (files/'corrupt').write_bytes(b'%PDF broken')
    (data/'outside.pdf').write_bytes((files/'rotated').read_bytes())
    (files/'linked').symlink_to(data/'outside.pdf')
    with (files/'oversized').open('wb') as stream:stream.truncate(64*1024*1024+1)
    (files/'rotated.meta.json').write_text(json.dumps({'name':'Synthetic original.pdf','mimeType':'application/pdf'}))
    before={file.name:hashlib.sha256(file.read_bytes()).digest() for file in files.iterdir() if not file.is_symlink()}
    checks=0
    with python_http_service(ROOT/'server.py',cwd=data,env={**os.environ,'AI_WORKSTATION_PORT':'0','AI_WORKSTATION_DATA_DIR':str(data),'AI_WORKSTATION_ASSET_DIR':str(ROOT)}) as origin:
        for page_number,angle in enumerate((0,90,180,270),1):
            status,headers,body=response(origin,f'/__files/rotated/preview-text?page={page_number}')
            assert status==200,(status,body);payload=json.loads(body)
            assert headers['Cache-Control']=='no-store' and headers['Content-Type'].startswith('application/json')
            assert payload['page']==page_number and payload['pageCount']==4 and payload['rotation']==angle
            assert (payload['width'],payload['height'])==((300,200) if angle%180==0 else (200,300))
            assert not payload['partial'] and not payload['truncated']
            assert [w['text'] for w in payload['words']]==[w[4] for w in original_words[angle]]
            assert 'OUTSIDE_CROP' not in body.decode() and len(payload['words'])==4
            assert payload['words'][0]['line']==payload['words'][1]['line']
            assert payload['words'][0]['line']!=payload['words'][2]['line']
            image=fitz.Pixmap(response(origin,f'/__files/rotated/preview?page={page_number}&scale=2')[2])
            assert (image.width,image.height)==(int(payload['width']*2),int(payload['height']*2))
            for word,original in zip(payload['words'],original_words[angle]):
                x0,y0,x1,y1,*_=original
                expected={0:(x0,y0),90:(200-y0,x0),180:(300-x0,200-y0),270:(y0,300-x0)}[angle]
                assert abs(word['x']-expected[0])<0.001 and abs(word['y']-expected[1])<0.001
                assert abs(word['width']-(x1-x0))<0.001 and abs(word['height']-(y1-y0))<0.001
                quad=corners(word);xs=[point[0] for point in quad];ys=[point[1] for point in quad]
                assert min(xs)>-0.001 and min(ys)>-0.001 and max(xs)<=payload['width']+0.001 and max(ys)<=payload['height']+0.001
                left,top=max(0,int(min(xs)*2)),max(0,int(min(ys)*2));right,bottom=min(image.width,math.ceil(max(xs)*2)),min(image.height,math.ceil(max(ys)*2))
                ink=sum(min(image.pixel(x,y))<200 for y in range(top,bottom) for x in range(left,right))
                assert ink>20,(angle,word,ink) # actual PDF ink beneath every CSS-oriented word rectangle
            checks+=1
        for page in (1,2):
            status,_,body=response(origin,f'/__files/scan/preview-text?page={page}');payload=json.loads(body)
            assert status==200 and payload['words']==[] and payload['partial'] is False and payload['truncated'] is False
            checks+=1
        for identifier,expected in [('mixed',['Allowed','horizontal']),('vertical-only',[])]:
            status,_,body=response(origin,f'/__files/{identifier}/preview-text');payload=json.loads(body)
            assert status==200 and payload['partial'] and payload['code']=='PDF_TEXT_PARTIAL'
            assert [word['text'] for word in payload['words']]==expected and 'ROTATED' not in body.decode()
            checks+=1
        status,_,body=response(origin,'/__files/restricted/preview-text')
        assert status==403 and json.loads(body)['code']=='PDF_COPY_RESTRICTED' and 'Do not copy' not in body.decode()
        assert response(origin,'/__files/restricted/preview')[0]==200;checks+=1
        status,_,body=response(origin,'/__files/dense/preview-text');payload=json.loads(body)
        assert status==200 and payload['truncated'] and len(payload['words'])==5000 and len(body)<1024*1024
        assert payload['code']=='PDF_TEXT_TRUNCATED';checks+=1
        for suffix,status in [('?page=0',404),('?page=5',404),('?page=-1',400),('?page=1.2',400),('?page=',400),('?page=1&page=2',400),('?page=one',400)]:
            assert response(origin,'/__files/rotated/preview-text'+suffix)[0]==status;checks+=1
        for identifier,status in [('missing',404),('bad%2Fid',400),('%2e%2e',400),('linked',400),('oversized',400),('encrypted',400),('corrupt',400),('not-pdf',400)]:
            actual,_,body=response(origin,f'/__files/{identifier}/preview-text')
            assert actual==status,(identifier,actual,body)
            assert str(data).encode() not in body;checks+=1
        # Shared source checks also protect the raster entry point.
        for identifier in ('linked','oversized'):
            assert response(origin,f'/__files/{identifier}/preview')[0]==400;checks+=1
        files.rename(data/'real-files');files.symlink_to(data/'real-files',target_is_directory=True)
        try: assert response(origin,'/__files/rotated/preview-text')[0]==400
        finally: files.unlink();(data/'real-files').rename(files)
        checks+=1
    after={file.name:hashlib.sha256(file.read_bytes()).digest() for file in files.iterdir() if not file.is_symlink()}
    assert before==after,'No PDF or metadata byte may change';checks+=1

# Exercise output limits without constructing an unrealistic 256 KB-wide PDF word.
# This executes the exact production helper, without importing the live server/store.
source=ast.parse((ROOT/'server.py').read_text())
selected=[node for node in source.body if isinstance(node,ast.FunctionDef) and node.name=='pdf_preview_text' or isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id.startswith('MAX_PDF_TEXT_') for target in node.targets)]
namespace={'math':math,'json':json};exec(compile(ast.Module(body=selected,type_ignores=[]),'server.py','exec'),namespace)
class TextPage:
    def extractDICT(self):return {'blocks':[{'number':0,'type':0,'lines':[{'dir':(1,0),'wmode':0}]}]}
    def extractWORDS(self):return [(1,1,10,10,'汉'*(100*1024),0,0,0)]
class Page:
    number=0;rotation=0;rotation_matrix=fitz.Matrix(1,1);cropbox=fitz.Rect(0,0,100,100);rect=cropbox
    parent=type('Document',(),{'page_count':1})()
    def get_textpage(self,flags):return TextPage()
limited=namespace['pdf_preview_text'](Page(),fitz)
assert limited['truncated'] and limited['words']==[];checks+=1
print(f'PDF text layer: {checks} checks passed (real pages, 4 rotations/crop, raster alignment, scans, restricted copy, limits, paths, bytes unchanged)')
