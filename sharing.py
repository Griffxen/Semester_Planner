"""Read-only sharing: policy validation and server-side projection."""
import datetime as dt
import json

DEFAULT_POLICY = dict(enabled=False, categories=[], range='week', start='', end='', done=False,
                      notes=False, busy_only=False, journal='none', journal_dates=[], timetable=False, export=False)

def init_sharing(c):
    c.execute('''CREATE TABLE IF NOT EXISTS viewers(
        user_id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, policy TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1)''')
    if 'dashboard_token_hash' not in [r['name'] for r in c.execute('PRAGMA table_info(viewers)')]:
        c.execute('ALTER TABLE viewers ADD COLUMN dashboard_token_hash TEXT')

def validate_policy(raw, categories):
    if not isinstance(raw,dict): raise ValueError()
    p=dict(DEFAULT_POLICY)
    for k in ('enabled','done','notes','timetable','export'):
        if type(raw.get(k)) is not bool: raise ValueError()
        p[k]=raw[k]
    if raw.get('range') not in ('week','two','semester','custom'): raise ValueError()
    p['range']=raw['range']
    if type(raw.get('busy_only',False)) is not bool: raise ValueError()
    p['busy_only']=raw.get('busy_only',False)
    selected=raw.get('categories')
    if not isinstance(selected,list) or any(not isinstance(x,str) or x not in categories for x in selected): raise ValueError()
    p['categories']=list(dict.fromkeys(selected))
    if p['range']=='custom':
        p['start']=dt.date.fromisoformat(raw['start']).isoformat()
        p['end']=dt.date.fromisoformat(raw['end']).isoformat()
        if p['start']>p['end']: raise ValueError()
    if raw.get('journal') not in ('none','all','selected'): raise ValueError()
    p['journal']=raw['journal']
    dates=raw.get('journal_dates',[])
    if not isinstance(dates,list) or len(dates)>366: raise ValueError()
    p['journal_dates']=sorted(set(dt.date.fromisoformat(x).isoformat() for x in dates))
    return p

def private_state(c,uid):
    return dict(categories=[dict(r) for r in c.execute('SELECT name,color,warn_days,urgent_days FROM categories WHERE user_id=? ORDER BY rowid',(uid,))],
                journal=[dict(r) for r in c.execute('SELECT date,body,version FROM journal WHERE user_id=?',(uid,))],
                timetable=json.loads((c.execute('SELECT data FROM user_timetable WHERE user_id=?',(uid,)).fetchone() or ['[]'])[0]),
                user=dict(c.execute('SELECT name,admin,remark FROM users WHERE id=?',(uid,)).fetchone()),
                settings=dict(c.execute('SELECT name,start FROM settings WHERE user_id=?',(uid,)).fetchone()),
                tasks=[dict(r) for r in c.execute('SELECT id,title,category,date,end_date,start_time,end_time,due,notes,done,version FROM tasks WHERE user_id=?',(uid,))],readonly=False)

def shared_state(c,viewer,today=None):
    # This projection is used identically by viewers, owner previews and export checks.
    own=private_state(c,viewer['owner_id'])
    p=json.loads(viewer['policy'])
    start=dt.date.fromisoformat(own['settings']['start']);end=start+dt.timedelta(days=125)
    today=today or dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).date()
    lo,hi=start,end
    if p['range'] in ('week','two'):
        lo=today-dt.timedelta(days=today.weekday());hi=lo+dt.timedelta(days=6 if p['range']=='week' else 13)
    elif p['range']=='custom':lo,hi=dt.date.fromisoformat(p['start']),dt.date.fromisoformat(p['end'])
    lo,hi=max(lo,start).isoformat(),min(hi,end).isoformat()
    enabled=bool(viewer['active'] and p['enabled'])
    busy=p.get('busy_only',False)
    account=dict(c.execute('SELECT name,remark FROM users WHERE id=?',(viewer['user_id'],)).fetchone())
    result=dict(user={**account,'admin':0,'viewer':True},settings=own['settings'],readonly=True,
                categories=[],tasks=[],journal=[],timetable=[],course_dates=[],date_counts=[],
                share=dict(owner=own['user']['remark'] or own['user']['name'],enabled=enabled,
                           start=lo,end=hi,export=bool(enabled and p['export']),
                           busy_only=busy,message='' if enabled else '分享尚未开启或已暂停'))
    if busy:
        result['settings']={**result['settings'],'name':'占用时间看板'}
        result['share']['owner']='日程所有者'
    if not enabled or lo>hi:return result
    result['categories']=[x for x in own['categories'] if x['name'] in p['categories']]
    for t in own['tasks']:
        if t['category'] not in p['categories'] or (t['done'] and not p['done']) or t['date']>hi or t['end_date']<lo:continue
        visible={k:t[k] for k in ('id','title','category','date','end_date','start_time','end_time','due','notes','done')}
        visible.update(continues_before=t['date']<lo,continues_after=t['end_date']>hi,
                       date=max(t['date'],lo),end_date=min(t['end_date'],hi),
                       notes=t['notes'] if p['notes'] else '',
                       due=t['due'] if t['due'] and lo<=t['due'][:10]<=hi else '')
        if t['start_time']:
            visible['start_time']='00:00' if t['date']<lo else t['start_time']
            visible['end_time']='23:59' if t['end_date']>hi else t['end_time']
        result['tasks'].append(visible)
    if p['journal']!='none':
        result['journal']=[dict(date=j['date'],body=j['body']) for j in own['journal'] if lo<=j['date']<=hi and (p['journal']=='all' or j['date'] in p['journal_dates'])]
    if p['timetable']:
        date=dt.date.fromisoformat(lo)
        while date.isoformat()<=hi:
            week=(date-start).days//7+1
            for course in own['timetable']:
                if course['day']==date.weekday()+1 and course['start']<=week<=course['end'] and (course['weeks']=='all' or (week%2==1)==(course['weeks']=='odd')):
                    result['course_dates'].append(dict(date=date.isoformat(),name=course['name'],time=course['time'],room=course['room']))
            date+=dt.timedelta(days=1)
    if busy:
        # Never send the original identifiers, titles, status, category, notes or diary.
        counts={};ranges=[]
        for task in result['tasks']:
            if task['start_time']:continue
            if task['date']!=task['end_date'] or task['continues_before'] or task['continues_after']:
                ranges.append(dict(id='arrangement-'+str(len(ranges)),title='另有安排',category='另有安排',
                                   date=task['date'],end_date=task['end_date'],start_time='',end_time='',
                                   due='',notes='',done=False,continues_before=task['continues_before'],
                                   continues_after=task['continues_after']))
            else:
                key=task['date'];counts[key]=counts.get(key,0)+1
        result['date_counts']=[dict(date=day,count=count) for day,count in sorted(counts.items())]
        slots=sorted(set((t['date'],t['end_date'],'',t['start_time'],t['end_time'],t['continues_before'],t['continues_after']) for t in result['tasks'] if t['start_time']))
        result['categories']=[dict(name='已占用',color='#81918b')] if slots or result['course_dates'] else []
        if ranges:result['categories'].append(dict(name='另有安排',color='#81918b'))
        result['tasks']=[dict(id='busy-'+str(i),title='已占用',category='已占用',date=a,end_date=b,due=d,start_time=st,end_time=et,notes='',done=False,continues_before=before,continues_after=after) for i,(a,b,d,st,et,before,after) in enumerate(slots)]+ranges
        result['journal']=[]
        result['course_dates']=[dict(date=d,time=t,name='已占用',room='') for d,t in sorted(set((x['date'],x['time']) for x in result['course_dates']))]
    return result

def drop_category_permissions(c,uid,name):
    # Renaming/deleting never silently grants permission to a newly created category.
    for row in c.execute('SELECT * FROM viewers WHERE owner_id=?',(uid,)).fetchall():
        p=json.loads(row['policy'])
        if name in p['categories']:
            p['categories'].remove(name)
            c.execute('UPDATE viewers SET policy=?,version=version+1 WHERE user_id=?',(json.dumps(p),row['user_id']))
