"""Deferred lifecycle, private projections and migration on isolated SQLite databases."""
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import app
import test_app as api_tests
from sharing import DEFAULT_POLICY, shared_state
from dashboard_api import agenda


class Deferred(unittest.TestCase):
    setUpClass = classmethod(api_tests.API.setUpClass.__func__)
    tearDownClass = classmethod(api_tests.API.tearDownClass.__func__)
    req = api_tests.API.req
    login = api_tests.API.login

    def setUp(self):
        api_tests.API.setUp(self)
        with app.connect() as c:
            c.execute('DELETE FROM tasks')
            c.execute('DELETE FROM viewers')
        self.login()

    def state(self):
        return self.req('state')[1]

    def create(self, **changes):
        data = dict(title='暂缓验收',category='科研',date='2026-10-18',end_date='2026-10-20',
                    start_time='09:00',end_time='10:00',due='2026-10-21T12:00',notes='保留正文',
                    milestones=[dict(label='完成初稿',stop_at='2026-10-19T12:00',done=True),
                                dict(label='提交',stop_at='2026-10-22T12:00',done=False)])
        data.update(changes)
        self.assertEqual(self.req('tasks','POST',data)[0],200)
        return next(t for t in self.state()['tasks']+self.state()['deferred_tasks'] if t['title']==data['title'])

    def test_defer_edit_copy_delete_restore_resume(self):
        original = self.create()
        path = 'tasks/'+original['id']
        self.assertEqual(self.req(path,'PUT',{**original,'deferred':True})[0],200)
        state = self.state()
        self.assertEqual(state['tasks'],[])
        task = state['deferred_tasks'][0]
        expected = {k:original[k] for k in (*app.SCHEDULE_FIELDS,'milestones')}
        self.assertEqual(task['previous_schedule'],expected)
        self.assertTrue(task['deferred_at'])
        self.assertEqual(task['milestones'],[])
        self.assertTrue(all(task[k]=='' for k in app.SCHEDULE_FIELDS))
        self.assertEqual(self.req(path,'PUT',original)[0],409)
        # Content changes cannot overwrite the server's reference or reactivate old times.
        changed={**task,'notes':'编辑暂缓正文','previous_schedule':{},'date':'2026-11-01'}
        self.assertEqual(self.req(path,'PUT',changed)[0],200)
        edited=self.state()['deferred_tasks'][0]
        self.assertEqual(edited['previous_schedule'],expected)
        self.assertEqual(edited['deferred_at'],task['deferred_at'])
        copy={**edited,'title':'暂缓副本'}
        self.assertEqual(self.req('tasks','POST',copy)[0],200)
        self.assertEqual(len(self.state()['deferred_tasks']),2)
        self.assertEqual(self.req(path,'DELETE',{'version':edited['version']})[0],200)
        self.assertEqual(self.req('tasks','POST',edited)[0],200)
        restored=next(t for t in self.state()['deferred_tasks'] if t['title']==edited['title'])
        self.assertEqual(restored['previous_schedule'],expected)
        self.assertEqual(restored['deferred_at'],edited['deferred_at'])
        new_path='tasks/'+restored['id']
        # Resuming must explicitly provide empty due/nodes; never inherit them.
        incomplete={**restored,'deferred':False,'date':'2026-11-01','end_date':'2026-11-02'}
        del incomplete['milestones']
        self.assertEqual(self.req(new_path,'PUT',incomplete)[0],400)
        self.assertEqual(len(self.state()['tasks']),0)
        resumed={**restored,'deferred':False,'date':'2026-11-01','end_date':'2026-11-02','due':'','milestones':[]}
        self.assertEqual(self.req(new_path,'PUT',resumed)[0],200)
        active=self.state()['tasks'][0]
        self.assertEqual(active['id'],restored['id'])
        self.assertEqual(active['milestones'],[])
        self.assertEqual(active['due'],'')
        self.assertEqual(active['previous_schedule'],expected)
        self.assertEqual(self.req(new_path,'PUT',{**active,'deferred':True})[0],200)
        latest=next(t for t in self.state()['deferred_tasks'] if t['id']==active['id'])
        self.assertEqual(latest['previous_schedule']['date'],'2026-11-01')
        self.assertEqual(latest['previous_schedule']['milestones'],[])

    def test_no_date_creation_validation_and_permissions(self):
        self.assertEqual(self.req('tasks','POST',dict(title='无日期',category='科研',deferred=True))[0],200)
        task=self.state()['deferred_tasks'][0]
        self.assertEqual(task['previous_schedule'],{})
        self.assertEqual(self.req('tasks','POST',dict(title='缺日期',deferred=False))[0],400)
        self.assertEqual(self.req('tasks','POST',dict(title='冲突状态',deferred=True,done=True))[0],400)
        self.assertEqual(self.req('tasks','POST',dict(title='类型错误',deferred='true'))[0],400)
        self.assertEqual(self.req('tasks','POST',dict(title='坏参考',deferred=True,previous_schedule={'date':'bad'}))[0],400)
        self.assertEqual(self.req('tasks/'+task['id'],'PUT',{**task,'deferred':False})[0],400)
        self.assertTrue(self.state()['deferred_tasks'][0]['deferred'])
        token=self.csrf;self.csrf='bad'
        self.assertEqual(self.req('tasks/'+task['id'],'PUT',task)[0],403)
        self.csrf=token
        self.req('logout','POST',{})
        self.login('bob','other-password-123')
        self.assertEqual(self.state()['deferred_tasks'],[])
        self.assertEqual(self.req('tasks/'+task['id'],'PUT',task)[0],409)
        self.assertEqual(self.req('tasks/'+task['id'],'DELETE',{'version':task['version']})[0],409)

    def test_explicit_restore_and_completed_guard(self):
        original=self.create(done=True)
        self.assertEqual(self.req('tasks/'+original['id'],'PUT',{**original,'deferred':True,'done':False})[0],400)
        self.assertEqual(self.req('tasks/'+original['id'],'PUT',{**original,'done':False})[0],200)
        original=self.state()['tasks'][0]
        self.assertEqual(self.req('tasks/'+original['id'],'PUT',{**original,'deferred':True})[0],200)
        task=self.state()['deferred_tasks'][0]
        self.assertEqual(self.req('tasks/'+task['id'],'PUT',{**task,**task['previous_schedule'],'deferred':False})[0],200)
        restored=self.state()['tasks'][0]
        self.assertEqual(restored['milestones'],original['milestones'])
        self.assertEqual(restored['due'],original['due'])


    def test_no_share_or_dashboard_leak(self):
        original=self.create()
        self.req('tasks/'+original['id'],'PUT',{**original,'deferred':True})
        with app.connect() as c:
            owner=c.execute("SELECT id FROM users WHERE name='alice'").fetchone()[0]
            viewer_id=c.execute("SELECT id FROM users WHERE name='bob'").fetchone()[0]
            policy={**DEFAULT_POLICY,'enabled':True,'categories':['科研'],'range':'custom','start':'2026-10-01','end':'2026-11-01','notes':True,'done':True}
            c.execute('INSERT INTO viewers(user_id,owner_id,active,policy) VALUES(?,?,1,?)',(viewer_id,owner,json.dumps(policy)))
            viewer=c.execute('SELECT * FROM viewers WHERE user_id=?',(viewer_id,)).fetchone()
            shared=shared_state(c,viewer)
            self.assertEqual(shared['tasks'],[])
            self.assertNotIn('deferred_tasks',shared)
            self.assertEqual(agenda(c,viewer,'/api/v1/agenda?from=2026-10-01&to=2026-10-31')['tasks'],[])
        self.req('logout','POST',{})
        self.login('bob','other-password-123')
        self.assertNotIn('deferred_tasks',self.state())
        self.assertEqual(self.req('tasks','POST',dict(title='越权',deferred=True))[0],403)


class DeferredMigration(unittest.TestCase):
    def test_existing_task_data_unchanged_and_migration_idempotent(self):
        previous=app.DB
        try:
            with tempfile.TemporaryDirectory() as temp:
                app.DB=Path(temp)/'old.db'
                with sqlite3.connect(app.DB) as c:
                    c.execute('CREATE TABLE tasks(id TEXT PRIMARY KEY,user_id INTEGER,title TEXT,category TEXT,date TEXT,due TEXT,notes TEXT,done INTEGER,version INTEGER,end_date TEXT,start_time TEXT,end_time TEXT,milestones TEXT,short_title TEXT)')
                    c.execute("INSERT INTO tasks VALUES('old',1,'原任务','科研','2026-10-19','','保留',0,7,'2026-10-20','','','[]','原')")
                    before=c.execute('SELECT * FROM tasks').fetchone()
                app.init();app.init()
                with app.connect() as c:
                    row=c.execute("SELECT * FROM tasks WHERE id='old'").fetchone()
                    self.assertEqual(tuple(row)[:len(before)],before)
                    self.assertEqual((row['deferred'],row['deferred_at'],row['previous_schedule']),(0,'','{}'))
        finally:
            app.DB=previous


if __name__=='__main__':
    unittest.main()
