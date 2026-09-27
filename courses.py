"""Course identities and personal, single-occurrence schedule changes."""
import datetime as dt
import json
import re
import secrets


def signature(course):
    return json.dumps({k: v for k, v in course.items() if k != 'course_id'},
                      ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def with_ids(courses, previous=()):
    used=set();result=[]
    for course in courses:
        item=dict(course);key=item.get('course_id')
        if not isinstance(key,str) or not re.fullmatch(r'[a-f0-9]{16}',key) or key in used:
            match=next((x for x in previous if x.get('course_id') not in used and signature(x)==signature(item)),None)
            if match is None:
                candidates=[x for x in previous if x.get('course_id') not in used and x['name']==item['name'] and x['day']==item['day']]
                match=candidates[0] if len(candidates)==1 else None
            key=match['course_id'] if match else secrets.token_hex(8)
        item['course_id']=key;used.add(key);result.append(item)
    return result


def migrate_ids(c):
    raw=c.execute('SELECT data FROM timetable_template WHERE id=1').fetchone()[0]
    template=with_ids(json.loads(raw))
    c.execute('UPDATE timetable_template SET data=? WHERE id=1',(json.dumps(template,ensure_ascii=False),))
    for row in c.execute('SELECT user_id,data FROM user_timetable').fetchall():
        courses=with_ids(json.loads(row['data']),template)
        c.execute('UPDATE user_timetable SET data=? WHERE user_id=?',(json.dumps(courses,ensure_ascii=False),row['user_id']))


def occurs(course, start, day):
    week=(day-start).days//7+1
    return (1<=week<=18 and course['day']==day.weekday()+1 and course['start']<=week<=course['end']
            and (course['weeks']=='all' or (week%2==1)==(course['weeks']=='odd')))


def is_holiday(day, holidays):
    return any(h['start']<=day<=h['end'] for h in holidays)


def expand(timetable, start, holidays, exceptions, include_cancelled=False):
    start=dt.date.fromisoformat(start)
    changes={(x['course_key'],x['date']):x for x in exceptions}
    result=[];seen=set()
    for offset in range(126):
        day=start+dt.timedelta(days=offset);original=day.isoformat()
        for course in timetable:
            if not occurs(course,start,day):continue
            seen.add((course['course_id'],original))
            change=changes.get((course['course_id'],original),{})
            actual=change.get('new_date') or original
            if is_holiday(actual,holidays):continue
            cancelled=bool(change.get('cancelled'))
            if cancelled and not include_cancelled:continue
            result.append(dict(date=actual,name=course['name'],time=change.get('new_time') or course['time'],
                               room=course['room'],course_key=course['course_id'],original_date=original,
                               original_time=change.get('original_time') or course['time'],cancelled=cancelled,
                               adjusted=bool(change)))
    # Keep explicit changes visible even when a template edit removes their original slot.
    for key,change in changes.items():
        if key in seen:continue
        course=next((c for c in timetable if c['course_id']==key[0]),None)
        if not course:continue
        actual=change.get('new_date') or change['date'];cancelled=bool(change.get('cancelled'))
        if is_holiday(actual,holidays) or (cancelled and not include_cancelled):continue
        result.append(dict(date=actual,name=course['name'],time=change.get('new_time') or change.get('original_time') or course['time'],room=course['room'],course_key=key[0],original_date=change['date'],original_time=change.get('original_time') or course['time'],cancelled=cancelled,adjusted=True))
    return sorted(result,key=lambda x:(x['date'],x['time'],x['name']))
