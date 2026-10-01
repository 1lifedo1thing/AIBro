"""Per-block review against real files, durable journals and same-origin HTTP."""
import hashlib, json, os, tempfile, urllib.request, urllib.error
from pathlib import Path
from local_projects import LocalProjects, LocalProjectError
from local_file_edits import LocalFileEdits
from http_test_support import python_http_service

def rejected(fn,status=409):
    try: fn()
    except LocalProjectError as exc: assert exc.status==status,(exc.status,str(exc))
    else: raise AssertionError('Unsafe action was accepted')

with tempfile.TemporaryDirectory(prefix='aibro-hunks-') as temp:
    base=Path(temp); project=base/'project'; project.mkdir()
    projects=LocalProjects(base/'store'); cid=projects.connect(str(project))['candidate']['id']; service=LocalFileEdits(projects)
    before=b'\xef\xbb\xbfalpha\r\nkeep one\r\nbeta\r\nkeep two\r\ngamma\r\n'; after='ALPHA\nkeep one\nBETA\nkeep two\nGAMMA\n'
    file=project/'plan.md'; file.write_bytes(before); file.chmod(0o640)
    def propose(path='plan.md',content=after,operation='update'):
        target=project/path
        entry=service.propose(dict(candidateId=cid,projectId='p',runId='r',path=path,operation=operation,content=content,version=service.digest(target.read_bytes()) if target.exists() else None))
        return service.access(entry['id'])
    def decide(entry,index,action):
        return service.access(entry['id'],action,dict(hunkId=entry['hunks'][index]['id'],reviewRevision=entry['reviewRevision']))
    entry=propose(); assert len(entry['hunks'])==3
    assert [(h['oldStart'],h['newStart'],h['oldCount'],h['newCount']) for h in entry['hunks']]==[(1,1,1,1),(3,3,1,1),(5,5,1,1)]
    first=decide(entry,1,'accept-hunk'); assert file.read_bytes()==before.replace(b'beta',b'BETA'); assert first['status']=='partial'; assert [h['status'] for h in first['hunks']]==['pending','accepted','pending']
    rejected(lambda:decide(entry,0,'accept-hunk')); assert file.read_bytes()==before.replace(b'beta',b'BETA')
    first=decide(first,0,'reject-hunk'); assert file.read_bytes()==before.replace(b'beta',b'BETA'); assert first['status']=='partial'
    service=LocalFileEdits(LocalProjects(base/'store')); first=service.access(first['id']); assert first['hunks'][0]['status']=='rejected'
    complete=service.access(first['id'],'apply'); assert file.read_bytes()==before.replace(b'beta',b'BETA').replace(b'gamma',b'GAMMA'); assert complete['status']=='applied'; assert file.stat().st_mode&0o777==0o640
    saved=file.read_bytes(); file.write_bytes(saved+b'user edit\r\n'); rejected(lambda:decide(complete,1,'undo-hunk')); rejected(lambda:service.access(complete['id'],'undo')); assert file.read_bytes()==saved+b'user edit\r\n'
    file.write_bytes(saved); partial=decide(complete,1,'undo-hunk'); assert file.read_bytes()==before.replace(b'gamma',b'GAMMA'); assert partial['hunks'][1]['status']=='pending'
    undone=service.access(partial['id'],'undo'); assert file.read_bytes()==before; assert undone['status']=='partial'; assert undone['hunks'][1]['status']=='pending'
    finished=service.access(undone['id'],'dismiss'); assert finished['status']=='dismissed'; assert file.read_bytes()==before
    # External edits block accepting or rejecting a stale hunk, without losing decisions.
    stale=propose(); file.write_text('manual'); rejected(lambda:decide(stale,0,'accept-hunk')); rejected(lambda:decide(stale,0,'reject-hunk')); assert file.read_text()=='manual'; file.write_bytes(before)
    # Empty creation is distinguishable from a no-op, and undo removes just that created file.
    created=propose('empty.txt','','create'); assert len(created['hunks'])==1 and not (project/'empty.txt').exists()
    created=decide(created,0,'accept-hunk'); assert (project/'empty.txt').read_bytes()==b''
    created=decide(created,0,'undo-hunk'); assert not (project/'empty.txt').exists(); assert created['status']=='pending'
    created=decide(created,0,'reject-hunk'); assert not (project/'empty.txt').exists(); assert created['status']=='dismissed'
    # Deleting all text keeps the file (a content update is not a filesystem delete).
    deleted=propose(content=''); assert deleted['hunks'][0]['oldCount']==5 and deleted['hunks'][0]['newCount']==0
    deleted=decide(deleted,0,'accept-hunk'); assert file.read_bytes()==b'\xef\xbb\xbf'; service.access(deleted['id'],'undo'); assert file.read_bytes()==before
    # EOF with and without a newline, insertion and removal preserve exact bytes.
    file.write_bytes(b'one\nkeep\nlast'); edge=propose(content='start\none\nkeep\nlast\n'); assert len(edge['hunks'])==2
    edge=decide(edge,1,'accept-hunk'); assert file.read_bytes()==b'one\nkeep\nlast\n'
    edge=decide(edge,0,'accept-hunk'); assert file.read_bytes()==b'start\none\nkeep\nlast\n'; service.access(edge['id'],'undo'); assert file.read_bytes()==b'one\nkeep\nlast'
    # Crash between the physical write and journal completion is reconciled on reload.
    file.write_bytes(before); recovery=propose(); original_save=service._save
    def crash_on_commit(value):
        if value.get('reviewRevision')==1 and not value.get('hunkTransaction'): raise OSError('simulated post-write crash')
        return original_save(value)
    service._save=crash_on_commit
    try: decide(recovery,2,'accept-hunk')
    except (OSError,LocalProjectError): pass
    else: raise AssertionError('crash not injected')
    assert file.read_bytes()==before.replace(b'gamma',b'GAMMA')
    service=LocalFileEdits(LocalProjects(base/'store')); recovered=service.access(recovery['id']); assert recovered['reviewRevision']==1 and recovered['status']=='partial' and recovered['hunks'][2]['status']=='accepted'
    service.access(recovered['id'],'undo'); assert file.read_bytes()==before
    # A staged write that never lands rolls back the journal, never the user's bytes.
    recovery=propose(); original_replace=service._replace
    service._replace=lambda *args:(_ for _ in ()).throw(OSError('simulated before-write crash'))
    try: decide(recovery,0,'accept-hunk')
    except (OSError,LocalProjectError): pass
    service=LocalFileEdits(LocalProjects(base/'store')); recovered=service.access(recovery['id']); assert recovered['status']=='pending' and recovered['reviewRevision']==0
    assert file.read_bytes()==before
    # Distant edits in a long file stay separate; repetitive fallback stays lossless.
    lines=[f'line {i}\n' for i in range(6000)]; long_before=''.join(lines); changed=list(lines)
    for i in (5,2800,5998): changed[i]=f'changed {i}\n'
    file.write_text(long_before); sparse=propose(content=''.join(changed)); assert len(sparse['hunks'])==3
    sparse=decide(sparse,1,'accept-hunk'); selective=list(lines);selective[2800]=changed[2800]; assert file.read_text()==''.join(selective)
    service.access(sparse['id'],'undo'); assert file.read_text()==long_before
    repeated='same\n'*4000; file.write_text(repeated); replacement=('other\n'*4000); dense=propose(content=replacement)
    assert len(dense['hunks'])==1; service.access(dense['id'],'apply');assert file.read_text()==replacement
    service.access(dense['id'],'undo');assert file.read_text()==repeated
    file.write_bytes(before)
    root=Path(__file__).resolve().parents[1]
    with python_http_service(root/'app/server.py',cwd=root/'app',env={**os.environ,'AI_WORKSTATION_DATA_DIR':str(base/'http'),'AI_WORKSTATION_PORT':'0'}) as origin:
        def request(route,payload,source=True):
            headers={'Content-Type':'application/json'}
            if source: headers['Origin']=origin
            req=urllib.request.Request(origin+route,data=json.dumps(payload).encode(),headers=headers,method='POST')
            try:
                with urllib.request.urlopen(req) as response:return response.status,json.load(response)
            except urllib.error.HTTPError as error:return error.code,json.load(error)
        _,connection=request('/__local/roots',{'path':str(project)}); _,entry=request('/__local/edits/propose',dict(candidateId=connection['candidate']['id'],path='plan.md',operation='update',version=service.digest(before),content=after))
        _,entry=request('/__local/edits/get',{'id':entry['id']}); payload=dict(id=entry['id'],hunkId=entry['hunks'][1]['id'],reviewRevision=entry['reviewRevision'])
        for action in ('accept-hunk','reject-hunk','undo-hunk'): assert request('/__local/edits/'+action,payload,False)[0]==403
        code,entry=request('/__local/edits/accept-hunk',payload); assert code==200,entry; assert file.read_bytes()==before.replace(b'beta',b'BETA')
        assert request('/__local/edits/accept-hunk',payload)[0]==409
        assert request('/__local/edits/undo-hunk',{**payload,'reviewRevision':entry['reviewRevision']})[0]==200; assert file.read_bytes()==before
print('PASS: selected hunk only, reject/reload/remaining, stale review CAS, external edit CAS, safe undo, BOM/CRLF/mode, create/empty/delete-text/EOF, crash journals, origin and real HTTP')
