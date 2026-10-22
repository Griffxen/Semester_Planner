"""Ephemeral export projection. No policy or account writes."""
import copy
import datetime as dt
from sharing import policy_range, task_in_range, anonymize


def project_export(source, raw):
    if not isinstance(raw, dict): raise ValueError()
    mode=raw.get('format','image')
    if mode not in ('image','json'): raise ValueError()
    p=dict(range='week',start='',end='',categories=[c['name'] for c in source['categories']],
           done=False,notes=False,nodes=True,timetable=True,course_notes=False,
           homework=False,journal='none',journal_dates=[],busy_only=False,
           exclude_tasks=[],exclude_courses=[],exclude_journal=[])
    for key in p:
        if key in raw:p[key]=raw[key]
    if p['range'] not in ('week','two','semester','custom'):raise ValueError()
    for key in ('done','notes','nodes','timetable','course_notes','homework','busy_only'):
        if type(p[key]) is not bool:raise ValueError()
    for key in ('categories','journal_dates','exclude_tasks','exclude_courses','exclude_journal'):
        if not isinstance(p[key],list) or len(p[key])>10000 or any(not isinstance(x,str) for x in p[key]):raise ValueError()
    if p['journal'] not in ('none','all','selected'):raise ValueError()
    for day in p['journal_dates']+p['exclude_journal']:dt.date.fromisoformat(day)
    lo,hi=policy_range(source['settings'],p,clamp=False)
    if lo>hi:raise ValueError()
    restricted=source.get('readonly',False)
    if restricted:
        lo=max(lo,source['share']['start']);hi=min(hi,source['share']['end'])
    busy=p['busy_only'] or bool(source.get('share',{}).get('busy_only'))
    # Anonymous selections use anonymous keys; ordinary selections use source keys.
    tasks=[];courses=[];journal=[]
    if lo<=hi:
        for original in source['tasks']:
            if (original['category'] not in p['categories'] or (original['done'] and not p['done'])
                or (not busy and str(original['id']) in p['exclude_tasks']) or not task_in_range(original,lo,hi,points=True)):continue
            t={k:copy.deepcopy(v) for k,v in original.items() if k not in ('version','user_id','deferred','deferred_at','previous_schedule')}
            overlap=original['date']<=hi and original['end_date']>=lo
            t.update(schedule_visible=overlap,continues_before=bool(original.get('continues_before') or original['date']<lo),
                     continues_after=bool(original.get('continues_after') or original['end_date']>hi))
            t['date']=max(original['date'],lo) if overlap else ''
            t['end_date']=min(original['end_date'],hi) if overlap else ''
            if overlap and t.get('start_time'):
                if original['date']<lo:t['start_time']='00:00'
                if original['end_date']>hi:t['end_time']='23:59'
            t['due']=t.get('due','') if lo<=t.get('due','')[:10]<=hi else ''
            t['milestones']=[m for m in t.get('milestones',[]) if p['nodes'] and lo<=m['stop_at'][:10]<=hi and (p['done'] or not m.get('done'))]
            t['notes']=t.get('notes','') if p['notes'] else ''
            if overlap or t['due'] or t['milestones']:tasks.append(t)
        if p['timetable']:
            for i,c in enumerate(source.get('course_dates',[])):
                legacy_key=c.get('course_key','busy-'+str(i))+'@'+c.get('original_date',c['date'])
                key=c.get('occurrence_id') or legacy_key
                if c.get('cancelled') or not lo<=c['date']<=hi or (not busy and (key in p['exclude_courses'] or legacy_key in p['exclude_courses'])):continue
                item={k:c[k] for k in ('date','name','time','room','course_key','original_date','original_time','adjusted','occurrence_id','kind') if k in c}
                item['export_key']=key
                if not restricted and p['course_notes']:item['notes']=c.get('notes','')
                if not restricted and p['homework']:
                    item.update({k:c.get(k,False if k!='homework_notes' else '') for k in ('homework_required','homework_done','homework_notes')})
                courses.append(item)
        if p['journal']!='none':
            journal=[dict(date=j['date'],body=j['body']) for j in source['journal'] if lo<=j['date']<=hi
                     and j['date'] not in p['exclude_journal'] and (p['journal']=='all' or j['date'] in p['journal_dates'])]
    result=dict(settings=copy.deepcopy(source['settings']),categories=[c for c in source['categories'] if c['name'] in p['categories']],
                tasks=tasks,course_dates=courses,journal=journal,
                date_counts=[x for x in source.get('date_counts',[]) if lo<=x['date']<=hi],range=dict(start=lo,end=hi))
    if busy:
        # Point-only parents carry no schedule; do not turn them into occupied time.
        result['tasks']=[t for t in tasks if t['schedule_visible']]
        previous=result['date_counts'];anonymize(result)
        result['date_counts']+=previous
        result['tasks']=[t for t in result['tasks'] if str(t['id']) not in p['exclude_tasks']]
        result['date_counts']=[x for x in result['date_counts'] if 'count:'+x['date'] not in p['exclude_tasks']]
        for c in result['course_dates']:c['export_key']='occupied@'+c['date']+'@'+c['time']
        result['course_dates']=[c for c in result['course_dates'] if c['export_key'] not in p['exclude_courses']]
        result['settings']={**result['settings'],'name':'占用时间看板'}
        result['categories']=[dict(name=c['name'],color=c['color']) for c in result['categories']]
        # Never echo original category names or exclusion IDs in a busy export.
        p={k:v for k,v in p.items() if k not in ('categories','exclude_tasks','exclude_courses','exclude_journal')}
    p.update(start=lo,end=hi)
    result['selection']=p
    result['summary']=dict(tasks=len(result['tasks']),courses=len(result['course_dates']),journal=len(result['journal']),
                           arrangements=sum(x['count'] for x in result['date_counts']))
    return result
