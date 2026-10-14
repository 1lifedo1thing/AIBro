"""Mac atomic-group receipt/resolve tests; all state is disposable SQLite."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app'))
from sync_store import SyncStore, COLLECTIONS, ConflictRevisionError, wire_id


def change(identifier, title=None, kind='notes', version=1, seq=1, deleted=False, data=None):
    return {'seq':seq,'entityType':kind,'entityId':identifier,'version':version,'deleted':deleted,
            'data':None if deleted else data or {'id':identifier,'title':title or identifier,'content':title or identifier}}


def group(identifier='group', start=1, members=None):
    members=copy.deepcopy(members or [change('a','remote-a'),change('b','remote-b')])
    for index,item in enumerate(members): item['seq']=start+index
    return {'type':'atomic-group','groupId':identifier,'firstSeq':start,'lastSeq':start+len(members)-1,'changes':members}


class GroupReceiveTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='aibro-mac-group-'); self.addCleanup(self.temp.cleanup)
        self.store=SyncStore(self.temp.name)
        self.store.capture({**{kind:[] for kind in COLLECTIONS},'folders':{'projects':[],'conversations':[]},'agentRuns':[],'_revision':0})

    def local(self, identifier='a', title='local-a'):
        state=self.store.snapshot(); notes={item['id']:item for item in state['notes']}
        notes[identifier]={'id':identifier,'title':title,'content':title}; state['notes']=list(notes.values())
        self.store.capture(state)

    def notes(self): return {item['id']:item['title'] for item in self.store.snapshot()['notes']}

    def db_state(self):
        with self.store.db() as db:
            return {name:[tuple(row) for row in db.execute('SELECT * FROM '+name+' ORDER BY rowid')]
                    for name in ('entities','outbox','sent','conflicts','incoming_groups','incoming_group_members','meta')}

    def test_clean_group_commits_all_members_and_cursor_once(self):
        published=[]
        result=self.store.apply_changes([group()],2,before_commit=lambda state:published.append(copy.deepcopy(state)))
        self.assertTrue(result['changed']); self.assertEqual(self.notes(),{'a':'remote-a','b':'remote-b'})
        self.assertEqual(self.store.status()['cursor'],2); self.assertEqual(len(published),1)
        self.assertEqual(len(published[0]['notes']),2); self.assertEqual(self.store.conflicts(),[])
        self.local('a','later-local')
        self.store.apply_changes([group()],2)
        self.assertEqual(self.notes()['a'],'later-local'); self.assertEqual(self.store.conflicts(),[])

    def test_any_pending_member_blocks_all_and_reopens_as_one_group(self):
        self.local(); before=self.notes()
        result=self.store.apply_changes([group()],2)
        self.assertFalse(result['changed']); self.assertEqual(self.notes(),before); self.assertEqual(self.store.pending(),[])
        self.store=SyncStore(self.temp.name)
        conflicts=self.store.conflicts(); self.assertEqual(len(conflicts),1)
        row=conflicts[0]; self.assertEqual(row['groupId'],'group'); self.assertEqual(row['memberCount'],2)
        self.assertEqual({item['entityId'] for item in row['groupMembers']},{'a','b'})
        self.assertEqual(row['groupMembers'][1]['local'],None)
        self.assertEqual(self.store.status()['cursor'],2)
        with self.assertRaisesRegex(ValueError,'不能逐项'): self.store.resolve_conflict(row['id'],'local',row['revision'])
        # Any member id resolves the same complete, reviewed component.
        result=self.store.resolve_conflict(row['groupMembers'][-1]['id'],'remote',row['revision'])
        self.assertTrue(result['changed']); self.assertEqual(self.notes(),{'a':'remote-a','b':'remote-b'})
        self.assertEqual(self.store.conflicts(),[]); self.assertEqual(self.store.pending(),[])

    def test_sent_only_member_also_blocks_group(self):
        self.local(); sent=self.store.pending()
        with self.store.db() as db: db.execute('DELETE FROM outbox')
        self.assertEqual(len(sent),1)
        self.store.apply_changes([group()],2)
        self.assertEqual(self.notes(),{'a':'local-a'}); self.assertEqual(len(self.store.conflicts()),1)
        row=self.store.conflicts()[0]; self.store.resolve_conflict(row['id'],'remote',row['revision'])
        with self.store.db() as db: self.assertEqual(db.execute('SELECT COUNT(*) FROM sent').fetchone()[0],0)

    def test_later_normal_delta_cannot_escape_group_and_invalidates_review(self):
        self.local(); self.store.apply_changes([group()],2)
        review=self.store.conflicts()[0]
        self.store.apply_changes([change('b','newest-peer-b',version=2,seq=3)],3)
        self.assertEqual(self.notes(),{'a':'local-a'})
        current=self.store.conflicts()[0]; self.assertNotEqual(current['revision'],review['revision'])
        with self.assertRaises(ConflictRevisionError): self.store.resolve_conflict(review['id'],'remote',review['revision'])
        self.store.resolve_conflict(current['id'],'remote',current['revision'])
        self.assertEqual(self.notes(),{'a':'remote-a','b':'newest-peer-b'})

    def test_later_local_edit_invalidates_entire_group_review(self):
        self.local(); self.store.apply_changes([group()],2); review=self.store.conflicts()[0]
        self.local('b','new-local-b')
        with self.assertRaises(ConflictRevisionError): self.store.resolve_conflict(review['id'],'remote',review['revision'])
        self.assertEqual(self.notes(),{'a':'local-a','b':'new-local-b'}); self.assertEqual(self.store.pending(),[])

    def test_overlapping_groups_form_one_atomic_conflict_component(self):
        self.local(); self.store.apply_changes([group()],2)
        second=group('second',3,[change('b','second-b',version=2),change('c','second-c')])
        self.store.apply_changes([second],4)
        self.assertEqual(self.notes(),{'a':'local-a'}); self.assertEqual(len(self.store.conflicts()),1)
        review=self.store.conflicts()[0]
        self.assertEqual(review['groupIds'],['group','second']); self.assertEqual(review['memberCount'],3)
        self.store.resolve_conflict(review['id'],'remote',review['revision'])
        self.assertEqual(self.notes(),{'a':'remote-a','b':'second-b','c':'second-c'})
        with self.store.db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM incoming_group_members').fetchone()[0],0)

    def test_group_can_include_tombstone_trash_and_message_receipt(self):
        self.local()
        message=change(wire_id('chat','answer'),kind='messages',data={'id':'answer','conversationId':'chat','role':'assistant','content':'applied','pendingPlan':{'id':'plan','status':'applied'}})
        bundle=group('lifecycle',1,[change('a',deleted=True),change('trash',kind='trash',data={'id':'trash','title':'recoverable','data':{'notes':[{'id':'a','title':'remote-original'}]}}),
                  change('chat',kind='conversations',data={'id':'chat','title':'chat'}),message])
        self.store.apply_changes([bundle],4)
        self.assertEqual(self.notes(),{'a':'local-a'}); self.assertEqual(self.store.snapshot()['trash'],[])
        review=self.store.conflicts()[0]; self.assertEqual(review['memberCount'],4)
        self.store.resolve_conflict(review['id'],'remote',review['revision'])
        state=self.store.snapshot(); self.assertEqual(state['notes'],[]); self.assertEqual(len(state['trash']),1)
        self.assertEqual(state['conversations'][0]['messages'][0]['pendingPlan']['status'],'applied')

    def test_publication_failure_rolls_back_receive_and_group_resolution(self):
        def fail(_): raise OSError('fixture publication failure')
        before=self.db_state()
        with self.assertRaises(OSError): self.store.apply_changes([group()],2,before_commit=fail)
        self.assertEqual(self.db_state(),before)
        self.local(); before=self.db_state()
        with self.assertRaises(OSError): self.store.apply_changes([group()],2,before_commit=fail)
        self.assertEqual(self.db_state(),before)
        self.store.apply_changes([group()],2); review=self.store.conflicts()[0]; before=self.db_state()
        with self.assertRaises(OSError): self.store.resolve_conflict(review['id'],'remote',review['revision'],before_commit=fail)
        self.assertEqual(self.db_state(),before)
        result=self.store.resolve_conflict(review['id'],'remote',review['revision'],before_commit=lambda _:'.cloud-undo-fixture')
        self.assertTrue(result['changed']); self.assertTrue(self.store.file_transaction_committed('.cloud-undo-fixture'))

    def test_invalid_envelope_rolls_back_preceding_ordinary_changes(self):
        invalid=[]
        gap=group(); gap['changes'][1]['seq']=99; invalid.append(gap)
        duplicate=group(); duplicate['changes'][1]['entityId']='a'; invalid.append(duplicate)
        missing=group(); missing['changes'].pop(); invalid.append(missing)
        wrong=group(); wrong['changes'][1]['data']=[]; invalid.append(wrong)
        for envelope in invalid:
            before=self.db_state()
            with self.assertRaises(ValueError): self.store.apply_changes([change('ordinary'),envelope],2)
            self.assertEqual(self.db_state(),before)

    def test_old_normal_conflicts_keep_single_record_resolution(self):
        self.local(); self.store.apply_changes([change('a','remote-a')],1)
        review=self.store.conflicts()[0]; self.assertNotIn('groupId',review)
        self.store.resolve_conflict(review['id'],'local',review['revision'])
        self.assertEqual(self.notes(),{'a':'local-a'}); self.assertEqual(len(self.store.pending()),1)

    def test_late_ack_updates_group_head_without_changing_business_records(self):
        self.local(); operation=self.store.pending()[0]; self.store.apply_changes([group()],2)
        review=self.store.conflicts()[0]
        self.store.ack([{key:operation[key] for key in ('opId','entityType','entityId')}|{'version':2}])
        self.assertEqual(self.notes(),{'a':'local-a'})
        current=self.store.conflicts()[0]; self.assertNotEqual(current['revision'],review['revision'])
        member=next(item for item in current['groupMembers'] if item['entityId']=='a')
        self.assertEqual(member['remoteVersion'],2); self.assertEqual(member['remote']['title'],'local-a')


if __name__=='__main__': unittest.main()
