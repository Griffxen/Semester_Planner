"""Small read-only projection for a dashboard bound to a viewer account."""
import datetime as dt
import hashlib
from urllib.parse import parse_qs, urlsplit

from sharing import shared_state

TIMEZONE = 'Asia/Shanghai'
MAX_DAYS = 31


def _date(value):
    if len(value) != 10:
        raise ValueError()
    date = dt.date.fromisoformat(value)
    if date.isoformat() != value:
        raise ValueError()
    return date


def agenda(c, viewer, raw_path):
    query = parse_qs(urlsplit(raw_path).query, keep_blank_values=True, strict_parsing=True)
    if set(query) - {'from', 'to', 'include'} or any(len(v) != 1 for v in query.values()):
        raise ValueError()
    start, end = _date(query['from'][0]), _date(query['to'][0])
    if end < start or (end - start).days >= MAX_DAYS:
        raise ValueError()
    include = query.get('include', ['tasks,courses'])[0].split(',')
    if not include or len(include) != len(set(include)) or set(include) - {'tasks', 'courses'}:
        raise ValueError()
    visible = shared_state(c, viewer)
    lo, hi = start.isoformat(), end.isoformat()
    tasks = []
    if 'tasks' in include:
        for task in visible['tasks']:
            milestones = [{**m, 'display_name': (task.get('short_title') or task['title']) + ' · ' + (m['label'] or '关键节点'),
                           'end_date': m['stop_at'][:10], 'end_time': m['stop_at'][11:16]}
                          for m in task.get('milestones', []) if lo <= m['stop_at'][:10] <= hi]
            overlaps = task['date'] <= hi and task['end_date'] >= lo
            item = {k: task.get(k) for k in ('id', 'title', 'category', 'date', 'end_date',
                                              'start_time', 'end_time', 'done', 'notes', 'short_title')}
            item['due'] = task.get('due') or None
            item['milestones'] = milestones
            item['continues_before'] = task['date'] < lo or task.get('continues_before', False)
            item['continues_after'] = task['end_date'] > hi or task.get('continues_after', False)
            item['date'] = max(lo, task['date'])
            item['end_date'] = min(hi, task['end_date'])
            if item['start_time'] and task['date'] < lo:
                item['start_time'] = '00:00'
            if item['start_time'] and task['end_date'] > hi:
                item['end_time'] = '23:59'
            if overlaps:
                tasks.append(item)
            # Old consumers read only tasks and end_date/end_time. Project
            # each checkpoint as an end-only event. Do not invent a start: old
            # consumers otherwise select that start and label the event incorrectly.
            duplicates = {}
            for m in milestones:
                key = hashlib.sha256((m['label'] + '\0' + m['stop_at']).encode()).hexdigest()[:16]
                duplicates[key] = duplicates.get(key, 0) + 1
                tasks.append(dict(id=f"{task['id']}:milestone:{key}:{duplicates[key]}",
                                  title=m['display_name'], short_title=task.get('short_title', ''),
                                  category=task['category'], end_date=m['end_date'], end_time=m['end_time'],
                                  done=m.get('done', False), notes='',
                                  milestones=[], kind='milestone', parent_task_id=task['id'],
                                  continues_before=False, continues_after=False))
    courses = [course for course in visible['course_dates'] if lo <= course['date'] <= hi] if 'courses' in include else []
    date_counts = [count for count in visible['date_counts'] if lo <= count['date'] <= hi] if 'tasks' in include else []
    return dict(timezone=TIMEZONE,
                generated_at=dt.datetime.now(dt.timezone.utc).isoformat(),
                requested_range={'from': lo, 'to': hi},
                authorized_range={'from': visible['share']['start'] if visible['share']['enabled'] else '',
                                  'to': visible['share']['end'] if visible['share']['enabled'] else ''},
                share_enabled=visible['share']['enabled'],
                busy_only=visible['share']['busy_only'],
                tasks=tasks, courses=courses, date_counts=date_counts)


def meta(c, viewer):
    visible = shared_state(c, viewer)
    return dict(timezone=TIMEZONE,
                generated_at=dt.datetime.now(dt.timezone.utc).isoformat(),
                semester={'name': visible['settings']['name'] if visible['share']['enabled'] else '',
                          'start': visible['settings']['start'] if visible['share']['enabled'] else ''},
                categories=[{'name': x['name'], 'color': x['color']} for x in visible['categories']],
                share={'enabled': visible['share']['enabled'],
                       'busy_only': visible['share']['busy_only'],
                       'from': visible['share']['start'] if visible['share']['enabled'] else '',
                       'to': visible['share']['end'] if visible['share']['enabled'] else ''})
