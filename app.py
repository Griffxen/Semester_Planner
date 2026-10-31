import re, argparse, datetime as dt, getpass, hashlib, hmac, http.cookies, json, os, secrets, sqlite3, time, logging
from contextlib import contextmanager, closing
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from sharing import init_sharing, DEFAULT_POLICY, validate_policy, private_state, shared_state, drop_category_permissions
from dashboard_api import agenda as dashboard_agenda, meta as dashboard_meta
from exporting import project_export
from courses import migrate_ids
import course_plans
import authentication
import audit_log
import api_reads
ROOT=Path(__file__).resolve().parent
DB=Path(os.environ.get('PLANNER_DB', ROOT/'data/planner.db'))
DASHBOARD_PATHS={'/api/v1/agenda':'agenda','/api/v1/agenda/meta':'meta'}
def validate_milestones(raw):
    if not isinstance(raw,list) or len(raw)>50: raise ValueError()
    result=[]
    for node in raw:
        if not isinstance(node,dict) or set(node)-{'label','stop_at','done'}: raise ValueError()
        label=node.get('label',''); moment=node.get('stop_at')
        if not isinstance(label,str) or len(label)>80 or not isinstance(moment,str): raise ValueError()
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?:\+08:00)?',moment): raise ValueError()
        dt.datetime.fromisoformat(moment)
        done=node.get('done',False)
        if type(done) is not bool: raise ValueError()
        result.append(dict(label=label.strip(),stop_at=moment[:16]+'+08:00',done=done))
    return sorted(result,key=lambda x:x['stop_at'])
SCHEDULE_FIELDS = ('date','end_date','start_time','end_time','due')

def validate_schedule(data):
    date=dt.date.fromisoformat(data['date']).isoformat()
    end_date=dt.date.fromisoformat(data.get('end_date') or date).isoformat()
    start_time=data.get('start_time','');end_time=data.get('end_time','');due=data.get('due','')
    if end_date<date: raise ValueError()
    if start_time or end_time:
        if not all(isinstance(x,str) and re.fullmatch(r'(?:[01][0-9]|2[0-3]):[0-5][0-9]',x) for x in (start_time,end_time)): raise ValueError()
        if date+'T'+start_time>=end_date+'T'+end_time: raise ValueError('结束时间必须晚于开始时间')
    elif start_time!='' or end_time!='': raise ValueError()
    if not isinstance(due,str) or len(due)>16: raise ValueError()
    if due: dt.datetime.fromisoformat(due)
    return dict(date=date,end_date=end_date,start_time=start_time,end_time=end_time,due=due)

def validate_previous_schedule(raw):
    if not isinstance(raw,dict): raise ValueError()
    if not raw: return {}
    if set(raw)-set(SCHEDULE_FIELDS)-{'milestones'}: raise ValueError()
    return dict(**validate_schedule(raw),milestones=validate_milestones(raw.get('milestones',[])))

def connect():
    DB.parent.mkdir(parents=True,exist_ok=True)
    c=sqlite3.connect(DB); c.row_factory=sqlite3.Row; c.execute('PRAGMA foreign_keys=ON'); return c
def init():
    with closing(connect()) as c, c:
        c.executescript('''CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT UNIQUE, salt TEXT, password TEXT);
        CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER,csrf TEXT,expires REAL);
        CREATE TABLE IF NOT EXISTS attempts(ip TEXT,time REAL);
        CREATE TABLE IF NOT EXISTS settings(user_id INTEGER PRIMARY KEY,name TEXT,start TEXT);
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,user_id INTEGER,title TEXT,category TEXT,date TEXT,due TEXT,notes TEXT,done INTEGER,version INTEGER);''')
        c.executescript('CREATE TABLE IF NOT EXISTS timetable_template(id INTEGER PRIMARY KEY, data TEXT); CREATE TABLE IF NOT EXISTS user_timetable(user_id INTEGER PRIMARY KEY, data TEXT);')
        c.execute('CREATE TABLE IF NOT EXISTS holidays(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)')
        c.execute("INSERT OR IGNORE INTO holidays VALUES(1,'[]')")
        c.execute('CREATE TABLE IF NOT EXISTS user_course_exceptions(user_id INTEGER PRIMARY KEY, data TEXT NOT NULL)')
        c.execute('CREATE TABLE IF NOT EXISTS course_annotations(user_id INTEGER, course_key TEXT, date TEXT, notes TEXT NOT NULL, homework_required INTEGER NOT NULL, homework_notes TEXT NOT NULL, PRIMARY KEY(user_id,course_key,date))')
        if 'homework_done' not in [r['name'] for r in c.execute('PRAGMA table_info(course_annotations)')]:
            c.execute('ALTER TABLE course_annotations ADD COLUMN homework_done INTEGER NOT NULL DEFAULT 0')
        if not c.execute('SELECT 1 FROM timetable_template WHERE id=1').fetchone():
            seed=ROOT/'timetable.json'
            c.execute('INSERT INTO timetable_template VALUES(1,?)',(seed.read_text() if seed.exists() else '[]',))
        migrate_ids(c)
        c.execute('CREATE TABLE IF NOT EXISTS journal(user_id INTEGER,date TEXT,body TEXT,version INTEGER,PRIMARY KEY(user_id,date))')
        if 'end_date' not in [r['name'] for r in c.execute('PRAGMA table_info(tasks)')]:
            c.execute('ALTER TABLE tasks ADD COLUMN end_date TEXT')
            c.execute('UPDATE tasks SET end_date=date')
        for field in ('start_time','end_time'):
            if field not in [r['name'] for r in c.execute('PRAGMA table_info(tasks)')]:
                c.execute(f"ALTER TABLE tasks ADD COLUMN {field} TEXT NOT NULL DEFAULT ''")
        if 'milestones' not in [r['name'] for r in c.execute('PRAGMA table_info(tasks)')]:
            c.execute("ALTER TABLE tasks ADD COLUMN milestones TEXT NOT NULL DEFAULT '[]'")
        if 'short_title' not in [r['name'] for r in c.execute('PRAGMA table_info(tasks)')]:
            c.execute("ALTER TABLE tasks ADD COLUMN short_title TEXT NOT NULL DEFAULT ''")
        task_columns={r['name'] for r in c.execute('PRAGMA table_info(tasks)')}
        for field,definition in [('deferred','INTEGER NOT NULL DEFAULT 0'),('deferred_at',"TEXT NOT NULL DEFAULT ''"),('previous_schedule',"TEXT NOT NULL DEFAULT '{}'")]:
            if field not in task_columns: c.execute(f'ALTER TABLE tasks ADD COLUMN {field} {definition}')
        if 'admin' not in [r['name'] for r in c.execute('PRAGMA table_info(users)')]:
            c.execute('ALTER TABLE users ADD COLUMN admin INTEGER NOT NULL DEFAULT 0')
            c.execute('UPDATE users SET admin=1 WHERE id=(SELECT min(id) FROM users)')
        if 'remark' not in [r['name'] for r in c.execute('PRAGMA table_info(users)')]:
            c.execute("ALTER TABLE users ADD COLUMN remark TEXT NOT NULL DEFAULT ''")
        c.execute('CREATE TABLE IF NOT EXISTS categories(user_id INTEGER,name TEXT,color TEXT,PRIMARY KEY(user_id,name))')
        for field,default in [('warn_days',7),('urgent_days',2)]:
            if field not in [r['name'] for r in c.execute('PRAGMA table_info(categories)')]:
                c.execute(f'ALTER TABLE categories ADD COLUMN {field} INTEGER NOT NULL DEFAULT {default}')
        init_sharing(c)
        for u in c.execute('SELECT id FROM users').fetchall():
            ensure_categories(c,u['id'])
        course_plans.init(c)
        authentication.init(c)
        audit_log.init(c)
        api_reads.init(c)
def ensure_categories(c,uid):
    if not c.execute('SELECT 1 FROM categories WHERE user_id=?',(uid,)).fetchone():
        c.executemany('INSERT INTO categories(user_id,name,color) VALUES(?,?,?)',[(uid,n,k) for n,k in [('课程','#7185bd'),('科研','#408f80'),('考试','#b88355'),('个人','#9775ae')]])
def password_hash(password,salt): return hashlib.scrypt(password.encode(),salt=bytes.fromhex(salt),n=16384,r=8,p=1).hex()
def create_user(name,password,demo=False):
    salt=secrets.token_hex(16)
    with closing(connect()) as c, c:
        first=c.execute('SELECT count(*) FROM users').fetchone()[0]==0
        if not 12<=len(password)<=256: raise ValueError('密码至少 12 位，可使用长口令或密码管理器')
        uid=c.execute('INSERT INTO users(name,salt,password,admin) VALUES(?,?,?,?)',(name,salt,password_hash(password,salt),int(first))).lastrowid
        c.execute('INSERT INTO settings VALUES(?,?,?)',(uid,'2026 秋季学期'+(' · 演示' if demo else ''),'2026-09-07'))
        audit_log.record(c,{'name':'系统'},'create','user',str(uid),'通过命令行创建账户',owner_id=uid,
                         changes=[dict(field='name',before=None,after=name),dict(field='admin',before=None,after=first)])
        if demo:
            for title,cat,date,due,notes in [('高等数学 · 第二次习题','课程','2026-09-16','2026-09-18T23:00','完成习题 2.1–2.4，整理易错题'),('英语阅读与讨论','课程','2026-09-15','','课前阅读并记录三个讨论问题'),('科研周会','科研','2026-09-17','2026-09-17T15:00','整理本周进展和下一步计划'),('图书馆自习','个人','2026-09-19','','留两小时复盘本周课程'),('期中复习计划','考试','2026-10-26','','整理重点与练习题'),('期末考试准备','考试','2026-12-28','','示例任务：请按真实考试安排修改')]:
                c.execute('INSERT INTO tasks(id,user_id,title,category,date,due,notes,done,version,end_date) VALUES(?,?,?,?,?,?,?,?,1,?)',(secrets.token_hex(8),uid,title,cat,date,due,notes,0,date))
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def send(self,status,data,ctype='application/json',cookie=None,headers=None):
        # Never acknowledge a database change until both it and its audit event commit.
        if getattr(self,'_defer_response',False):
            self._response=(status,data,ctype,cookie,headers)
            return
        body=json.dumps(data,ensure_ascii=False).encode() if ctype.startswith('application/json') else data
        if isinstance(body,str): body=body.encode()
        self.send_response(status); self.send_header('Content-Type',ctype); self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control','no-store'); self.send_header('X-Content-Type-Options','nosniff'); self.send_header('X-Frame-Options','DENY')
        self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.send_header('X-Request-ID',getattr(self,'_request_id',''))
        for item in ([cookie] if isinstance(cookie,str) else cookie or []): self.send_header('Set-Cookie',item)
        for key,value in (headers or {}).items(): self.send_header(key,value)
        self.end_headers(); self.wfile.write(body)
    def session(self,c):
        return authentication.session(c,self.headers.get('Cookie',''))
    @contextmanager
    def database(self,method,path):
        c=connect()
        try:
            if method!='GET': c.execute('BEGIN IMMEDIATE')
            yield c
            response=getattr(self,'_response',None)
            if self._audit_before is not None and response and 200<=response[0]<300:
                audit_log.record_changes(c,self._audit_before,self._audit_actor,self._request_id,path)
            if self._management_grant and response and 200<=response[0]<300:
                actor,started=self._management_grant
                since=dt.datetime.fromtimestamp(started,dt.timezone.utc).isoformat()
                if not c.execute("SELECT 1 FROM audit_events WHERE actor_id=? AND action='management_verified' AND created_at>=?",(actor['id'],since)).fetchone():
                    audit_log.record(c,actor,'management_verified','auth',str(actor['id']),'进入管理工作区',owner_id=actor['id'],request_id=self._request_id)
            c.commit()
        except BaseException:
            c.rollback()
            raise
        finally:
            c.close()
    def password_proof(self,actor,s,data):
        supplied=data.get('current_password')
        if supplied is None: return authentication.fresh(s)
        return isinstance(supplied,str) and 12<=len(supplied)<=256 and hmac.compare_digest(password_hash(supplied,actor['salt']),actor['password'])
    def do_GET(self): self.handle_request('GET')
    def do_POST(self): self.handle_request('POST')
    def do_PUT(self): self.handle_request('PUT')
    def do_DELETE(self): self.handle_request('DELETE')
    def handle_request(self,method):
        self._request_id=secrets.token_hex(12);self._defer_response=True;self._response=None
        self._audit_before=None;self._audit_actor=None;self._api_reader=None;self._management_grant=None
        started=time.monotonic()
        try: self.route(method)
        except (ValueError,KeyError,TypeError,json.JSONDecodeError):
            self.send(400,{'error':'数据格式不正确，请检查日期及必填项','request_id':self._request_id})
        except Exception:
            logging.exception('request_failed request_id=%s method=%s path=%s',self._request_id,method,self.path.split('?')[0])
            self.send(500,{'error':'服务器处理失败，请重试','request_id':self._request_id})
        self._defer_response=False
        response=self._response or (404,{'error':'未找到'},'application/json',None,None)
        endpoint=DASHBOARD_PATHS.get(self.path.split('?')[0])
        if endpoint:
            # Read telemetry is independent: it survives projection errors and cannot break the API.
            duration_ms=(time.monotonic()-started)*1000
            try:
                with closing(connect()) as c, c:
                    c.execute('PRAGMA busy_timeout=250')
                    api_reads.record(c,request_id=self._request_id,endpoint=endpoint,method=method,
                                     status=response[0],duration_ms=duration_ms,viewer=self._api_reader,
                                     result=response[1] if 200<=response[0]<300 else None)
            except Exception:
                logging.exception('api_read_log_failed request_id=%s endpoint=%s',self._request_id,endpoint)
        try: self.send(*response)
        except (BrokenPipeError,ConnectionResetError): pass
        if response[0]>=400:
            logging.warning('request_result request_id=%s method=%s path=%s status=%s elapsed_ms=%d',self._request_id,method,self.path.split('?')[0],response[0],round((time.monotonic()-started)*1000))
    def route(self,method):
        path=self.path.split('?')[0]
        if path=='/source.zip' and method=='GET':
            source=ROOT/'release-source.zip'
            if source.is_file():
                self.send(200,source.read_bytes(),'application/zip',headers={'Content-Disposition':'attachment; filename="semester-planner-source.zip"'})
            else: self.send(404,{'error':'当前环境未生成发布源码包'})
            return
        if path in DASHBOARD_PATHS and method!='GET':
            self.send(405,{'error':'只支持读取'}); return
        assets={'/':'next/index.html', '/next':'next/index.html', '/next/':'next/index.html',
                '/legacy':'legacy/index.html', '/legacy/':'legacy/index.html',
                '/m':'mobile/index.html', '/m/':'mobile/index.html',
                '/timetables':'timetables/index.html', '/timetables/':'timetables/index.html',
                '/setup':'setup/index.html', '/setup/':'setup/index.html',
                '/mobile-entry.js':'mobile-entry.js'}
        for prefix,names in [('',('app.js','style.css','icon.svg','share.js','export.js','export.css','deferred.js','deferred.css','task-conflicts.js','task-conflicts.css','course-lists.js','course-lists.css','management.js','management.css')),
                             ('legacy/',('app.js','style.css','icon.svg','share.js','transition.css')),
                             ('next/',('app.js','style.css','icons.js','hints.js','theme.js','paint.css','workload.js','workload.css','export-entry.js','deferred.js','modal-shell.js','modal-shell.css','dialog-effects.js','dialog-effects.css','workspace.js','workspace.css')),
                             ('m/',('app.js','domain.js','tasks.js','courses.js','manage.js','style.css','export-entry.js')),
                             ('setup/',('setup.js','setup.css')),
                             ('timetables/',('app.js','domain.js','style.css','embed.css'))]:
            assets.update({'/'+prefix+name:('mobile/' if prefix=='m/' else prefix)+name for name in names})
        if method=='GET' and path in assets:
            f=ROOT/'static'/assets[path]
            ctype={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
                   '.css':'text/css; charset=utf-8','.svg':'image/svg+xml'}[f.suffix]
            self.send(200,f.read_bytes(),ctype); return
        data={}
        if method!='GET':
            if self.headers.get('Content-Type','').split(';')[0]!='application/json': self.send(415,{'error':'需要 JSON 请求'}); return
            length=int(self.headers.get('Content-Length','0'))
            course_request=path.startswith(('/api/timetables','/api/course-plan'))
            if length>(262144 if course_request else 65536): self.send(413,{'error':'请求过大'}); return
            data=json.loads(self.rfile.read(length) or b'{}')
            if not isinstance(data,dict): raise ValueError()
        with self.database(method,path) as c:
            if path in DASHBOARD_PATHS:
                auth=self.headers.get('Authorization','')
                if not auth.startswith('Bearer ') or not re.fullmatch(r'[A-Za-z0-9_-]{40,128}',auth[7:]):
                    self.send(401,{'error':'无效的 dashboard 凭据'}); return
                digest=hashlib.sha256(auth[7:].encode()).hexdigest()
                viewer=c.execute('SELECT * FROM viewers WHERE dashboard_token_hash=?',(digest,)).fetchone()
                if viewer:
                    name=c.execute('SELECT name FROM users WHERE id=?',(viewer['user_id'],)).fetchone()
                    self._api_reader=dict(user_id=viewer['user_id'],owner_id=viewer['owner_id'],name=name['name'] if name else '')
                if not viewer or not viewer['active']:
                    self.send(401,{'error':'无效的 dashboard 凭据'}); return
                self.send(200,dashboard_meta(c,viewer) if path.endswith('/meta') else dashboard_agenda(c,viewer,self.path)); return
            if path=='/api/login' and method=='POST':
                status,body,cookies=authentication.login(c,data,self.headers.get('Cookie',''),self.client_address[0],self._request_id)
                self.send(status,body,cookie=cookies);return
            s=self.session(c)
            if not s: self.send(401,{'error':'请先登录'}); return
            uid=s['user_id']
            if method!='GET' and not hmac.compare_digest(self.headers.get('X-CSRF-Token',''),s['csrf']): self.send(403,{'error':'会话校验失败，请刷新页面'}); return
            actor=c.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone()
            if not actor:
                self.send(401,{'error':'账户已失效，请重新登录'});return
            viewer=c.execute('SELECT * FROM viewers WHERE user_id=?',(uid,)).fetchone()
            if viewer and not viewer['active']:
                self.send(401,{'error':'展示账户已停用，请退出'});return
            if authentication.setup_required(c,actor) and (path,method) not in {('/api/auth/context','GET'),('/api/auth/setup','POST'),('/api/logout','POST')}:
                self.send(403,{'error':'请先打开 /setup/ 设置强密码和 PIN','code':'auth_setup_required','setup_required':True,'setup_url':'/setup/'});return
            viewer_auth=path in ('/api/auth/verify','/api/auth/password','/api/auth/context','/api/auth/setup','/api/auth/pin','/api/auth/devices') or bool(re.fullmatch(r'/api/auth/devices/[A-Za-z0-9_-]{1,128}',path))
            if viewer and not viewer_auth and (path,method) not in {('/api/state','GET'),('/api/view-export','GET'),('/api/export-preview','POST'),('/api/password','POST'),('/api/username','POST'),('/api/logout','POST')}:
                self.send(403,{'error':'展示账户只能查看获准分享的内容'});return
            self._audit_actor=actor
            if method!='GET' and not path.startswith(('/api/auth/','/api/admin/')):
                self._audit_before=audit_log.capture(c,path,actor)
            auth_response=authentication.route(c,actor,s,method,path,data,self.headers.get('Cookie',''),self.client_address[0],self._request_id)
            if auth_response is not None:
                status,body,cookies=auth_response;self.send(status,body,cookie=cookies);return
            ensure_categories(c,uid)
            if path=='/api/password' and method=='POST':
                status,body,cookies=authentication.route(c,actor,s,method,'/api/auth/password',data,self.headers.get('Cookie',''),self.client_address[0],self._request_id)
                self.send(status,body,cookie=cookies);return
            elevated=authentication.admin_active(actor,s)
            reads_response=api_reads.route(c,actor,elevated,method,path,self.path)
            if reads_response is not None:
                if elevated:
                    authentication.touch_admin(c,actor,s);self._management_grant=(actor,s['admin_started'])
                status,body,ctype,headers=reads_response;self.send(status,body,ctype,headers=headers);return
            audit_response=audit_log.route(c,actor,elevated,method,path,self.path,DB)
            if audit_response is not None:
                if elevated: authentication.touch_admin(c,actor,s)
                if elevated and (path=='/api/admin/storage' or parse_qs(urlsplit(self.path).query).get('scope')==['all']): self._management_grant=(actor,s['admin_started'])
                status,body,ctype,headers=audit_response;self.send(status,body,ctype,headers=headers);return
            admin_request=(path=='/api/users' or path=='/api/shares' and method=='POST' or path=='/api/timetables' and method=='POST' or bool(re.fullmatch(r'/api/timetables/[^/]+/(permissions|copy|archive)',path)))
            if actor['admin'] and method=='PUT' and (path=='/api/timetable' or path.startswith('/api/timetables/')): admin_request=True
            if admin_request and not elevated:
                self.send(403,{'error':'请使用强密码解锁管理功能','code':'management_auth_required'});return
            if elevated and (admin_request or path.startswith('/api/timetables/') and method!='GET'):
                authentication.touch_admin(c,actor,s)
                self._management_grant=(actor,s['admin_started'])
            # A PIN session must never inherit administrator shortcuts in older course APIs.
            actor=dict(actor);actor['admin']=int(elevated)
            course_response=course_plans.route(c,actor,method,path,data)
            if course_response is not None:
                self.send(*course_response);return
            if path=='/api/export-preview' and method=='POST':
                if not isinstance(data,dict):raise ValueError()
                target=viewer
                if data.get('preview_id') is not None:
                    if viewer:self.send(403,{'error':'不能预览他人的分享'});return
                    target=c.execute('SELECT * FROM viewers WHERE user_id=? AND owner_id=?',(int(data['preview_id']),uid)).fetchone()
                    if not target:self.send(403,{'error':'不能预览他人的分享'});return
                source=shared_state(c,target,export_keys=True) if target else private_state(c,uid)
                if target and (data.get('format','image')!='image' or not source['share']['export']):
                    self.send(403,{'error':'当前分享未允许此项导出'});return
                self.send(200,project_export(source,data));return
            if path=='/api/users' and method=='GET':
                if not actor['admin']:
                    self.send(403,{'error':'仅管理员可查看账户汇总'});return
                rows=c.execute('SELECT u.id,u.name,u.remark,u.admin,u.root_admin,v.owner_id,v.active,v.policy,o.name AS owner_name FROM users u LEFT JOIN viewers v ON v.user_id=u.id LEFT JOIN users o ON o.id=v.owner_id ORDER BY u.admin DESC,u.id').fetchall()
                accounts=[]
                for row in rows:
                    item=dict(row);policy=json.loads(item.pop('policy') or '{}')
                    item['role']='viewer' if item['owner_id'] is not None else 'admin' if item['admin'] else 'user'
                    item['sharing_enabled']=bool(item['active'] and policy.get('enabled'))
                    accounts.append(item)
                self.send(200,{'accounts':accounts});return
            if path in ('/api/state','/api/view-export') and method=='GET':
                result=shared_state(c,viewer) if viewer else private_state(c,uid)
                if path=='/api/view-export' and viewer and not result['share']['export']:
                    self.send(403,{'error':'日程所有者未开放图片导出'});return
                result['user']['id']=uid;result['user']['root_admin']=bool(self._audit_actor['root_admin'])
                result['csrf']=s['csrf'];result['auth']=authentication.context(c,self._audit_actor,s);self.send(200,result);return
            if path.startswith('/api/share-preview/') and method=='GET':
                target=c.execute('SELECT * FROM viewers WHERE user_id=? AND owner_id=?',(int(path.rsplit('/',1)[1]),uid)).fetchone()
                if not target:self.send(403,{'error':'不能预览他人的分享'});return
                result=shared_state(c,target);result['csrf']=s['csrf'];result['preview']=True
                self.send(200,result);return
            if path=='/api/shares' and method=='GET':
                rows=c.execute('SELECT v.*,u.name FROM viewers v JOIN users u ON u.id=v.user_id WHERE v.owner_id=?',(uid,)).fetchall()
                result={'shares':[dict(id=r['user_id'],name=r['name'],active=bool(r['active']),version=r['version'],policy=json.loads(r['policy']),dashboard_token_enabled=bool(r['dashboard_token_hash'])) for r in rows]}
                if actor['admin']:
                    result['owners']=[dict(r) for r in c.execute('SELECT id,name FROM users WHERE id NOT IN (SELECT user_id FROM viewers)')]
                    result['accounts']=[dict(r) for r in c.execute('SELECT v.user_id AS id,u.name,v.owner_id,v.active FROM viewers v JOIN users u ON u.id=v.user_id')]
                self.send(200,result);return
            if path=='/api/dashboard-token' and method=='POST':
                target=c.execute('SELECT * FROM viewers WHERE user_id=? AND owner_id=?',(data.get('id'),uid)).fetchone()
                if not target: self.send(403,{'error':'只能管理绑定给自己的展示账户'}); return
                if data.get('action') not in ('rotate','revoke'): raise ValueError()
                key='dashboard-token:'+str(uid);now=time.time()
                c.execute('DELETE FROM attempts WHERE time<?',(now-900,))
                if c.execute('SELECT count(*) FROM attempts WHERE ip=?',(key,)).fetchone()[0]>=8:
                    self.send(429,{'error':'验证次数过多，请稍后重试'}); return
                if not self.password_proof(actor,s,data):
                    c.execute('INSERT INTO attempts VALUES(?,?)',(key,now))
                    self.send(403,{'error':'请使用强密码验证身份','code':'password_required' if data.get('current_password') is None else 'invalid_password'}); return
                token=secrets.token_urlsafe(32) if data['action']=='rotate' else None
                c.execute('UPDATE viewers SET dashboard_token_hash=? WHERE user_id=?',
                          (hashlib.sha256(token.encode()).hexdigest() if token else None,target['user_id']))
                audit_log.record(c,self._audit_actor,'token_'+data['action'],'security',str(target['user_id']),'生成／轮换 Dashboard Token' if token else '撤销 Dashboard Token',owner_id=uid,request_id=self._request_id)
                self.send(200,{'ok':True,'token':token});return
            if path=='/api/shares' and method=='PUT':
                target=c.execute('SELECT * FROM viewers WHERE user_id=? AND owner_id=?',(data.get('id'),uid)).fetchone()
                if not target:self.send(403,{'error':'只能配置绑定给自己的展示账户'});return
                names=[r[0] for r in c.execute('SELECT name FROM categories WHERE user_id=?',(uid,))]
                policy=validate_policy(data.get('policy'),names)
                cur=c.execute('UPDATE viewers SET policy=?,version=version+1 WHERE user_id=? AND version=?',(json.dumps(policy),target['user_id'],data.get('version')))
                if not cur.rowcount:self.send(409,{'error':'分享设置已变化，请重新打开后编辑'});return
                self.send(200,{'ok':True});return
            if path=='/api/shares' and method=='POST':
                if not actor['admin']:self.send(403,{'error':'仅管理员可创建或绑定展示账户'});return
                key='account:'+str(uid);now=time.time()
                c.execute('DELETE FROM attempts WHERE time<?',(now-900,))
                if c.execute('SELECT count(*) FROM attempts WHERE ip=?',(key,)).fetchone()[0]>=8:self.send(429,{'error':'验证次数过多，请稍后重试'});return
                if not self.password_proof(actor,s,data):
                    c.execute('INSERT INTO attempts VALUES(?,?)',(key,now));self.send(403,{'error':'请使用强密码验证身份','code':'password_required' if data.get('current_password') is None else 'invalid_password'});return
                action=data.get('action')
                if action in ('create','rebind'):
                    owner=c.execute('SELECT id FROM users WHERE id=? AND id NOT IN (SELECT user_id FROM viewers)',(data.get('owner_id'),)).fetchone()
                    if not owner:self.send(400,{'error':'请选择有效的日程所有者'});return
                if action=='create':
                    name=str(data.get('name','')).strip();password=data.get('password','')
                    if not 1<=len(name)<=64 or any(x.isspace() for x in name) or not isinstance(password,str) or not 12<=len(password)<=256:raise ValueError()
                    if c.execute('SELECT 1 FROM users WHERE name=?',(name,)).fetchone():self.send(409,{'error':'用户名已存在，请使用新名称'});return
                    salt=secrets.token_hex(16)
                    target=c.execute('INSERT INTO users(name,salt,password,admin) VALUES(?,?,?,0)',(name,salt,password_hash(password,salt))).lastrowid
                    c.execute('INSERT INTO viewers(user_id,owner_id,policy) VALUES(?,?,?)',(target,owner['id'],json.dumps(DEFAULT_POLICY)))
                    c.execute('INSERT INTO settings SELECT ?,name,start FROM settings WHERE user_id=?',(target,owner['id']))
                elif action in ('rebind','active'):
                    target=data.get('id')
                    if not c.execute('SELECT 1 FROM viewers WHERE user_id=?',(target,)).fetchone():self.send(404,{'error':'展示账户不存在'});return
                    if action=='rebind':c.execute('UPDATE viewers SET owner_id=?,policy=?,dashboard_token_hash=NULL,version=version+1 WHERE user_id=?',(owner['id'],json.dumps(DEFAULT_POLICY),target))
                    else:
                        if type(data.get('active')) is not bool:raise ValueError()
                        c.execute('UPDATE viewers SET active=?,version=version+1 WHERE user_id=?',(int(data['active']),target))
                    c.execute('DELETE FROM sessions WHERE user_id=?',(target,))
                else:raise ValueError()
                self.send(200,{'ok':True});return
            if path=='/api/categories' and method=='POST':
                action=data.get('action');name=str(data.get('name','')).strip();old=data.get('old');color=data.get('color','')
                if action in ('create','edit'):
                    if not 1<=len(name)<=20 or not isinstance(color,str) or not re.fullmatch(r'#[0-9a-fA-F]{6}',color):raise ValueError()
                    if c.execute('SELECT 1 FROM categories WHERE user_id=? AND name=?',(uid,name)).fetchone() and (action=='create' or name!=old):self.send(409,{'error':'分类名称已存在'});return
                    existing=c.execute('SELECT warn_days,urgent_days FROM categories WHERE user_id=? AND name=?',(uid,old)).fetchone()
                    try:
                        warn=int(data.get('warn_days',existing['warn_days'] if existing else 7));urgent=int(data.get('urgent_days',existing['urgent_days'] if existing else 2))
                    except (ValueError,TypeError):raise ValueError()
                    if not 0<=urgent<=warn<=3650:
                        self.send(400,{'error':'请设置 0 ≤ 红色天数 ≤ 黄色天数 ≤ 3650'});return
                    if action=='create':
                        if c.execute('SELECT count(*) FROM categories WHERE user_id=?',(uid,)).fetchone()[0]>=20:self.send(400,{'error':'最多 20 个分类'});return
                        c.execute('INSERT INTO categories(user_id,name,color,warn_days,urgent_days) VALUES(?,?,?,?,?)',(uid,name,color,warn,urgent))
                    else:
                        if not c.execute('UPDATE categories SET name=?,color=?,warn_days=?,urgent_days=? WHERE user_id=? AND name=?',(name,color,warn,urgent,uid,old)).rowcount:self.send(409,{'error':'分类已变化，请刷新'});return
                        if name!=old:drop_category_permissions(c,uid,old)
                        c.execute('UPDATE tasks SET category=?,version=version+1 WHERE user_id=? AND category=?',(name,uid,old))
                elif action=='delete':
                    target=data.get('target')
                    if target==name or not c.execute('SELECT 1 FROM categories WHERE user_id=? AND name=?',(uid,target)).fetchone():self.send(400,{'error':'请选择另一个分类接收任务'});return
                    c.execute('UPDATE tasks SET category=?,version=version+1 WHERE user_id=? AND category=?',(target,uid,name))
                    drop_category_permissions(c,uid,name)
                    c.execute('DELETE FROM categories WHERE user_id=? AND name=?',(uid,name))
                else:raise ValueError()
                self.send(200,{'ok':True});return
            if path=='/api/profile' and method=='PUT':
                remark=data.get('remark')
                if not isinstance(remark,str) or len(remark)>60:raise ValueError()
                c.execute('UPDATE users SET remark=? WHERE id=?',(remark.strip(),uid));self.send(200,{'ok':True});return
            if path=='/api/journal' and method=='PUT':
                date=dt.date.fromisoformat(data['date']).isoformat();body=data.get('body');version=data.get('version')
                if not isinstance(body,str) or len(body)>10000 or not isinstance(version,int):raise ValueError()
                old=c.execute('SELECT version FROM journal WHERE user_id=? AND date=?',(uid,date)).fetchone()
                if old:
                    cur=c.execute('UPDATE journal SET body=?,version=version+1 WHERE user_id=? AND date=? AND version=?',(body,uid,date,version))
                    if not cur.rowcount:self.send(409,{'error':'这天的手记已在其他页面修改，请保留当前文字并刷新后重试'});return
                else:
                    if version!=0:self.send(409,{'error':'手记版本已变化，请刷新'});return
                    try:c.execute('INSERT INTO journal VALUES(?,?,?,1)',(uid,date,body))
                    except sqlite3.IntegrityError:self.send(409,{'error':'手记已在其他页面创建，请刷新'});return
                self.send(200,{'ok':True});return
            if path in ('/api/users','/api/username') and method=='POST':
                actor=c.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone()
                if path=='/api/users' and not actor['admin']:
                    self.send(403,{'error':'仅管理员可管理账户'}); return
                key='account:'+str(uid); now=time.time()
                c.execute('DELETE FROM attempts WHERE time<?',(now-900,))
                if c.execute('SELECT count(*) FROM attempts WHERE ip=?',(key,)).fetchone()[0]>=8:
                    self.send(429,{'error':'验证次数过多，请 15 分钟后重试'}); return
                if not self.password_proof(actor,s,data):
                    c.execute('INSERT INTO attempts VALUES(?,?)',(key,now));self.send(403,{'error':'请使用强密码验证身份','code':'password_required' if data.get('current_password') is None else 'invalid_password'});return
                if path=='/api/username':
                    name=data.get('name')
                    if not isinstance(name,str) or not 1<=len(name)<=64 or any(ch.isspace() or ord(ch)<32 or ord(ch)==127 for ch in name):
                        self.send(400,{'error':'用户名为 1–64 位，不能包含空白或控制字符'});return
                    if c.execute('SELECT 1 FROM users WHERE name=? AND id<>?',(name,uid)).fetchone():
                        self.send(409,{'error':'用户名已存在，请换一个'});return
                    try:c.execute('UPDATE users SET name=? WHERE id=?',(name,uid))
                    except sqlite3.IntegrityError:
                        self.send(409,{'error':'用户名已存在，请换一个'});return
                    self.send(200,{'ok':True,'name':name});return
                password=data.get('password','')
                minimum=12
                if not isinstance(password,str) or not minimum<=len(password)<=256:
                    self.send(400,{'error':f'该账户新密码长度应为 {minimum}–256 位'});return
                salt=secrets.token_hex(16); hashed=password_hash(password,salt)
                target=uid
                if path=='/api/users':
                    name=str(data.get('name','')).strip()
                    if not 1<=len(name)<=64 or any(ch.isspace() for ch in name):
                        self.send(400,{'error':'用户名为 1–64 位，不能包含空白'});return
                    existing=c.execute('SELECT id,root_admin FROM users WHERE name=?',(name,)).fetchone()
                    if data.get('action')=='create':
                        if existing:self.send(409,{'error':'用户名已存在'});return
                        target=c.execute('INSERT INTO users(name,salt,password,admin) VALUES(?,?,?,0)',(name,salt,hashed)).lastrowid
                        settings=c.execute('SELECT name,start FROM settings WHERE user_id=?',(uid,)).fetchone()
                        c.execute('INSERT INTO settings VALUES(?,?,?)',(target,settings['name'],settings['start']))
                        self.send(200,{'ok':True,'reauth':False});return
                    if data.get('action')!='reset' or not existing:
                        self.send(400,{'error':'请检查操作类型和用户名'});return
                    if existing['root_admin']:
                        self.send(403,{'error':'根管理员只能通过本人账户设置修改密码','code':'root_administrator_protected'});return
                    target=existing['id']
                c.execute('UPDATE users SET salt=?,password=? WHERE id=?',(salt,hashed,target))
                c.execute('DELETE FROM sessions WHERE user_id=?',(target,))
                c.execute('DELETE FROM user_auth WHERE user_id=?',(target,))
                c.execute('UPDATE trusted_devices SET revoked=1 WHERE user_id=?',(target,))
                audit_log.record(c,self._audit_actor,'password_reset','security',str(target),'管理员重置账户密码',owner_id=target,request_id=self._request_id)
                self.send(200,{'ok':True,'reauth':target==uid});return
            if path=='/api/logout' and method=='POST':
                audit_log.record(c,self._audit_actor,'logout','auth',str(uid),'退出登录',owner_id=uid,request_id=self._request_id)
                c.execute('DELETE FROM sessions WHERE token=?',(s['token'],)); self.send(200,{'ok':True},cookie='session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return
            if path=='/api/settings' and method=='PUT':
                start=dt.date.fromisoformat(data['start']); name=str(data['name']).strip()
                if start.weekday()!=0 or not 1<=len(name)<=80: raise ValueError()
                previous_start=c.execute('SELECT start FROM settings WHERE user_id=?',(uid,)).fetchone()['start']
                if previous_start!=start.isoformat():
                    course_plans.preserve_occurrences(c,uid,previous_start)
                    course_plans.bump_version(c,uid)
                c.execute('UPDATE settings SET name=?,start=? WHERE user_id=?',(name,start.isoformat(),uid)); self.send(200,{'ok':True}); return
            if path=='/api/tasks' and method=='POST' or path.startswith('/api/tasks/') and method=='PUT':
                existing=c.execute('SELECT * FROM tasks WHERE id=? AND user_id=?',(path.rsplit('/',1)[1],uid)).fetchone() if method=='PUT' else None
                if method=='PUT' and (not existing or data.get('version')!=existing['version']):
                    self.send(409,{'error':'任务已被其他页面修改，请刷新后重试'});return
                if type(data.get('force_complete',False)) is not bool: raise ValueError()
                deferred=data.get('deferred',bool(existing['deferred']) if existing else False)
                if type(deferred) is not bool: raise ValueError()
                title=str(data['title']).strip();category=data.get('category','课程');notes=str(data.get('notes',''))
                done=bool(data.get('done',False))
                if deferred and (done or existing and existing['done']): raise ValueError('已完成任务不能暂缓')
                short_title=data.get('short_title',existing['short_title'] if existing else '')
                if not isinstance(short_title,str) or len(short_title)>40: raise ValueError()
                short_title=short_title.strip()
                if not 1<=len(title)<=120 or len(notes)>4000 or not c.execute('SELECT 1 FROM categories WHERE user_id=? AND name=?',(uid,category)).fetchone(): raise ValueError()
                if existing: previous=json.loads(existing['previous_schedule'])
                else: previous=validate_previous_schedule(data.get('previous_schedule',{})) if deferred else {}
                deferred_at=existing['deferred_at'] if existing else ''
                if deferred:
                    if existing and not existing['deferred']:
                        previous={k:existing[k] for k in SCHEDULE_FIELDS}
                        previous['milestones']=json.loads(existing['milestones'])
                    if not existing or not existing['deferred']:
                        deferred_at=dt.datetime.now(dt.timezone.utc).isoformat()
                        if not existing and data.get('deferred_at'):
                            moment=dt.datetime.fromisoformat(data['deferred_at'])
                            if moment.tzinfo is None: raise ValueError()
                            deferred_at=moment.astimezone(dt.timezone.utc).isoformat()
                    schedule={k:'' for k in SCHEDULE_FIELDS};nodes=[]
                else:
                    if existing and existing['deferred'] and not {'due','milestones'}<=data.keys(): raise ValueError('请明确提交新的截止和节点安排')
                    schedule=validate_schedule(data)
                    nodes=validate_milestones(data.get('milestones',json.loads(existing['milestones']) if existing else []))
                    deferred_at=''
                if existing and not existing['done'] and done and not data.get('force_complete',False):
                    unfinished=sum(not node['done'] for node in nodes)
                    if unfinished:
                        self.send(409,{'code':'unfinished_milestones','error':f'任务仍有 {unfinished} 个未完成节点。强制完成只结束任务，节点保留原状态。'});return
                values=(title,category,schedule['date'],schedule['end_date'],schedule['start_time'],schedule['end_time'],schedule['due'],notes,int(done),json.dumps(nodes,ensure_ascii=False),short_title,int(deferred),deferred_at,json.dumps(previous,ensure_ascii=False))
                if method=='POST':
                    c.execute('INSERT INTO tasks(title,category,date,end_date,start_time,end_time,due,notes,done,milestones,short_title,deferred,deferred_at,previous_schedule,id,user_id,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)',values+(secrets.token_hex(8),uid))
                else:
                    cur=c.execute('UPDATE tasks SET title=?,category=?,date=?,end_date=?,start_time=?,end_time=?,due=?,notes=?,done=?,milestones=?,short_title=?,deferred=?,deferred_at=?,previous_schedule=?,version=version+1 WHERE id=? AND user_id=? AND version=?',values+(existing['id'],uid,data['version']))
                    if cur.rowcount==0: self.send(409,{'error':'任务已被其他页面修改，请刷新后重试'});return
                self.send(200,{'ok':True}); return
            if path.startswith('/api/tasks/') and method=='DELETE':
                existing=c.execute('SELECT * FROM tasks WHERE id=? AND user_id=?',(path.rsplit('/',1)[1],uid)).fetchone()
                if not existing or data.get('version')!=existing['version']:
                    self.send(409,{'error':'任务已变化，请刷新'});return
                if type(data.get('force_delete',False)) is not bool: raise ValueError()
                if not existing['deferred'] and not data.get('force_delete',False):
                    self.send(409,{'code':'task_not_deferred','error':'任务尚未暂缓，删除存在冲突。强制删除将直接删除任务及其节点，删除后可使用撤销恢复。'});return
                cur=c.execute('DELETE FROM tasks WHERE id=? AND user_id=? AND version=?',(path.rsplit('/',1)[1],uid,data['version']))
                self.send(200 if cur.rowcount else 409,{'ok':True} if cur.rowcount else {'error':'任务已变化，请刷新'}); return
            self.send(404,{'error':'未找到'})
def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--host',default='127.0.0.1'); parser.add_argument('--port',type=int,default=8765); parser.add_argument('--create-user'); parser.add_argument('--demo',action='store_true'); args=parser.parse_args(); init()
    if args.create_user: create_user(args.create_user,getpass.getpass('Password (12+ characters): ')); return
    if args.demo:
        with closing(connect()) as c: exists=c.execute("SELECT 1 FROM users WHERE name='demo'").fetchone()
        if not exists: create_user('demo','SemesterDemo2026!',True)
    logging.basicConfig(level=logging.INFO,format='%(asctime)s %(levelname)s %(message)s')
    print(f'Listening on http://{args.host}:{args.port}',flush=True); ThreadingHTTPServer((args.host,args.port),Handler).serve_forever()
if __name__=='__main__': main()
