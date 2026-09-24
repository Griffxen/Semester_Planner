import unittest,json,datetime as dt,urllib.request,urllib.error
import test_app
import app
from sharing import DEFAULT_POLICY,shared_state

class Sharing(unittest.TestCase):
    req=test_app.API.req
    login=test_app.API.login
    def setUp(self):
        test_app.API.setUpClass.__func__(type(self));test_app.API.setUp(self)
        self.login()
        self.assertEqual(self.req('shares','POST',dict(action='create',name='viewer',password='1234',owner_id=1,current_password='test-password-123'))[0],200)
        self.share=self.req('shares')[1]['shares'][0]
        self.vid=self.share['id']
    def tearDown(self):test_app.API.tearDownClass.__func__(type(self))
    def policy(self,**kwargs):
        current=self.req('shares')[1]['shares'][0]
        p={**DEFAULT_POLICY,'enabled':True,'categories':['课程'],'range':'custom','start':'2026-09-15','end':'2026-09-20',**kwargs}
        self.assertEqual(self.req('shares','PUT',dict(id=self.vid,version=current['version'],policy=p))[0],200)
    def viewer(self):
        self.req('logout','POST',{});self.login('viewer','1234')
    def dashboard(self,path,token='',method='GET'):
        request=urllib.request.Request(self.url+'/api/v1/'+path,method=method,
            headers={'Authorization':'Bearer '+token} if token else {})
        try: response=urllib.request.urlopen(request)
        except urllib.error.HTTPError as error: response=error
        return response.status,json.load(response)
    def token(self):
        status,result=self.req('dashboard-token','POST',dict(id=self.vid,action='rotate',current_password='test-password-123'))
        self.assertEqual(status,200)
        return result['token']
    def test_dashboard_read_only_and_token_lifecycle(self):
        self.assertEqual(self.dashboard('agenda?from=2026-09-15&to=2026-09-16')[0],401)
        self.assertEqual(self.req('dashboard-token','POST',dict(id=self.vid,action='rotate',current_password='bad'))[0],403)
        self.policy(timetable=True,notes=False)
        self.req('timetable','POST',{})
        self.req('tasks','POST',dict(title='visible',category='课程',date='2026-09-14',end_date='2026-09-18',due='2026-09-18T10:00',notes='SECRET'))
        self.req('tasks','POST',dict(title='hidden',category='科研',date='2026-09-16'))
        token=self.token()
        self.assertTrue(self.req('shares')[1]['shares'][0]['dashboard_token_enabled'])
        status,result=self.dashboard('agenda?from=2026-09-16&to=2026-09-17',token)
        self.assertEqual(status,200);self.assertEqual(len(result['tasks']),1)
        task=result['tasks'][0]
        self.assertEqual(task['title'],'visible');self.assertEqual(task['due'],'2026-09-18T10:00')
        self.assertEqual(task['date'],'2026-09-16');self.assertTrue(task['continues_before'])
        self.assertEqual(task['notes'],'');self.assertNotIn('SECRET',json.dumps(result))
        self.assertTrue(result['courses'])
        self.assertEqual(self.dashboard('agenda/meta',token)[1]['categories'],[{'name':'课程','color':'#7185bd'}])
        self.assertEqual(self.dashboard('agenda?from=2026-09-16&to=2026-09-17&include=courses',token)[1]['tasks'],[])
        for path in ['agenda','agenda?from=2026-09-16&to=2026-10-17','agenda?from=2026-09-17&to=2026-09-16','agenda?from=2026-09-16&to=2026-09-17&include=journal']:
            self.assertEqual(self.dashboard(path,token)[0],400)
        self.assertEqual(self.dashboard('agenda?from=2026-09-16&to=2026-09-17',token,'POST')[0],405)
        new_token=self.token();self.assertEqual(self.dashboard('agenda/meta',token)[0],401)
        self.assertEqual(self.dashboard('agenda/meta',new_token)[0],200)
        self.assertEqual(self.req('dashboard-token','POST',dict(id=self.vid,action='revoke',current_password='test-password-123'))[0],200)
        self.assertEqual(self.dashboard('agenda/meta',new_token)[0],401)
    def test_dashboard_busy_and_authorization_changes(self):
        self.req('tasks','POST',dict(title='SECRET',category='课程',date='2026-09-16',end_date='2026-09-16',due='2026-09-16T10:00'))
        self.policy(busy_only=True,timetable=True)
        token=self.token()
        result=self.dashboard('agenda?from=2026-09-15&to=2026-09-20',token)[1]
        self.assertNotIn('SECRET',json.dumps(result));self.assertEqual(result['date_counts'],[{'date':'2026-09-16','count':1}])
        self.assertEqual(self.dashboard('agenda/meta',token)[1]['categories'],[])
        self.policy(enabled=False)
        self.assertEqual(self.dashboard('agenda?from=2026-09-15&to=2026-09-20',token)[1]['tasks'],[])
        self.assertEqual(self.dashboard('agenda/meta',token)[1]['semester'],{'name':'','start':''})
        self.assertEqual(self.req('shares','POST',dict(action='active',id=self.vid,active=False,current_password='test-password-123'))[0],200)
        self.assertEqual(self.dashboard('agenda/meta',token)[0],401)
    def test_dashboard_rebind_revokes_token_and_due_stays_with_share(self):
        self.req('tasks','POST',dict(title='outside due',category='课程',date='2026-09-16',due='2026-09-22T10:00'))
        self.policy()
        token=self.token()
        task=self.dashboard('agenda?from=2026-09-16&to=2026-09-16',token)[1]['tasks'][0]
        self.assertIsNone(task['due'])
        self.assertEqual(self.req('shares','POST',dict(action='rebind',id=self.vid,owner_id=2,current_password='test-password-123'))[0],200)
        self.assertEqual(self.dashboard('agenda/meta',token)[0],401)
    def test_default_denial_and_write_barrier(self):
        self.viewer();s=self.req('state')[1];self.assertFalse(s['share']['enabled']);self.assertEqual(s['tasks'],[])
        for endpoint,method in [('tasks','POST'),('tasks/other','DELETE'),('settings','PUT'),('journal','PUT'),('profile','PUT'),('categories','POST'),('timetable','GET'),('timetable','PUT'),('users','POST'),('shares','GET'),('shares','PUT'),('share-preview/'+str(self.vid),'GET')]:
            self.assertEqual(self.req(endpoint,method,{} if method!='GET' else None)[0],403,(endpoint,method))
        self.assertEqual(self.req('view-export')[0],403)
        self.assertEqual(self.req('password','POST',dict(current_password='1234',password='5678'))[0],200)
        self.assertEqual(self.req('state')[0],401)
        self.login('viewer','5678')
    def test_projection_preview_and_export(self):
        for title,cat,done in [('allowed','课程',False),('hidden category','科研',False),('completed','课程',True)]:
            self.assertEqual(self.req('tasks','POST',dict(title=title,category=cat,date='2026-09-10',end_date='2026-09-25',due='2026-09-26T10:00',notes='PRIVATE',done=done))[0],200)
        for date in ['2026-09-15','2026-09-16','2026-09-21']:
            self.req('journal','PUT',dict(date=date,body='Diary '+date,version=0))
        self.req('timetable','POST',{})
        self.policy(journal='selected',journal_dates=['2026-09-16','2026-09-21'],timetable=True,export=True)
        preview=self.req('share-preview/'+str(self.vid))[1]
        self.viewer();s=self.req('state')[1]
        for k in ['tasks','journal','categories','course_dates','share']:self.assertEqual(s[k],preview[k])
        self.assertEqual(len(s['tasks']),1);t=s['tasks'][0];self.assertEqual(t['date'],'2026-09-15');self.assertEqual(t['end_date'],'2026-09-20');self.assertEqual(t['due'],'');self.assertEqual(t['notes'],'');self.assertTrue(t['continues_before'] and t['continues_after'])
        self.assertEqual([j['date'] for j in s['journal']],['2026-09-16']);self.assertEqual(s['timetable'],[])
        self.assertTrue(s['course_dates']);self.assertTrue(all('2026-09-15'<=c['date']<='2026-09-20' for c in s['course_dates']))
        self.assertEqual(self.req('view-export')[0],200)
    def test_owner_isolation_pause_and_rebind(self):
        self.policy();self.viewer()
        with app.connect() as c:
            p=json.loads(c.execute('SELECT policy FROM viewers WHERE user_id=?',(self.vid,)).fetchone()[0]);p['enabled']=False;c.execute('UPDATE viewers SET policy=? WHERE user_id=?',(json.dumps(p),self.vid))
        self.assertFalse(self.req('state')[1]['share']['enabled']);self.assertEqual(self.req('view-export')[0],403)
        self.req('logout','POST',{});self.login('bob','other-password-123')
        self.assertEqual(self.req('shares')[1]['shares'],[])
        self.assertEqual(self.req('shares','PUT',dict(id=self.vid,version=1,policy=DEFAULT_POLICY))[0],403)
        self.assertEqual(self.req('share-preview/'+str(self.vid))[0],403)
        self.assertEqual(self.req('shares','POST',dict(action='rebind',id=self.vid,owner_id=2))[0],403)
        self.req('logout','POST',{});self.login()
        self.assertEqual(self.req('shares','POST',dict(action='rebind',id=self.vid,owner_id=2,current_password='test-password-123'))[0],200)
        self.assertEqual(self.req('shares')[1]['shares'],[])
        self.viewer();self.assertFalse(self.req('state')[1]['share']['enabled'])
    def test_disable_and_conflict(self):
        self.policy();self.assertEqual(self.req('shares','PUT',dict(id=self.vid,version=1,policy=DEFAULT_POLICY))[0],409)
        self.assertEqual(self.req('shares','POST',dict(action='active',id=self.vid,active=False,current_password='test-password-123'))[0],200)
        self.req('logout','POST',{});self.assertEqual(self.req('login','POST',dict(name='viewer',password='1234'))[0],403)
    def test_rebind_revokes_session(self):
        self.viewer();viewer_client=self.client;viewer_csrf=self.csrf
        test_app.API.setUp(self);self.login()
        self.assertEqual(self.req('shares','POST',dict(action='rebind',id=self.vid,owner_id=2,current_password='test-password-123'))[0],200)
        self.client=viewer_client;self.csrf=viewer_csrf
        self.assertEqual(self.req('state')[0],401)
    def test_busy_only_redacts_all_details(self):
        self.req('tasks','POST',dict(title='SECRET_TITLE',category='课程',date='2026-09-16',end_date='2026-09-18',notes='SECRET_NOTE',due='2026-09-18T10:00'))
        self.req('journal','PUT',dict(date='2026-09-16',body='SECRET_DIARY',version=0))
        self.req('timetable','POST',{})
        self.policy(busy_only=True,notes=True,journal='all',timetable=True,export=True)
        preview=self.req('share-preview/'+str(self.vid))[1]
        self.viewer();s=self.req('view-export')[1]
        self.assertEqual(s['tasks'],preview['tasks']);self.assertEqual(s['journal'],[])
        self.assertEqual(s['date_counts'],[]);self.assertEqual(len(s['tasks']),1)
        self.assertEqual(s['tasks'][0]['title'],'另有安排');self.assertEqual(s['tasks'][0]['due'],'')
        self.assertEqual((s['tasks'][0]['date'],s['tasks'][0]['end_date']),('2026-09-16','2026-09-18'))
        raw=json.dumps(s,ensure_ascii=False)
        for secret in ['SECRET_TITLE','SECRET_NOTE','SECRET_DIARY','数学物理','三教','课程']:self.assertNotIn(secret,raw)
        self.assertTrue(all(x['name']=='已占用' and x['room']=='' for x in s['course_dates']))
    def test_date_counts_exclude_timed_hidden_and_completed(self):
        for extra in [{},{},dict(start_time='10:00',end_time='11:00'),dict(category='科研'),dict(done=True)]:
            task=dict(title='PRIVATE',category='课程',date='2026-09-16',end_date='2026-09-16')
            task.update(extra)
            self.assertEqual(self.req('tasks','POST',task)[0],200)
        self.policy(busy_only=True,export=True)
        preview=self.req('share-preview/'+str(self.vid))[1]
        self.viewer();s=self.req('state')[1]
        self.assertEqual(s['date_counts'],[dict(date='2026-09-16',count=2)])
        self.assertEqual(len(s['tasks']),1)
        self.assertEqual(s['date_counts'],preview['date_counts'])
        self.assertEqual(s['date_counts'],self.req('view-export')[1]['date_counts'])
        self.assertNotIn('PRIVATE',json.dumps(s))
    def test_date_range_is_one_block_and_clipped(self):
        self.req('tasks','POST',dict(title='PRIVATE_RANGE',category='课程',date='2026-09-10',end_date='2026-09-25',due='2026-09-18T10:00'))
        self.policy(busy_only=True,export=True)
        preview=self.req('share-preview/'+str(self.vid))[1]
        self.viewer();s=self.req('view-export')[1]
        self.assertEqual(s['date_counts'],[]);self.assertEqual(len(s['tasks']),1)
        t=s['tasks'][0]
        self.assertEqual((t['title'],t['date'],t['end_date']),('另有安排','2026-09-15','2026-09-20'))
        self.assertTrue(t['continues_before'] and t['continues_after'])
        self.assertEqual(t['due'],'');self.assertEqual(t['notes'],'')
        self.assertEqual(s['tasks'],preview['tasks']);self.assertNotIn('PRIVATE_RANGE',json.dumps(s))
    def test_minute_sharing_clips_and_redacts(self):
        self.req('tasks','POST',dict(title='Secret minute title',category='课程',date='2026-09-14',end_date='2026-09-21',start_time='13:25',end_time='16:45'))
        self.policy(busy_only=True,export=True)
        self.viewer();t=self.req('view-export')[1]['tasks'][0]
        self.assertEqual((t['date'],t['start_time'],t['end_date'],t['end_time']),('2026-09-15','00:00','2026-09-20','23:59'))
        self.assertEqual(t['title'],'已占用');self.assertTrue(t['continues_before'] and t['continues_after'])
    def test_viewer_can_rename_own_account(self):
        self.policy();self.viewer()
        self.assertEqual(self.req('username','POST',dict(name='alice',current_password='1234'))[0],409)
        self.assertEqual(self.req('username','POST',dict(name='new-viewer',current_password='1234',id=1))[0],200)
        self.assertEqual(self.req('state')[1]['user']['name'],'new-viewer')
        with app.connect() as c:
            self.assertEqual(c.execute('SELECT owner_id FROM viewers WHERE user_id=?',(self.vid,)).fetchone()[0],1)
            self.assertEqual(c.execute('SELECT name FROM users WHERE id=1').fetchone()[0],'alice')
        self.assertEqual(self.req('tasks','POST',{})[0],403)
    def test_admin_account_summary_and_reset(self):
        status,result=self.req('users');self.assertEqual(status,200)
        viewer=next(x for x in result['accounts'] if x['id']==self.vid)
        self.assertEqual(viewer['role'],'viewer');self.assertEqual(viewer['owner_name'],'alice')
        for x in result['accounts']:
            self.assertNotIn('password',x);self.assertNotIn('salt',x);self.assertNotIn('policy',x)
        self.assertEqual(self.req('users','POST',dict(action='reset',name='viewer',current_password='test-password-123',password='5678'))[0],200)
        self.req('logout','POST',{});self.login('viewer','5678')
        self.assertEqual(self.req('users')[0],403)
        self.req('logout','POST',{});self.login('bob','other-password-123')
        self.assertEqual(self.req('users')[0],403)
    def test_category_and_rolling_range(self):
        self.policy(range='two')
        with app.connect() as c:
            v=c.execute('SELECT * FROM viewers WHERE user_id=?',(self.vid,)).fetchone();s=shared_state(c,v,dt.date(2026,9,16))
        self.assertEqual(s['share']['start'],'2026-09-14');self.assertEqual(s['share']['end'],'2026-09-27')
        self.assertEqual(self.req('categories','POST',dict(action='edit',old='课程',name='新的课程',color='#123456'))[0],200)
        self.assertEqual(self.req('shares')[1]['shares'][0]['policy']['categories'],[])

if __name__=='__main__':unittest.main()
