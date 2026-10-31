"""Small audit boundary suite, entirely on temporary databases."""
import csv
import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlencode

import audit_log as audit


class Audit(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.path = Path(self.temp.name)/'test.db'
        self.c = sqlite3.connect(self.path); self.c.row_factory = sqlite3.Row
        self.c.executescript('''CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,password TEXT,salt TEXT,remark TEXT,admin INTEGER);
            INSERT INTO users VALUES(1,'alice','PRIVATE_PASSWORD','PRIVATE_SALT','',0),(2,'bob','PRIVATE_PASSWORD','PRIVATE_SALT','',0),(3,'admin','','','',1);
            CREATE TABLE viewers(user_id INTEGER,owner_id INTEGER,active INTEGER,policy TEXT);
            CREATE TABLE tasks(id TEXT,user_id INTEGER,title TEXT,done INTEGER,notes TEXT,version INTEGER);
            INSERT INTO tasks VALUES('one',1,'第一项',0,'原备注',1),('two',1,'第二项',0,'',1),('private',2,'他人任务',0,'私人正文',1);''')
        audit.init(self.c); self.c.commit()
        self.alice = dict(self.c.execute('SELECT * FROM users WHERE id=1').fetchone())
        self.admin = dict(self.c.execute('SELECT * FROM users WHERE id=3').fetchone())
        self.month = audit.dt.datetime.now(audit.BJ).strftime('%Y-%m')

    def tearDown(self):
        self.c.close(); self.temp.cleanup()

    def get(self,path='/api/audit/events',actor=None,unlocked=False,**query):
        return audit.route(self.c,actor or self.alice,unlocked,'GET',path,path+'?'+urlencode(query),self.path)

    def test_atomic_diff_batch_and_noop(self):
        before = audit.capture(self.c,'/api/tasks',self.alice)
        self.c.execute('UPDATE tasks SET version=version+1 WHERE user_id=1')
        self.assertEqual(audit.record_changes(self.c,before,self.alice,'noop','/api/tasks'),[])
        self.c.rollback()
        before = audit.capture(self.c,'/api/tasks',self.alice)
        self.c.execute('UPDATE tasks SET done=1,version=2 WHERE user_id=1')
        ids = audit.record_changes(self.c,before,self.alice,'batch','/api/tasks')
        self.assertEqual(len(ids),1)
        event = self.get('/api/audit/events/'+str(ids[0]))[1]['event']
        self.assertEqual(len(event['changes']),2)
        self.assertTrue(all(x['field'].endswith('.done') for x in event['changes']))
        self.assertNotIn('私人正文',json.dumps(event,ensure_ascii=False))
        self.c.rollback()
        self.assertEqual(self.c.execute('SELECT count(*) FROM audit_events').fetchone()[0],0)
        before = audit.capture(self.c,'/api/profile',self.alice)
        self.c.execute("UPDATE users SET password='NEW_PRIVATE',remark='新备注' WHERE id=1")
        audit.record_changes(self.c,before,self.alice,'profile','/api/profile')
        exported = self.get('/api/audit/export',format='json')[1]
        self.assertNotIn('PRIVATE',json.dumps(exported)); self.assertIn('新备注',json.dumps(exported,ensure_ascii=False))

    def test_permissions_stable_pagination_and_complete_export(self):
        for number in range(3): audit.record(self.c,self.alice,'update','task',number,'=SUM(1,1)',changes=[dict(field='notes',before='旧\n正文',after='新正文')])
        self.assertEqual(len(self.get(group='task')[1]['events']),3)
        self.assertEqual(self.get(group='account')[1]['events'],[])
        bob = dict(self.c.execute('SELECT * FROM users WHERE id=2').fetchone())
        private_id = audit.record(self.c,bob,'update','task','private','私人标题')
        self.assertEqual(self.get('/api/audit/events/'+str(private_id))[0],404)
        self.assertEqual(self.get(scope='all')[0],403)
        self.assertEqual(self.get(actor=self.admin,scope='all')[0],403)
        self.assertEqual(len(self.get(actor=self.admin,unlocked=True,scope='all')[1]['events']),4)
        template = audit.record(self.c,self.admin,'update','template','global','全站模板内容')
        grouped = self.get(actor=self.admin,unlocked=True,scope='all',group='management')[1]['events']
        self.assertEqual([event['id'] for event in grouped],[template])
        self.assertEqual(grouped[0]['group'],'management')
        self.assertEqual(self.get('/api/audit/events/'+str(template),actor=self.admin)[0],404)
        self.assertEqual(self.get('/api/audit/events/'+str(template),actor=self.admin,unlocked=True,scope='all')[0],200)
        self.assertEqual(self.get(user_id=2)[0],403)
        first = self.get(limit=1)[1]
        audit.record(self.c,self.alice,'create','task','later','后来加入')
        second = self.get(limit=1,cursor=first['next_cursor'])[1]
        self.assertLess(second['events'][0]['id'],first['events'][0]['id'])
        self.assertEqual(second['snapshot_id'],first['snapshot_id'])
        exported = self.get('/api/audit/export',format='json',snapshot_id=first['snapshot_id'])[1]
        self.assertEqual(len(exported['events']),3)
        self.assertEqual(exported['events'][0]['changes'][0]['before'],'旧\n正文')
        content = self.get('/api/audit/export',format='csv',snapshot_id=first['snapshot_id'])[1]
        self.assertTrue(content.startswith(b'\xef\xbb\xbf'))
        records = list(csv.DictReader(io.StringIO(content.decode('utf-8-sig'))))
        self.assertEqual(records[0]['label'],"'=SUM(1,1)")
        self.c.execute("INSERT INTO viewers VALUES(2,1,1,'{}')")
        self.assertEqual(self.get(actor=bob)[0],403)
        self.assertEqual(self.get(cursor='W10')[0],400)

    def test_beijing_month_boundary_and_storage(self):
        eid = audit.record(self.c,self.alice,'create','task','one','测试')
        self.c.execute("UPDATE audit_events SET created_at='2026-09-30T16:00:00.000001+00:00' WHERE id=?",(eid,))
        self.assertEqual(len(self.get(month='2026-10')[1]['events']),1)
        self.assertEqual(len(self.get(month='2026-09')[1]['events']),0)
        self.assertEqual(self.get('/api/audit/months')[1]['months'],[dict(month='2026-10',count=1)])
        self.assertEqual(self.get('/api/admin/storage',actor=self.admin)[0],403)
        storage = self.get('/api/admin/storage',actor=self.admin,unlocked=True)[1]
        self.assertEqual(storage['audit']['count'],1)
        self.assertGreater(storage['filesystem']['available_bytes'],0)
        self.assertEqual(storage['database']['page_size'],4096)


if __name__=='__main__': unittest.main()
