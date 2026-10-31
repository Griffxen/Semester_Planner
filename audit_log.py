"""Private, transactional business history with an explicit field allowlist."""
import base64
import csv
import datetime as dt
import hashlib
import io
import json
import os
import re
import sqlite3
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

BJ = dt.timezone(dt.timedelta(hours=8))
LABELS = {'title':'任务名称', 'short_title':'简称', 'category':'分类', 'date':'开始日期',
          'end_date':'结束日期', 'start_time':'开始时间', 'end_time':'结束时间', 'due':'截止时间',
          'notes':'备注', 'done':'完成状态', 'milestones':'关键节点', 'deferred':'暂缓状态',
          'deferred_at':'暂缓时间', 'previous_schedule':'原安排', 'body':'手记正文',
          'name':'名称', 'remark':'账户备注', 'start':'学期开始日期', 'color':'颜色',
          'warn_days':'提醒天数', 'urgent_days':'紧急天数', 'data':'课程内容',
          'permissions':'模板授权', 'archived':'归档状态', 'policy':'分享授权',
          'active':'启用状态', 'owner_id':'绑定账户', 'homework_required':'需交作业',
          'homework_notes':'作业说明', 'homework_done':'作业完成状态',
          'method':'登录方式', 'admin':'管理权限', 'device':'设备'}
KINDS = {'tasks':'task', 'journal':'journal', 'categories':'category', 'settings':'settings',
         'users':'user', 'viewers':'sharing', 'course_templates':'template'}
FIELDS = {
    'tasks':('id','user_id','title','short_title','category','date','end_date','start_time','end_time','due','notes','done','milestones','deferred','deferred_at','previous_schedule'),
    'journal':('user_id','date','body'), 'categories':('user_id','name','color','warn_days','urgent_days'),
    'settings':('user_id','name','start'), 'users':('id','name','remark'),
    'viewers':('user_id','owner_id','active','policy'),
    'course_templates':('template_id','name','data','permissions','archived'),
    'personal_course_plans':('user_id','data'), 'user_course_exceptions':('user_id','data'),
    'course_annotations':('user_id','course_key','date','notes','homework_required','homework_notes','homework_done'),
    'course_makeups':('user_id','occurrence_id','data'),
    'course_occurrence_archive':('user_id','occurrence_id','data'),
}
JSON_FIELDS = {'data','permissions','policy','milestones','previous_schedule'}
SECRET = re.compile(r'(^|[._:/\[\]-])(password|salt|csrf|token|pin|digest|secret|credential|session)([._:/\[\]-]|$)|(_hash$)', re.I)
GROUP_SQL = """CASE
    WHEN management_only=1 OR type='template' OR action LIKE 'management_%'
         OR action='password_reset' OR (type='user' AND action='create') THEN 'management'
    WHEN type IN ('auth','authentication','security','user') THEN 'account'
    WHEN type IN ('task','category') THEN 'task'
    WHEN type='course' THEN 'course'
    ELSE 'settings' END"""


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def _actor(actor):
    return dict(actor) if actor is not None else {}


def _table_exists(c, table):
    return c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone() is not None


def init(c):
    c.execute('''CREATE TABLE IF NOT EXISTS audit_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
        actor_id INTEGER, actor_name TEXT NOT NULL, owner_id INTEGER, owner_name TEXT NOT NULL,
        action TEXT NOT NULL, type TEXT NOT NULL, object_id TEXT NOT NULL, label TEXT NOT NULL,
        summary TEXT NOT NULL, outcome TEXT NOT NULL, request_id TEXT NOT NULL,
        changes TEXT NOT NULL, payload_bytes INTEGER NOT NULL,
        management_only INTEGER NOT NULL DEFAULT 0)''')
    if 'management_only' not in {row[1] for row in c.execute('PRAGMA table_info(audit_events)')}:
        c.execute('ALTER TABLE audit_events ADD COLUMN management_only INTEGER NOT NULL DEFAULT 0')
    for name, columns in [('month','created_at,id'), ('actor','actor_id,id'), ('owner','owner_id,id')]:
        c.execute(f'CREATE INDEX IF NOT EXISTS audit_events_{name} ON audit_events({columns})')


def _safe(value):
    if isinstance(value, dict):
        return {key:_safe(item) for key,item in value.items() if not SECRET.search(str(key))}
    if isinstance(value, list): return [_safe(item) for item in value]
    return value


def record(c, actor, action, kind, object_id, label, owner_id=None, changes=None,
           request_id='', outcome='success'):
    """Append inside the caller's transaction; never commits or stores credentials."""
    actor = _actor(actor); aid = actor.get('id')
    if owner_id is None: owner_id = aid
    global_template = kind == 'template' and bool(actor.get('admin'))
    if global_template: owner_id = None
    management_only = int(global_template or (owner_id is not None and owner_id != aid))
    owner = c.execute('SELECT name FROM users WHERE id=?', (owner_id,)).fetchone() if owner_id is not None else None
    clean = []
    for change in changes or []:
        field = str(change.get('field', ''))
        if not SECRET.search(field):
            clean.append(dict(field=field, label=str(change.get('label') or LABELS.get(field, field)),
                              before=_safe(change.get('before')), after=_safe(change.get('after'))))
    names = list(dict.fromkeys(x['label'] for x in clean))
    summary = ('修改：' + '、'.join(names[:5]) + ('等' if len(names)>5 else '')) if clean else str(label)
    values = dict(created_at=dt.datetime.now(dt.timezone.utc).isoformat(timespec='microseconds'),
                  actor_id=aid, actor_name=str(actor.get('name') or '未知账户'), owner_id=owner_id,
                  owner_name=owner[0] if owner else '', action=str(action), type=str(kind),
                  object_id=str(object_id), label=str(label), summary=summary,
                  outcome=str(outcome), request_id=str(request_id), changes=clean,
                  management_only=management_only)
    payload = len(_json(values).encode('utf-8')); values['changes'] = _json(clean)
    columns = tuple(values)
    cur = c.execute('INSERT INTO audit_events('+','.join(columns)+',payload_bytes) VALUES('+','.join('?' for _ in range(len(columns)+1))+')',
                    tuple(values.values())+(payload,))
    return cur.lastrowid


def _without_versions(value):
    if isinstance(value, dict):
        return {k:_without_versions(v) for k,v in value.items()
                if k not in {'version','template_version','plan_version','base_version','source_version','imported_version'}}
    if isinstance(value, list): return [_without_versions(v) for v in value]
    return value


def _tables_for(path):
    path = path.split('?', 1)[0]
    if path.startswith('/api/tasks'): return ('tasks',)
    if path == '/api/categories': return ('categories','tasks','viewers')
    if path == '/api/journal': return ('journal',)
    if path == '/api/settings': return ('settings','course_occurrence_archive')
    if path in ('/api/profile','/api/username','/api/users'): return ('users',)
    if path == '/api/shares': return ('viewers','users')
    if path.startswith(('/api/course-','/api/timetable')):
        return ('course_templates','personal_course_plans','user_course_exceptions',
                'course_annotations','course_makeups','course_occurrence_archive')
    return ()


def capture(c, path, actor):
    """Relevant safe business fields before/after mutation; excludes all auth tables."""
    uid = _actor(actor).get('id'); result = {}
    for table in _tables_for(path):
        if not _table_exists(c, table): continue
        present = {r[1] for r in c.execute(f'PRAGMA table_info({table})')}
        columns = [field for field in FIELDS[table] if field in present]
        sql = 'SELECT '+','.join(columns)+' FROM '+table; params = ()
        if table not in ('course_templates','users','viewers'):
            sql += ' WHERE user_id=?'; params = (uid,)
        elif table == 'users' and path not in ('/api/users','/api/shares'):
            sql += ' WHERE id=?'; params = (uid,)
        elif table == 'viewers' and path != '/api/shares':
            sql += ' WHERE owner_id=?'; params = (uid,)
        for row in c.execute(sql, params):
            item = dict(zip(columns, row))
            owner = item.get('owner_id', item.get('user_id', item.get('id', uid) if table == 'users' else uid))
            oid = item.get('template_id', item.get('id', item.get('occurrence_id', item.get('course_key', item.get('date', item.get('name', str(owner)))))))
            if table == 'categories': oid = item['name']
            if table in ('settings','personal_course_plans','user_course_exceptions'): oid = str(owner)
            if table == 'course_annotations': oid = item['course_key']+'@'+item['date']
            if table == 'viewers': oid = str(item['user_id'])
            label = item.get('title') or item.get('name') or item.get('date') or str(oid)
            values = {k:v for k,v in item.items() if k not in {'id','user_id','template_id','occurrence_id','course_key'}}
            for key in JSON_FIELDS & values.keys():
                try: values[key] = _without_versions(json.loads(values[key]))
                except (TypeError, ValueError): pass
            result[(table, owner, str(oid))] = dict(type=KINDS.get(table,'course'), label=label, values=values)
    return result


def _diff(before, after, prefix=''):
    changes = []
    for field in sorted(before.keys() | after.keys()):
        old, new = before.get(field), after.get(field); key = prefix+field
        if old == new: continue
        if isinstance(old, dict) and isinstance(new, dict): changes.extend(_diff(old,new,key+'.'))
        else: changes.append(dict(field=key, label=LABELS.get(field,field), before=old, after=new))
    return changes


def record_changes(c, before, actor, request_id, path):
    after = capture(c, path, actor); groups = {}
    # Category names are their old schema's identity; a single rename is one update.
    for owner in {key[1] for key in before.keys() | after.keys() if key[0]=='categories'}:
        removed = [key for key in before.keys()-after.keys() if key[:2]==('categories',owner)]
        added = [key for key in after.keys()-before.keys() if key[:2]==('categories',owner)]
        if len(removed)==len(added)==1: after[removed[0]] = after.pop(added[0])
    for key in sorted(before.keys() | after.keys(), key=str):
        old, new = before.get(key), after.get(key)
        changes = _diff(old['values'] if old else {}, new['values'] if new else {})
        if not changes: continue
        table, owner, oid = key; node = new or old
        action = 'create' if old is None else 'delete' if new is None else 'update'
        groups.setdefault((owner,node['type'],action), []).append((oid,node['label'],changes))
    ids = []
    for (owner,kind,action), items in groups.items():
        if len(items) == 1: oid,label,changes = items[0]
        else:
            oid,label = 'batch',str(len(items))+' 项记录'
            changes = [dict(change,field=item_id+'.'+change['field'],label=item_label+' · '+change['label'])
                       for item_id,item_label,diffs in items for change in diffs]
        ids.append(record(c,actor,action,kind,oid,label,owner_id=owner,changes=changes,request_id=request_id))
    return ids


def _event(row, detail=False):
    item = dict(row); changes = item.pop('changes'); item.pop('payload_bytes', None)
    managed = item.pop('management_only', False)
    kind, action = item['type'], item['action']
    item['group'] = ('management' if managed or kind=='template' or action.startswith('management_') or action=='password_reset' or kind=='user' and action=='create'
                     else 'account' if kind in ('auth','authentication','security','user')
                     else 'task' if kind in ('task','category') else 'course' if kind=='course' else 'settings')
    if detail: item['changes'] = json.loads(changes)
    return item


def _month(value):
    if not re.fullmatch(r'\d{4}-\d{2}', value): raise ValueError('月份格式应为 YYYY-MM')
    start = dt.datetime.strptime(value,'%Y-%m').replace(tzinfo=BJ)
    end = start.replace(year=start.year+1,month=1) if start.month == 12 else start.replace(month=start.month+1)
    return start.astimezone(dt.timezone.utc).isoformat(),end.astimezone(dt.timezone.utc).isoformat()


def _filters(c, actor, unlocked, query, monthly=True):
    aid = actor['id']; scope = query.get('scope','mine')
    if scope not in ('mine','all'): raise ValueError('无效的日志范围')
    if scope == 'all' and not (actor.get('admin') and unlocked): raise PermissionError('查看全部日志需要管理员二次验证')
    where, params = [], []
    if scope != 'all': where.append('(owner_id=? OR (actor_id=? AND management_only=0))'); params.extend((aid,aid))
    user = query.get('user_id')
    if user:
        user = int(user)
        if user != aid and not (actor.get('admin') and unlocked): raise PermissionError('不能查看其他账户的日志')
        where.append('(actor_id=? OR owner_id=?)'); params.extend((user,user))
    if monthly:
        start,end = _month(query['month']); where.append('created_at>=? AND created_at<?'); params.extend((start,end))
    if query.get('group'):
        if query['group'] not in ('account','task','course','settings','management'): raise ValueError('无效的日志类别')
        where.append('('+GROUP_SQL+')=?'); params.append(query['group'])
    for key in ('type','action'):
        if query.get(key):
            if len(query[key])>80: raise ValueError('筛选内容过长')
            where.append(key+'=?'); params.append(query[key])
    if query.get('q'):
        if len(query['q'])>200: raise ValueError('搜索内容过长')
        where.append("instr(lower(label||' '||summary||' '||actor_name||' '||owner_name||' '||changes),lower(?))>0"); params.append(query['q'])
    return where,params


def _storage(c, db_path):
    from backup import managed_timestamp
    db = Path(db_path); page_size = c.execute('PRAGMA page_size').fetchone()[0]
    pages = c.execute('PRAGMA page_count').fetchone()[0]; free = c.execute('PRAGMA freelist_count').fetchone()[0]
    database = dict(bytes=db.stat().st_size if db.exists() else 0,page_size=page_size,page_count=pages,
                    freelist_count=free,allocated_bytes=pages*page_size,free_bytes=free*page_size)
    database['sidecar_bytes'] = {suffix:Path(str(db)+suffix).stat().st_size for suffix in ('-wal','-shm','-journal') if Path(str(db)+suffix).is_file()}
    folder = Path(os.environ.get('PLANNER_BACKUP_DIR',db.parent/'backups'))
    backups = dict(bytes=0,count=0,managed_bytes=0,managed_count=0,legacy_bytes=0,legacy_count=0,path=str(folder))
    if folder.is_dir():
        for file in folder.iterdir():
            if file.is_symlink() or not file.is_file() or file.suffix != '.db': continue
            size = file.stat().st_size; group = 'managed' if managed_timestamp(file.name) else 'legacy'
            backups['bytes'] += size; backups['count'] += 1; backups[group+'_bytes'] += size; backups[group+'_count'] += 1
    stat = os.statvfs(db.parent)
    filesystem = dict(total_bytes=stat.f_blocks*stat.f_frsize,free_bytes=stat.f_bfree*stat.f_frsize,available_bytes=stat.f_bavail*stat.f_frsize)
    months = [dict(zip(('month','count','payload_bytes'),row)) for row in c.execute("SELECT strftime('%Y-%m',created_at,'+8 hours'),count(*),coalesce(sum(payload_bytes),0) FROM audit_events GROUP BY 1 ORDER BY 1 DESC")]
    count = sum(x['count'] for x in months); payload = sum(x['payload_bytes'] for x in months)
    audit = dict(count=count,payload_bytes=payload,months=months,estimated_bytes_per_1000=round(payload/count*1000*1.5) if count else 1048576,
                 estimate_basis='实际序列化事件平均值 × 1000 × 1.5；空库默认 1 MiB，不含备份')
    try: audit['allocated_bytes'] = c.execute("SELECT coalesce(sum(pgsize),0) FROM dbstat WHERE name='audit_events' OR name LIKE 'audit_events_%'").fetchone()[0]
    except Exception: audit['allocated_bytes'] = None
    reads = dict(count=0,allocated_bytes=None)
    if _table_exists(c,'api_reads'):
        reads['count'] = c.execute('SELECT count(*) FROM api_reads').fetchone()[0]
        try: reads['allocated_bytes'] = c.execute("SELECT coalesce(sum(pgsize),0) FROM dbstat WHERE name='api_reads' OR name LIKE 'api_reads_%'").fetchone()[0]
        except sqlite3.OperationalError: pass
    return dict(database=database,backups=backups,filesystem=filesystem,audit=audit,api_reads=reads)


def route(c, actor, admin_unlocked, method, path, raw_url, db_path):
    if not (path.startswith('/api/audit/') or path == '/api/admin/storage'): return None
    if method != 'GET': return 405,dict(error='日志只支持读取'),'application/json',{}
    actor = _actor(actor)
    if not actor.get('id'): return 401,dict(error='请先登录'),'application/json',{}
    if _table_exists(c,'viewers') and c.execute('SELECT 1 FROM viewers WHERE user_id=?',(actor['id'],)).fetchone():
        return 403,dict(error='展示账户不能查看操作日志'),'application/json',{}
    try:
        if path == '/api/admin/storage':
            if not (actor.get('admin') and admin_unlocked): raise PermissionError('查看磁盘用量需要管理员二次验证')
            return 200,_storage(c,db_path),'application/json',{}
        parsed = parse_qs(urlsplit(raw_url).query,keep_blank_values=True)
        if any(len(v)!=1 for v in parsed.values()): raise ValueError('重复的查询参数')
        query = {k:v[0] for k,v in parsed.items()}; query.setdefault('month',dt.datetime.now(BJ).strftime('%Y-%m'))
        where,params = _filters(c,actor,admin_unlocked,query,monthly=path!='/api/audit/months')
        if path == '/api/audit/months':
            suffix = ' WHERE '+' AND '.join(where) if where else ''
            rows = c.execute("SELECT strftime('%Y-%m',created_at,'+8 hours'),count(*) FROM audit_events"+suffix+' GROUP BY 1 ORDER BY 1 DESC',params)
            return 200,dict(months=[dict(month=r[0],count=r[1]) for r in rows],default_month=dt.datetime.now(BJ).strftime('%Y-%m')),'application/json',{}
        if path.startswith('/api/audit/events/'):
            eid = int(path.rsplit('/',1)[1]); allowed,p = _filters(c,actor,admin_unlocked,query,monthly=False)
            row = c.execute('SELECT * FROM audit_events WHERE id=?'+(' AND '+' AND '.join(allowed) if allowed else ''),(eid,*p)).fetchone()
            return (200,dict(event=_event(row,True)),'application/json',{}) if row else (404,dict(error='未找到日志'),'application/json',{})
        if path not in ('/api/audit/events','/api/audit/export'): return 404,dict(error='未找到日志接口'),'application/json',{}
        maximum = c.execute('SELECT coalesce(max(id),0) FROM audit_events').fetchone()[0]
        snapshot = int(query.get('snapshot_id',maximum))
        if not 0<=snapshot<=maximum: raise ValueError('无效的日志快照')
        fingerprint = hashlib.sha256(_json({k:v for k,v in sorted(query.items()) if k not in {'cursor','before','snapshot_id','limit','format'}}).encode()).hexdigest()[:24]
        before = None
        if query.get('cursor'):
            if len(query['cursor'])>1024: raise ValueError('无效的日志游标')
            cursor = json.loads(base64.urlsafe_b64decode(query['cursor']+'='*(-len(query['cursor'])%4)))
            if not isinstance(cursor,dict): raise ValueError('无效的日志游标')
            if cursor.get('filter')!=fingerprint: raise ValueError('筛选已变化，请重新读取日志')
            before,snapshot = int(cursor['before']),int(cursor['snapshot_id'])
            if before<=0 or not 0<=snapshot<=maximum: raise ValueError('无效的日志游标')
        elif query.get('before'):
            before = int(query['before'])
            if before<=0: raise ValueError('无效的日志游标')
        where.append('id<=?'); params.append(snapshot)
        if before is not None and path != '/api/audit/export': where.append('id<?'); params.append(before)
        sql = 'SELECT * FROM audit_events WHERE '+' AND '.join(where)+' ORDER BY id DESC'
        if path == '/api/audit/events':
            limit = int(query.get('limit',50))
            if not 1<=limit<=100: raise ValueError('每页日志应为 1–100 条')
            rows = c.execute(sql+' LIMIT ?',(*params,limit+1)).fetchall(); more = len(rows)>limit; rows = rows[:limit]
            next_cursor = base64.urlsafe_b64encode(_json(dict(before=rows[-1]['id'],snapshot_id=snapshot,filter=fingerprint)).encode()).decode().rstrip('=') if more else None
            return 200,dict(events=[_event(r) for r in rows],next_cursor=next_cursor,snapshot_id=snapshot,month=query['month']),'application/json',{}
        fmt = query.get('format','json')
        if fmt not in ('json','csv'): raise ValueError('导出格式应为 json 或 csv')
        events = [_event(row,True) for row in c.execute(sql,params)]
        headers = {'Content-Disposition':f'attachment; filename="planner-audit-{query["month"]}.{fmt}"'}
        if fmt == 'json':
            return 200,dict(format=1,month=query['month'],snapshot_id=snapshot,exported_at=dt.datetime.now(dt.timezone.utc).isoformat(),events=events),'application/json',headers
        stream = io.StringIO(newline=''); writer = csv.writer(stream)
        columns = ('id','created_at','actor_id','actor_name','owner_id','owner_name','action','type','object_id','label','summary','outcome','request_id','changes'); writer.writerow(columns)
        def cell(value):
            value = _json(value) if isinstance(value,(dict,list)) else '' if value is None else str(value)
            return "'"+value if value.lstrip().startswith(('=','+','-','@')) or value.startswith(('\t','\r','\n')) else value
        for event in events: writer.writerow([cell(event.get(key)) for key in columns])
        return 200,('\ufeff'+stream.getvalue()).encode('utf-8'),'text/csv; charset=utf-8',headers
    except PermissionError as error:
        return 403,dict(error=str(error),code='management_auth_required' if actor.get('admin') else 'forbidden'),'application/json',{}
    except (ValueError,TypeError,KeyError,OverflowError,UnicodeError): return 400,dict(error='日志查询参数不正确'),'application/json',{}
