import re, argparse, datetime as dt, getpass, hashlib, hmac, http.cookies, json, os, secrets, sqlite3, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from sharing import init_sharing, DEFAULT_POLICY, validate_policy, private_state, shared_state, drop_category_permissions
ROOT=Path(__file__).resolve().parent
DB=Path(os.environ.get('PLANNER_DB', ROOT/'data/planner.db'))
def connect():
    DB.parent.mkdir(parents=True,exist_ok=True)
    c=sqlite3.connect(DB); c.row_factory=sqlite3.Row; c.execute('PRAGMA foreign_keys=ON'); return c
def init():
    with connect() as c:
        c.executescript('''CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT UNIQUE, salt TEXT, password TEXT);
        CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER,csrf TEXT,expires REAL);
        CREATE TABLE IF NOT EXISTS attempts(ip TEXT,time REAL);
        CREATE TABLE IF NOT EXISTS settings(user_id INTEGER PRIMARY KEY,name TEXT,start TEXT);
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,user_id INTEGER,title TEXT,category TEXT,date TEXT,due TEXT,notes TEXT,done INTEGER,version INTEGER);''')
        c.executescript('CREATE TABLE IF NOT EXISTS timetable_template(id INTEGER PRIMARY KEY, data TEXT); CREATE TABLE IF NOT EXISTS user_timetable(user_id INTEGER PRIMARY KEY, data TEXT);')
        if not c.execute('SELECT 1 FROM timetable_template WHERE id=1').fetchone():
            seed=ROOT/'timetable.json'
            c.execute('INSERT INTO timetable_template VALUES(1,?)',(seed.read_text() if seed.exists() else '[]',))
        c.execute('CREATE TABLE IF NOT EXISTS journal(user_id INTEGER,date TEXT,body TEXT,version INTEGER,PRIMARY KEY(user_id,date))')
        if 'end_date' not in [r['name'] for r in c.execute('PRAGMA table_info(tasks)')]:
            c.execute('ALTER TABLE tasks ADD COLUMN end_date TEXT')
            c.execute('UPDATE tasks SET end_date=date')
        for field in ('start_time','end_time'):
            if field not in [r['name'] for r in c.execute('PRAGMA table_info(tasks)')]:
                c.execute(f"ALTER TABLE tasks ADD COLUMN {field} TEXT NOT NULL DEFAULT ''")
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
def ensure_categories(c,uid):
    if not c.execute('SELECT 1 FROM categories WHERE user_id=?',(uid,)).fetchone():
        c.executemany('INSERT INTO categories(user_id,name,color) VALUES(?,?,?)',[(uid,n,k) for n,k in [('课程','#7185bd'),('科研','#408f80'),('考试','#b88355'),('个人','#9775ae')]])
def password_hash(password,salt): return hashlib.scrypt(password.encode(),salt=bytes.fromhex(salt),n=16384,r=8,p=1).hex()
def create_user(name,password,demo=False):
    salt=secrets.token_hex(16)
    with connect() as c:
        first=c.execute('SELECT count(*) FROM users').fetchone()[0]==0
        if not (12 if first else 4)<=len(password)<=256: raise ValueError('管理员至少 12 位，普通账户至少 4 位')
        uid=c.execute('INSERT INTO users(name,salt,password,admin) VALUES(?,?,?,?)',(name,salt,password_hash(password,salt),int(first))).lastrowid
        c.execute('INSERT INTO settings VALUES(?,?,?)',(uid,'2026 秋季学期'+(' · 演示' if demo else ''),'2026-09-07'))
        if demo:
            for title,cat,date,due,notes in [('高等数学 · 第二次习题','课程','2026-09-16','2026-09-18T23:00','完成习题 2.1–2.4，整理易错题'),('英语阅读与讨论','课程','2026-09-15','','课前阅读并记录三个讨论问题'),('科研周会','科研','2026-09-17','2026-09-17T15:00','整理本周进展和下一步计划'),('图书馆自习','个人','2026-09-19','','留两小时复盘本周课程'),('期中复习计划','考试','2026-10-26','','整理重点与练习题'),('期末考试准备','考试','2026-12-28','','示例任务：请按真实考试安排修改')]:
                c.execute('INSERT INTO tasks(id,user_id,title,category,date,due,notes,done,version,end_date) VALUES(?,?,?,?,?,?,?,?,1,?)',(secrets.token_hex(8),uid,title,cat,date,due,notes,0,date))
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def send(self,status,data,ctype='application/json',cookie=None):
        body=json.dumps(data,ensure_ascii=False).encode() if ctype=='application/json' else data
        self.send_response(status); self.send_header('Content-Type',ctype); self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control','no-store'); self.send_header('X-Content-Type-Options','nosniff'); self.send_header('X-Frame-Options','DENY')
        self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        if cookie: self.send_header('Set-Cookie',cookie)
        self.end_headers(); self.wfile.write(body)
    def session(self,c):
        try:
            ck=http.cookies.SimpleCookie(self.headers.get('Cookie','')); token=ck['session'].value
        except (KeyError,http.cookies.CookieError): return None
        return c.execute('SELECT * FROM sessions WHERE token=? AND expires>?',(hashlib.sha256(token.encode()).hexdigest(),time.time())).fetchone()
    def do_GET(self): self.handle_request('GET')
    def do_POST(self): self.handle_request('POST')
    def do_PUT(self): self.handle_request('PUT')
    def do_DELETE(self): self.handle_request('DELETE')
    def handle_request(self,method):
        try: self.route(method)
        except (ValueError,KeyError,TypeError,json.JSONDecodeError): self.send(400,{'error':'数据格式不正确，请检查日期及必填项'})
        except Exception: self.send(500,{'error':'服务器处理失败，请重试'})
    def route(self,method):
        path=self.path.split('?')[0]
        if method=='GET' and path in ('/','/app.js','/style.css','/icon.svg','/share.js'):
            f=ROOT/'static'/({'/':'index.html'}.get(path,path[1:])); self.send(200,f.read_bytes(),{'/':'text/html; charset=utf-8','/app.js':'text/javascript; charset=utf-8','/style.css':'text/css; charset=utf-8','/icon.svg':'image/svg+xml','/share.js':'text/javascript; charset=utf-8'}[path]); return
        data={}
        if method!='GET':
            if self.headers.get('Content-Type','').split(';')[0]!='application/json': self.send(415,{'error':'需要 JSON 请求'}); return
            length=int(self.headers.get('Content-Length','0'))
            if length>65536: self.send(413,{'error':'请求过大'}); return
            data=json.loads(self.rfile.read(length) or b'{}')
            if not isinstance(data,dict): raise ValueError()
        with connect() as c:
            if path=='/api/login' and method=='POST':
                ip=self.client_address[0]; now=time.time(); c.execute('DELETE FROM attempts WHERE time<?',(now-900,))
                if c.execute('SELECT count(*) FROM attempts WHERE ip=?',(ip,)).fetchone()[0]>=8: self.send(429,{'error':'尝试过多，请 15 分钟后重试'}); return
                user=c.execute('SELECT * FROM users WHERE name=?',(str(data.get('name',''))[:100],)).fetchone()
                valid=hmac.compare_digest(password_hash(str(data.get('password',''))[:1024],user['salt'] if user else '00'*16),user['password'] if user else '0'*128)
                if not user or not valid: c.execute('INSERT INTO attempts VALUES(?,?)',(ip,now)); self.send(401,{'error':'账号或密码错误'}); return
                view=c.execute('SELECT active FROM viewers WHERE user_id=?',(user['id'],)).fetchone()
                if view and not view['active']:self.send(403,{'error':'该展示账户已停用'});return
                token=secrets.token_urlsafe(32); csrf=secrets.token_urlsafe(24)
                c.execute('DELETE FROM sessions WHERE expires<?',(now,)); c.execute('INSERT INTO sessions VALUES(?,?,?,?)',(hashlib.sha256(token.encode()).hexdigest(),user['id'],csrf,now+86400))
                self.send(200,{'ok':True},cookie='session='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400'+('; Secure' if os.environ.get('PLANNER_SECURE')=='1' else '')); return
            s=self.session(c)
            if not s: self.send(401,{'error':'请先登录'}); return
            uid=s['user_id']
            ensure_categories(c,uid)
            if method!='GET' and not hmac.compare_digest(self.headers.get('X-CSRF-Token',''),s['csrf']): self.send(403,{'error':'会话校验失败，请刷新页面'}); return
            actor=c.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone()
            viewer=c.execute('SELECT * FROM viewers WHERE user_id=?',(uid,)).fetchone()
            if viewer and not viewer['active']:
                self.send(401,{'error':'展示账户已停用，请退出'});return
            if viewer and (path,method) not in {('/api/state','GET'),('/api/view-export','GET'),('/api/password','POST'),('/api/username','POST'),('/api/logout','POST')}:
                self.send(403,{'error':'展示账户只能查看获准分享的内容'});return
            if path=='/api/users' and method=='GET':
                if not actor['admin']:
                    self.send(403,{'error':'仅管理员可查看账户汇总'});return
                rows=c.execute('SELECT u.id,u.name,u.remark,u.admin,v.owner_id,v.active,v.policy,o.name AS owner_name FROM users u LEFT JOIN viewers v ON v.user_id=u.id LEFT JOIN users o ON o.id=v.owner_id ORDER BY u.admin DESC,u.id').fetchall()
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
                result['csrf']=s['csrf'];self.send(200,result);return
            if path.startswith('/api/share-preview/') and method=='GET':
                target=c.execute('SELECT * FROM viewers WHERE user_id=? AND owner_id=?',(int(path.rsplit('/',1)[1]),uid)).fetchone()
                if not target:self.send(403,{'error':'不能预览他人的分享'});return
                result=shared_state(c,target);result['csrf']=s['csrf'];result['preview']=True
                self.send(200,result);return
            if path=='/api/shares' and method=='GET':
                rows=c.execute('SELECT v.*,u.name FROM viewers v JOIN users u ON u.id=v.user_id WHERE v.owner_id=?',(uid,)).fetchall()
                result={'shares':[dict(id=r['user_id'],name=r['name'],active=bool(r['active']),version=r['version'],policy=json.loads(r['policy'])) for r in rows]}
                if actor['admin']:
                    result['owners']=[dict(r) for r in c.execute('SELECT id,name FROM users WHERE id NOT IN (SELECT user_id FROM viewers)')]
                    result['accounts']=[dict(r) for r in c.execute('SELECT v.user_id AS id,u.name,v.owner_id,v.active FROM viewers v JOIN users u ON u.id=v.user_id')]
                self.send(200,result);return
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
                if not hmac.compare_digest(password_hash(str(data.get('current_password',''))[:1024],actor['salt']),actor['password']):
                    c.execute('INSERT INTO attempts VALUES(?,?)',(key,now));self.send(400,{'error':'管理员密码不正确'});return
                action=data.get('action')
                if action in ('create','rebind'):
                    owner=c.execute('SELECT id FROM users WHERE id=? AND id NOT IN (SELECT user_id FROM viewers)',(data.get('owner_id'),)).fetchone()
                    if not owner:self.send(400,{'error':'请选择有效的日程所有者'});return
                if action=='create':
                    name=str(data.get('name','')).strip();password=data.get('password','')
                    if not 1<=len(name)<=64 or any(x.isspace() for x in name) or not isinstance(password,str) or not 4<=len(password)<=256:raise ValueError()
                    if c.execute('SELECT 1 FROM users WHERE name=?',(name,)).fetchone():self.send(409,{'error':'用户名已存在，请使用新名称'});return
                    salt=secrets.token_hex(16)
                    target=c.execute('INSERT INTO users(name,salt,password,admin) VALUES(?,?,?,0)',(name,salt,password_hash(password,salt))).lastrowid
                    c.execute('INSERT INTO viewers(user_id,owner_id,policy) VALUES(?,?,?)',(target,owner['id'],json.dumps(DEFAULT_POLICY)))
                    c.execute('INSERT INTO settings SELECT ?,name,start FROM settings WHERE user_id=?',(target,owner['id']))
                elif action in ('rebind','active'):
                    target=data.get('id')
                    if not c.execute('SELECT 1 FROM viewers WHERE user_id=?',(target,)).fetchone():self.send(404,{'error':'展示账户不存在'});return
                    if action=='rebind':c.execute('UPDATE viewers SET owner_id=?,policy=?,version=version+1 WHERE user_id=?',(owner['id'],json.dumps(DEFAULT_POLICY),target))
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
            if path=='/api/timetable' and method=='GET':
                self.send(200,{'courses':json.loads(c.execute('SELECT data FROM timetable_template WHERE id=1').fetchone()[0])});return
            if path=='/api/timetable' and method=='POST':
                raw=c.execute('SELECT data FROM timetable_template WHERE id=1').fetchone()[0]
                c.execute('INSERT OR REPLACE INTO user_timetable VALUES(?,?)',(uid,raw));self.send(200,{'ok':True});return
            if path=='/api/timetable' and method=='PUT':
                if not c.execute('SELECT admin FROM users WHERE id=?',(uid,)).fetchone()[0]:self.send(403,{'error':'仅管理员可编辑公共课表'});return
                courses=data.get('courses')
                if not isinstance(courses,list) or len(courses)>100:raise ValueError()
                for x in courses:
                    if not isinstance(x,dict) or not all(isinstance(x.get(k),str) and len(x[k])<=120 for k in ('name','room','time')) or not x['name'].strip():raise ValueError()
                    if x.get('weeks') not in ('all','odd','even') or not isinstance(x.get('day'),int) or not 1<=x['day']<=7:raise ValueError()
                    if not isinstance(x.get('start'),int) or not isinstance(x.get('end'),int) or not 1<=x['start']<=x['end']<=18:raise ValueError()
                c.execute('UPDATE timetable_template SET data=? WHERE id=1',(json.dumps(courses,ensure_ascii=False),));self.send(200,{'ok':True});return
            if path in ('/api/password','/api/users','/api/username') and method=='POST':
                actor=c.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone()
                if path=='/api/users' and not actor['admin']:
                    self.send(403,{'error':'仅管理员可管理账户'}); return
                key='account:'+str(uid); now=time.time()
                c.execute('DELETE FROM attempts WHERE time<?',(now-900,))
                if c.execute('SELECT count(*) FROM attempts WHERE ip=?',(key,)).fetchone()[0]>=8:
                    self.send(429,{'error':'验证次数过多，请 15 分钟后重试'}); return
                if not hmac.compare_digest(password_hash(str(data.get('current_password',''))[:1024],actor['salt']),actor['password']):
                    c.execute('INSERT INTO attempts VALUES(?,?)',(key,now));self.send(400,{'error':'当前登录账户的密码不正确'});return
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
                minimum=12 if actor['admin'] and path=='/api/password' else 4
                if path=='/api/users' and data.get('action')=='reset':
                    target_role=c.execute('SELECT admin FROM users WHERE name=?',(str(data.get('name','')).strip(),)).fetchone()
                    if target_role and target_role['admin']: minimum=12
                if not isinstance(password,str) or not minimum<=len(password)<=256:
                    self.send(400,{'error':f'该账户新密码长度应为 {minimum}–256 位'});return
                salt=secrets.token_hex(16); hashed=password_hash(password,salt)
                target=uid
                if path=='/api/users':
                    name=str(data.get('name','')).strip()
                    if not 1<=len(name)<=64 or any(ch.isspace() for ch in name):
                        self.send(400,{'error':'用户名为 1–64 位，不能包含空白'});return
                    existing=c.execute('SELECT id FROM users WHERE name=?',(name,)).fetchone()
                    if data.get('action')=='create':
                        if existing:self.send(409,{'error':'用户名已存在'});return
                        target=c.execute('INSERT INTO users(name,salt,password,admin) VALUES(?,?,?,0)',(name,salt,hashed)).lastrowid
                        settings=c.execute('SELECT name,start FROM settings WHERE user_id=?',(uid,)).fetchone()
                        c.execute('INSERT INTO settings VALUES(?,?,?)',(target,settings['name'],settings['start']))
                        self.send(200,{'ok':True,'reauth':False});return
                    if data.get('action')!='reset' or not existing:
                        self.send(400,{'error':'请检查操作类型和用户名'});return
                    target=existing['id']
                c.execute('UPDATE users SET salt=?,password=? WHERE id=?',(salt,hashed,target))
                c.execute('DELETE FROM sessions WHERE user_id=?',(target,))
                self.send(200,{'ok':True,'reauth':target==uid});return
            if path=='/api/logout' and method=='POST':
                c.execute('DELETE FROM sessions WHERE token=?',(s['token'],)); self.send(200,{'ok':True},cookie='session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return
            if path=='/api/settings' and method=='PUT':
                start=dt.date.fromisoformat(data['start']); name=str(data['name']).strip()
                if start.weekday()!=0 or not 1<=len(name)<=80: raise ValueError()
                c.execute('UPDATE settings SET name=?,start=? WHERE user_id=?',(name,start.isoformat(),uid)); self.send(200,{'ok':True}); return
            if path=='/api/tasks' and method=='POST' or path.startswith('/api/tasks/') and method=='PUT':
                title=str(data['title']).strip(); date=dt.date.fromisoformat(data['date']).isoformat(); due=str(data.get('due','')); category=data.get('category','课程'); notes=str(data.get('notes',''))
                end_date=dt.date.fromisoformat(data.get('end_date') or date).isoformat()
                if end_date<date: raise ValueError()
                start_time=data.get('start_time','');end_time=data.get('end_time','')
                if start_time or end_time:
                    if not all(isinstance(x,str) and re.fullmatch(r'(?:[01][0-9]|2[0-3]):[0-5][0-9]',x) for x in (start_time,end_time)):raise ValueError()
                    if date+'T'+start_time>=end_date+'T'+end_time:
                        self.send(400,{'error':'结束时间必须晚于开始时间'});return
                elif start_time!='' or end_time!='':raise ValueError()
                if due: dt.datetime.fromisoformat(due)
                if not 1<=len(title)<=120 or len(notes)>4000 or not c.execute('SELECT 1 FROM categories WHERE user_id=? AND name=?',(uid,category)).fetchone() or len(due)>16: raise ValueError()
                if method=='POST': c.execute('INSERT INTO tasks(id,user_id,title,category,date,due,notes,done,version,end_date,start_time,end_time) VALUES(?,?,?,?,?,?,?,?,1,?,?,?)',(secrets.token_hex(8),uid,title,category,date,due,notes,int(bool(data.get('done',False))),end_date,start_time,end_time))
                else:
                    cur=c.execute('UPDATE tasks SET title=?,category=?,date=?,end_date=?,start_time=?,end_time=?,due=?,notes=?,done=?,version=version+1 WHERE id=? AND user_id=? AND version=?',(title,category,date,end_date,start_time,end_time,due,notes,int(bool(data.get('done',False))),path.rsplit('/',1)[1],uid,data['version']))
                    if cur.rowcount==0: self.send(409,{'error':'任务已被其他页面修改，请刷新后重试'}); return
                self.send(200,{'ok':True}); return
            if path.startswith('/api/tasks/') and method=='DELETE':
                cur=c.execute('DELETE FROM tasks WHERE id=? AND user_id=? AND version=?',(path.rsplit('/',1)[1],uid,data['version']))
                self.send(200 if cur.rowcount else 409,{'ok':True} if cur.rowcount else {'error':'任务已变化，请刷新'}); return
            self.send(404,{'error':'未找到'})
def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--host',default='127.0.0.1'); parser.add_argument('--port',type=int,default=8765); parser.add_argument('--create-user'); parser.add_argument('--demo',action='store_true'); args=parser.parse_args(); init()
    if args.create_user: create_user(args.create_user,getpass.getpass('Password (admin 12+, ordinary 4+): ')); return
    if args.demo:
        with connect() as c: exists=c.execute("SELECT 1 FROM users WHERE name='demo'").fetchone()
        if not exists: create_user('demo','SemesterDemo2026!',True)
    print(f'Listening on http://{args.host}:{args.port}',flush=True); ThreadingHTTPServer((args.host,args.port),Handler).serve_forever()
if __name__=='__main__': main()
