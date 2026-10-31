"""Compact Dashboard API access statistics, separate from business history."""
import base64
import csv
import datetime as dt
import hashlib
import io
import json
import math
import re
from urllib.parse import parse_qs, urlsplit

BJ = dt.timezone(dt.timedelta(hours=8))
ROOT = '/api/admin/api-reads'
COLUMNS = ('id','created_at','endpoint','method','status','duration_ms','viewer_id',
           'viewer_name','owner_id','task_count','course_count','request_id')


def _json(value):
    return json.dumps(value,ensure_ascii=False,separators=(',',':'))


def init(c):
    c.execute('''CREATE TABLE IF NOT EXISTS api_reads(
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
        endpoint TEXT NOT NULL, method TEXT NOT NULL, status INTEGER NOT NULL,
        duration_ms REAL NOT NULL, viewer_id INTEGER, viewer_name TEXT NOT NULL,
        owner_id INTEGER, task_count INTEGER NOT NULL, course_count INTEGER NOT NULL,
        request_id TEXT NOT NULL)''')
    c.execute('CREATE INDEX IF NOT EXISTS api_reads_month ON api_reads(created_at,id)')
    c.execute('CREATE INDEX IF NOT EXISTS api_reads_viewer ON api_reads(viewer_id,id)')


def record(c, *, request_id, endpoint, method, status, duration_ms, viewer=None, result=None):
    """Append only safe scalar metadata; the caller owns commit and error handling."""
    endpoint = {'/api/v1/agenda':'agenda','/api/v1/agenda/meta':'meta'}.get(endpoint,endpoint)
    if endpoint not in ('agenda','meta'): raise ValueError('Unsupported Dashboard endpoint')
    elapsed = float(duration_ms)
    if not math.isfinite(elapsed): raise ValueError('Invalid request duration')
    viewer = dict(viewer) if viewer is not None else {}
    result = result if isinstance(result,dict) else {}
    tasks = result.get('tasks')
    courses = result.get('courses',result.get('course_dates'))
    values = (dt.datetime.now(dt.timezone.utc).isoformat(timespec='microseconds'),endpoint,
              str(method).upper(),int(status),round(max(0,elapsed),3),
              viewer.get('user_id',viewer.get('id')),str(viewer.get('name') or viewer.get('viewer_name') or ''),
              viewer.get('owner_id'),len(tasks) if isinstance(tasks,(list,tuple)) else 0,
              len(courses) if isinstance(courses,(list,tuple)) else 0,str(request_id))
    cursor = c.execute('INSERT INTO api_reads('+','.join(COLUMNS[1:])+') VALUES('+','.join('?' for _ in values)+')',values)
    return cursor.lastrowid


def _month(value):
    if not re.fullmatch(r'\d{4}-\d{2}',value): raise ValueError('Invalid month')
    start = dt.datetime.strptime(value,'%Y-%m').replace(tzinfo=BJ)
    end = start.replace(year=start.year+1,month=1) if start.month==12 else start.replace(month=start.month+1)
    return start.astimezone(dt.timezone.utc).isoformat(),end.astimezone(dt.timezone.utc).isoformat()


def _where(query):
    start,end = _month(query['month'])
    where,params = ['created_at>=?','created_at<?'],[start,end]
    if query.get('endpoint'):
        if query['endpoint'] not in ('agenda','meta'): raise ValueError('Invalid endpoint')
        where.append('endpoint=?'); params.append(query['endpoint'])
    if query.get('viewer_id'):
        viewer = int(query['viewer_id'])
        if viewer<=0: raise ValueError('Invalid viewer')
        where.append('viewer_id=?'); params.append(viewer)
    return where,params


def _rows(c, sql, params=()):
    cursor = c.execute(sql,params)
    names = [column[0] for column in cursor.description]
    return [dict(zip(names,row)) for row in cursor]


def _statistics(c, where, params):
    suffix = ' FROM api_reads WHERE '+' AND '.join(where)
    total,success,average,maximum = c.execute('SELECT count(*),coalesce(sum(CASE WHEN status>=200 AND status<300 THEN 1 ELSE 0 END),0),coalesce(avg(duration_ms),0),coalesce(max(duration_ms),0)'+suffix,params).fetchone()
    summary = dict(total=total,success=success,failed=total-success,
                   success_rate=round(success/total*100,2) if total else 0,
                   average_ms=round(average,3),max_ms=round(maximum,3))
    daily = _rows(c,"SELECT date(created_at,'+8 hours') AS date,count(*) AS total,coalesce(sum(CASE WHEN status>=200 AND status<300 THEN 1 ELSE 0 END),0) AS success"+suffix+' GROUP BY 1 ORDER BY 1',params)
    for day in daily: day['failed'] = day['total']-day['success']
    return summary,daily


def _csv(events):
    stream = io.StringIO(newline=''); writer = csv.writer(stream); writer.writerow(COLUMNS)
    def cell(value):
        value = '' if value is None else str(value)
        return "'"+value if value.lstrip().startswith(('=','+','-','@')) or value.startswith(('\t','\r','\n')) else value
    for event in events: writer.writerow([cell(event.get(column)) for column in COLUMNS])
    return ('\ufeff'+stream.getvalue()).encode('utf-8')


def route(c, actor, admin_unlocked, method, path, raw_url):
    if path not in (ROOT,ROOT+'/export'): return None
    actor = dict(actor) if actor is not None else {}
    if not actor.get('id'): return 401,dict(error='请先登录'),'application/json',{}
    viewer_table = c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='viewers'").fetchone()
    viewer = viewer_table and c.execute('SELECT 1 FROM viewers WHERE user_id=?',(actor['id'],)).fetchone()
    if viewer or not (actor.get('admin') and admin_unlocked):
        return 403,dict(error='查看 API 读取统计需要管理员二次验证',
                        code='management_auth_required' if actor.get('admin') and not viewer else 'forbidden'),'application/json',{}
    if method!='GET': return 405,dict(error='API 读取统计只支持读取'),'application/json',{}
    try:
        parsed = parse_qs(urlsplit(raw_url).query,keep_blank_values=True)
        if any(len(values)!=1 for values in parsed.values()): raise ValueError('Duplicate parameter')
        query = {key:values[0] for key,values in parsed.items()}
        if set(query)-{'month','endpoint','viewer_id','limit','cursor','snapshot_id','format'}: raise ValueError('Unknown parameter')
        query.setdefault('month',dt.datetime.now(BJ).strftime('%Y-%m'))
        where,params = _where(query)
        maximum = c.execute('SELECT coalesce(max(id),0) FROM api_reads').fetchone()[0]
        snapshot = int(query.get('snapshot_id',maximum))
        if not 0<=snapshot<=maximum: raise ValueError('Invalid snapshot')
        filters = {key:query.get(key,'') for key in ('month','endpoint','viewer_id')}
        fingerprint = hashlib.sha256(_json(filters).encode()).hexdigest()[:24]
        before = None
        if query.get('cursor'):
            if len(query['cursor'])>1024: raise ValueError('Invalid cursor')
            cursor = json.loads(base64.urlsafe_b64decode(query['cursor']+'='*(-len(query['cursor'])%4)))
            if not isinstance(cursor,dict) or cursor.get('filter')!=fingerprint: raise ValueError('Invalid cursor')
            before,snapshot = int(cursor['before']),int(cursor['snapshot_id'])
            if before<=0 or not 0<=snapshot<=maximum: raise ValueError('Invalid cursor')
        where.append('id<=?'); params.append(snapshot)
        summary,daily = _statistics(c,where,params)
        response = dict(month=query['month'],summary=summary,daily=daily,snapshot_id=snapshot)
        sql = 'SELECT '+','.join(COLUMNS)+' FROM api_reads WHERE '+' AND '.join(where)
        if path==ROOT:
            limit = int(query.get('limit',50))
            if not 1<=limit<=100: raise ValueError('Invalid limit')
            if before is not None: sql += ' AND id<?'; params.append(before)
            events = _rows(c,sql+' ORDER BY id DESC LIMIT ?',(*params,limit+1))
            more = len(events)>limit; response['events'] = events[:limit]
            response['next_cursor'] = base64.urlsafe_b64encode(_json(dict(before=events[limit-1]['id'],snapshot_id=snapshot,filter=fingerprint)).encode()).decode().rstrip('=') if more else None
            return 200,response,'application/json',{}
        fmt = query.get('format','json')
        if fmt not in ('csv','json'): raise ValueError('Invalid export format')
        events = _rows(c,sql+' ORDER BY id DESC',params)
        headers = {'Content-Disposition':f'attachment; filename="planner-api-reads-{query["month"]}.{fmt}"'}
        if fmt=='csv': return 200,_csv(events),'text/csv; charset=utf-8',headers
        response.update(format=1,exported_at=dt.datetime.now(dt.timezone.utc).isoformat(),events=events)
        return 200,response,'application/json',headers
    except (ValueError,TypeError,KeyError,OverflowError,UnicodeError):
        return 400,dict(error='API 读取统计查询参数不正确'),'application/json',{}
