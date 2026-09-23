import unittest,tempfile,threading,json,urllib.request,urllib.error,http.cookiejar,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import app
class API(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.temp=tempfile.TemporaryDirectory();app.DB=Path(cls.temp.name)/'test.db';app.init();app.create_user('alice','test-password-123');app.create_user('bob','other-password-123');cls.server=app.ThreadingHTTPServer(('127.0.0.1',0),app.Handler);threading.Thread(target=cls.server.serve_forever,daemon=True).start();cls.url='http://127.0.0.1:'+str(cls.server.server_port)
 @classmethod
 def tearDownClass(cls): cls.server.shutdown();cls.server.server_close();cls.temp.cleanup()
 def setUp(self):
  with app.connect() as c: c.execute('DELETE FROM attempts')
  self.client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()));self.csrf=''
 def req(self,path,method='GET',data=None):
  r=urllib.request.Request(self.url+'/api/'+path,data=json.dumps(data).encode() if data is not None else None,method=method,headers={'Content-Type':'application/json','X-CSRF-Token':self.csrf})
  try: res=self.client.open(r)
  except urllib.error.HTTPError as e: res=e
  return res.status,json.load(res)
 def login(self,name='alice',password='test-password-123'):
  self.assertEqual(self.req('login','POST',{'name':name,'password':password})[0],200);self.csrf=self.req('state')[1]['csrf']
 def test_auth_csrf_logout(self):
  self.assertEqual(self.req('state')[0],401);self.assertEqual(self.req('login','POST',{'name':'alice','password':'wrong'})[0],401);self.login();token=self.csrf;self.csrf='bad';self.assertEqual(self.req('settings','PUT',{})[0],403);self.csrf=token;self.assertEqual(self.req('logout','POST',{})[0],200);self.assertEqual(self.req('state')[0],401)
 def test_crud_conflict_isolation(self):
  self.login();data={'title':'<script>alert(1)</script>','date':'2026-09-15','due':'2026-09-18T23:00','category':'课程','notes':'测试','done':False};self.assertEqual(self.req('tasks','POST',data)[0],200);task=next(t for t in self.req('state')[1]['tasks'] if t['title']==data['title']);path='tasks/'+task['id'];self.assertEqual(self.req(path,'PUT',{**task,'date':'2026-09-17','end_date':'2026-09-17'})[0],200);self.assertEqual(self.req(path,'PUT',task)[0],409);updated=next(t for t in self.req('state')[1]['tasks'] if t['id']==task['id']);self.assertEqual(updated['due'],data['due']);self.req('logout','POST',{});self.login('bob','other-password-123');self.assertEqual(self.req('state')[1]['tasks'],[]);self.assertEqual(self.req(path,'DELETE',{'version':2})[0],409);self.req('logout','POST',{});self.login();self.assertEqual(self.req(path,'DELETE',{'version':2})[0],200)
 def test_task_range(self):
  self.login(); data={'title':'pre 准备','date':'2026-09-15','end_date':'2026-09-21','due':'2026-09-22T10:00','category':'课程'}
  self.assertEqual(self.req('tasks','POST',data)[0],200)
  task=next(t for t in self.req('state')[1]['tasks'] if t['title']=='pre 准备');self.assertEqual(task['end_date'],'2026-09-21')
  self.assertEqual(self.req('tasks/'+task['id'],'PUT',{**task,'end_date':'2026-09-14'})[0],400)
  self.assertEqual(self.req('tasks/'+task['id'],'PUT',{**task,'date':'2026-09-17','end_date':'2026-09-23'})[0],200)
  updated=next(t for t in self.req('state')[1]['tasks'] if t['id']==task['id']);self.assertEqual(updated['due'],data['due']);self.assertEqual(updated['end_date'],'2026-09-23')
 def test_account_management(self):
  self.login();d={'action':'create','name':'charlie','current_password':'test-password-123','password':'1234'}
  self.assertEqual(self.req('users','POST',d)[0],200)
  self.assertEqual(self.req('users','POST',d)[0],409)
  self.req('logout','POST',{});self.login('charlie','1234')
  self.assertEqual(self.req('users','POST',d)[0],403)
  self.assertEqual(self.req('password','POST',{'current_password':'wrong','password':'5678'})[0],400)
  self.assertEqual(self.req('password','POST',{'current_password':'1234','password':'5678'})[0],200)
  self.assertEqual(self.req('state')[0],401)
  self.login('charlie','5678');self.req('logout','POST',{});self.login()
  self.assertEqual(self.req('users','POST',{**d,'action':'reset','password':'9012'})[0],200)
  self.req('logout','POST',{});self.login('charlie','9012')
 def test_password_lengths(self):
  self.login()
  self.assertEqual(self.req('password','POST',{'current_password':'test-password-123','password':'1234'})[0],400)
  self.assertEqual(self.req('users','POST',{'action':'reset','name':'alice','current_password':'test-password-123','password':'1234'})[0],400)
  self.assertEqual(self.req('users','POST',{'action':'create','name':'too_short','current_password':'test-password-123','password':'123'})[0],400)
 def test_timetable(self):
  self.login();courses=self.req('timetable')[1]['courses'];self.assertEqual(len(courses),14)
  before=self.req('state')[1]['tasks'];self.assertEqual(self.req('timetable','POST',{})[0],200)
  self.assertEqual(self.req('timetable','POST',{})[0],200);state=self.req('state')[1];self.assertEqual(state['tasks'],before);self.assertEqual(len(state['timetable']),14)
  self.assertEqual(self.req('timetable','PUT',{'courses':[{**courses[0],'day':9}]})[0],400)
  self.assertEqual(self.req('timetable','PUT',{'courses':courses})[0],200)
  self.req('logout','POST',{});self.login('bob','other-password-123');self.assertEqual(self.req('state')[1]['timetable'],[])
  self.assertEqual(self.req('timetable','PUT',{'courses':[]})[0],403)
 def test_journal(self):
  self.login();before=self.req('state')[1]['tasks'];d={'date':'2026-09-16','body':'今日复盘 <script>','version':0}
  self.assertEqual(self.req('journal','PUT',d)[0],200)
  self.assertEqual(self.req('journal','PUT',d)[0],409)
  state=self.req('state')[1];self.assertEqual(state['tasks'],before);self.assertEqual(state['journal'][0]['body'],d['body'])
  self.assertEqual(self.req('journal','PUT',{**d,'body':'更新','version':1})[0],200)
  self.req('logout','POST',{});self.login('bob','other-password-123');self.assertEqual(self.req('state')[1]['journal'],[])
  self.assertEqual(self.req('journal','PUT',{**d,'date':'2026-02-30'})[0],400)
 def test_rename_username(self):
  self.login();before=self.req('state')[1]
  d=dict(name='renamed-alice',current_password='test-password-123')
  self.assertEqual(self.req('username','POST',{**d,'current_password':'wrong'})[0],400)
  for name in ['', 'white space', ' leading', 'x'*65, 'bad\x00name', None]:
   self.assertEqual(self.req('username','POST',{**d,'name':name})[0],400)
  self.assertEqual(self.req('username','POST',{**d,'name':'bob'})[0],409)
  self.assertEqual(self.req('username','POST',{**d,'name':'alice'})[0],200)
  self.assertEqual(self.req('username','POST',d)[0],200)
  after=self.req('state')[1];self.assertEqual(after['user']['name'],d['name'])
  for key in ['tasks','settings','journal','categories','timetable']:self.assertEqual(before[key],after[key])
  self.req('logout','POST',{})
  self.assertEqual(self.req('login','POST',dict(name='alice',password=d['current_password']))[0],401)
  self.login(d['name'],d['current_password'])
  self.assertEqual(self.req('username','POST',{**d,'name':'alice'})[0],200)
 def test_profile(self):
  self.login();self.assertEqual(self.req('profile','PUT',{'remark':'研究学习 <备注>'})[0],200)
  self.assertEqual(self.req('state')[1]['user']['remark'],'研究学习 <备注>')
  self.assertEqual(self.req('profile','PUT',{'remark':'x'*61})[0],400)
  self.req('logout','POST',{});self.login('bob','other-password-123');self.assertEqual(self.req('state')[1]['user']['remark'],'')
 def test_categories(self):
  self.login();d={'action':'create','name':'自定义','color':'#123456'}
  self.assertEqual(self.req('categories','POST',d)[0],200)
  self.assertEqual(self.req('tasks','POST',{'title':'分类迁移测试','date':'2026-09-16','category':'自定义'})[0],200)
  self.assertEqual(self.req('categories','POST',{'action':'edit','old':'自定义','name':'新分类','color':'#654321'})[0],200)
  self.assertTrue(any(t['category']=='新分类' for t in self.req('state')[1]['tasks']))
  self.assertEqual(self.req('categories','POST',{'action':'delete','name':'新分类','target':'课程'})[0],200)
  self.assertFalse(any(t['category']=='新分类' for t in self.req('state')[1]['tasks']))
  self.assertEqual(self.req('categories','POST',{**d,'color':'bad'})[0],400)
  self.req('logout','POST',{});self.login('bob','other-password-123');self.assertEqual(len(self.req('state')[1]['categories']),4)
 def test_minute_schedule(self):
  self.login();d={'title':'分钟安排','category':'课程','date':'2026-09-16','end_date':'2026-09-16','start_time':'09:15','end_time':'10:45'}
  self.assertEqual(self.req('tasks','POST',d)[0],200)
  t=next(t for t in self.req('state')[1]['tasks'] if t['title']==d['title']);self.assertEqual(t['start_time'],'09:15')
  for bad in [{'end_time':'09:15'},{'end_time':'08:00'},{'end_time':''},{'start_time':'25:00'}]:self.assertEqual(self.req('tasks','POST',{**d,**bad})[0],400)
  self.assertEqual(self.req('tasks/'+t['id'],'PUT',{**t,'date':'2026-09-17','end_date':'2026-09-18','start_time':'23:30','end_time':'00:15'})[0],200)
  t=next(x for x in self.req('state')[1]['tasks'] if x['id']==t['id']);self.assertEqual(t['end_time'],'00:15')
  self.assertEqual(self.req('tasks/'+t['id'],'PUT',{**t,'start_time':'','end_time':''})[0],200)
 def test_validation(self):
  self.login();self.assertEqual(self.req('tasks','POST',{'title':'x','date':'2026-02-30'})[0],400);self.assertEqual(self.req('settings','PUT',{'name':'x','start':'2026-09-15'})[0],400);self.assertEqual(self.req('settings','PUT',{'name':'测试学期','start':'2026-09-07'})[0],200)
 def test_rate_limit(self):
  for _ in range(8):self.req('login','POST',{'name':'missing','password':'bad'})
  self.assertEqual(self.req('login','POST',{'name':'missing','password':'bad'})[0],429)
if __name__=='__main__': unittest.main()
