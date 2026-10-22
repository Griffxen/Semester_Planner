"""Versioned timetable templates, personal snapshots and stable course occurrences.

The caller owns the SQLite transaction. All HTTP mutations additionally use a
savepoint so a rejected import cannot commit half of its changes.
"""
import copy
import datetime as dt
import json
import re
import secrets
from urllib.parse import unquote

from courses import occurs, is_holiday, with_ids

DEFAULT_TEMPLATE = 'default'
_ID = re.compile(r'[A-Za-z0-9_.:-]{1,160}\Z')
_TIME = re.compile(r'([0-2][0-9]:[0-5][0-9])[–—-]([0-2][0-9]:[0-5][0-9])\Z')


class CourseError(Exception):
    def __init__(self, status, error, **payload):
        super().__init__(error)
        self.status = status
        self.payload = dict(error=error, **payload)


def _fail(message='课程数据格式不正确', status=400, **payload):
    raise CourseError(status, message, **payload)


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def _id(value=None):
    if value is None or value == '':
        return secrets.token_hex(8)
    if not isinstance(value, str) or not _ID.fullmatch(value):
        _fail('课程或时段标识无效')
    return value


def _date(value):
    try:
        return dt.date.fromisoformat(value).isoformat()
    except (TypeError, ValueError):
        _fail('请选择有效日期')


def _text(value, maximum=120, required=False):
    if not isinstance(value, str) or len(value) > maximum or (required and not value.strip()):
        _fail('文字为空或超过允许长度')
    return value.strip()


def _time(value):
    if not isinstance(value, str):
        _fail('请填写有效的起止时间')
    match = _TIME.fullmatch(value)
    if not match:
        _fail('请填写 HH:MM–HH:MM 格式的起止时间')
    try:
        start, end = (dt.time.fromisoformat(x) for x in match.groups())
    except ValueError:
        _fail('上课时间无效')
    if start >= end:
        _fail('结束时间必须晚于开始时间')
    return match[1] + '–' + match[2]


def _holidays(raw):
    if not isinstance(raw, list) or len(raw) > 100:
        _fail('停课日期最多 100 项')
    result = []
    for item in raw:
        if not isinstance(item, dict):
            _fail()
        start, end = _date(item.get('start')), _date(item.get('end'))
        if end < start:
            _fail('停课结束日期不能早于开始日期')
        result.append(dict(name=_text(item.get('name'), 60, True), start=start, end=end))
    return result


def _periods(raw):
    if not isinstance(raw, list) or len(raw) > 30:
        _fail('节次最多 30 项')
    result = []; used = set(); last_end = ''
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            _fail()
        key = str(item.get('id', index + 1))
        _id(key)
        if key in used:
            _fail('节次编号不能重复')
        used.add(key)
        times = _time(str(item.get('start', '')) + '–' + str(item.get('end', '')))
        start, end = times.split('–')
        if last_end and start < last_end:
            _fail('节次必须按时间排列且不能重叠')
        last_end = end
        result.append(dict(id=key, label=_text(item.get('label', '第 ' + key + ' 节'), 40, True), start=start, end=end))
    return result


def _normalize(raw, personal=False):
    if not isinstance(raw, dict):
        _fail()
    periods = _periods(raw.get('periods', [])); period_map = {p['id']: p for p in periods}
    calendars = []
    if personal:
        raw_calendars = raw.get('calendars', [])
        if not isinstance(raw_calendars, list) or len(raw_calendars) > 100:
            _fail('来源课表作息无效')
        calendar_ids = set()
        for calendar in raw_calendars:
            if not isinstance(calendar, dict):
                _fail()
            calendar_id = _id(calendar.get('calendar_id') or calendar.get('template_id'))
            if calendar_id in calendar_ids:
                _fail('来源课表作息不能重复')
            calendar_ids.add(calendar_id)
            calendars.append(dict(calendar_id=calendar_id,
                                  name=_text(calendar.get('name', ''), 120),
                                  periods=_periods(calendar.get('periods', [])), holidays=_holidays(calendar.get('holidays', []))))
    calendar_periods = {x['calendar_id']: {p['id']: p for p in x['periods']} for x in calendars}
    courses = raw.get('courses', [])
    if not isinstance(courses, list) or len(courses) > 200:
        _fail('最多 200 门课程')
    result = []; course_ids = set(); slot_ids = set(); total = 0
    for course in courses:
        if not isinstance(course, dict):
            _fail()
        cid = _id(course.get('course_id'))
        if cid in course_ids:
            _fail('课程标识重复')
        course_ids.add(cid)
        slots = course.get('slots', [])
        if not isinstance(slots, list) or len(slots) > 50:
            _fail('每门课程最多 50 个时段')
        new = dict(course_id=cid, name=_text(course.get('name'), 120, True), slots=[])
        for slot in slots:
            if not isinstance(slot, dict):
                _fail()
            sid = _id(slot.get('slot_id'))
            if sid in slot_ids:
                _fail('时段标识重复，合并课程时不要复制时段')
            slot_ids.add(sid); total += 1
            if total > 500:
                _fail('每份课表最多 500 个时段')
            day = slot.get('day'); start = slot.get('start', 1); end = slot.get('end', 18)
            if type(day) is not int or not 1 <= day <= 7 or type(start) is not int or type(end) is not int or not 1 <= start <= end <= 18:
                _fail('星期或起止周次无效')
            weeks = slot.get('weeks', 'all')
            if weeks not in ('all', 'odd', 'even'):
                _fail('请选择每周、单周或双周')
            mode = slot.get('time_mode', 'clock')
            if mode not in ('clock', 'period'):
                _fail('时间输入方式无效')
            calendar_id = slot.get('calendar_id', '') if personal else ''
            lookup = calendar_periods.get(calendar_id, period_map)
            ps = str(slot.get('period_start', '')); pe = str(slot.get('period_end', ''))
            if mode == 'period':
                keys = list(lookup)
                if ps not in lookup or pe not in lookup or keys.index(ps) > keys.index(pe):
                    _fail('节次仍被课程引用，请先调整课程或恢复节次')
                time = _time(lookup[ps]['start'] + '–' + lookup[pe]['end'])
            else:
                time = _time(slot.get('time', '')); ps = pe = ''
            entry = dict(slot_id=sid, day=day, time=time, room=_text(slot.get('room', ''), 120), weeks=weeks,
                         start=start, end=end, time_mode=mode, period_start=ps, period_end=pe)
            if calendar_id:
                if calendar_id not in calendar_periods:
                    _fail('时段引用的来源作息不存在')
                entry['calendar_id'] = calendar_id
            new['slots'].append(entry)
        result.append(new)
    normalized = dict(courses=result, periods=periods, holidays=_holidays(raw.get('holidays', [])))
    if personal:
        normalized['calendars'] = calendars
    return normalized


def _legacy_courses(flat):
    """Never infer course grouping: equal names remain explicit merge candidates."""
    return [dict(course_id='c_' + x['course_id'], name=x['name'], slots=[dict(slot_id=x['course_id'],
             **{k: x[k] for k in ('day', 'time', 'room', 'weeks', 'start', 'end')},
             time_mode='clock', period_start='', period_end='')]) for x in flat]


def _flat(plan):
    return [dict(course_id=s['slot_id'], name=c['name'], **{k: s[k] for k in ('day', 'time', 'room', 'weeks', 'start', 'end')})
            for c in plan['courses'] for s in c['slots']]


def _candidates(courses):
    groups = {}
    for course in courses:
        groups.setdefault(course['name'], []).append(course['course_id'])
    return [dict(name=name, course_ids=ids) for name, ids in groups.items() if len(ids) > 1]


def init(c):
    c.execute('''CREATE TABLE IF NOT EXISTS course_templates(
        template_id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL,
        data TEXT NOT NULL, permissions TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0)''')
    c.execute('''CREATE TABLE IF NOT EXISTS personal_course_plans(
        user_id INTEGER PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL)''')
    c.execute('''CREATE TABLE IF NOT EXISTS course_occurrence_archive(
        user_id INTEGER NOT NULL, occurrence_id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(user_id,occurrence_id))''')
    c.execute('''CREATE TABLE IF NOT EXISTS course_makeups(
        user_id INTEGER NOT NULL, occurrence_id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(user_id,occurrence_id))''')
    if not c.execute('SELECT 1 FROM course_templates WHERE template_id=?', (DEFAULT_TEMPLATE,)).fetchone():
        row = c.execute('SELECT data FROM timetable_template WHERE id=1').fetchone()
        flat = with_ids(json.loads(row[0]) if row else [])
        holidays = json.loads((c.execute('SELECT data FROM holidays WHERE id=1').fetchone() or ['[]'])[0])
        payload = dict(courses=_legacy_courses(flat), periods=[], holidays=holidays, course_aliases={})
        c.execute('INSERT INTO course_templates VALUES(?,?,?,?,?,0)',
                  (DEFAULT_TEMPLATE, '默认课表', 1, _json(payload), _json(dict(public=True, users=[]))))
    for row in c.execute('SELECT user_id FROM user_timetable').fetchall():
        _ensure_plan(c, row[0])


def _template_row(c, tid):
    row = c.execute('SELECT * FROM course_templates WHERE template_id=?', (tid,)).fetchone()
    if not row:
        _fail('课表模板不存在', 404)
    return row


def _template_payload(row):
    return dict(json.loads(row['data']), template_id=row['template_id'], name=row['name'], version=row['version'], archived=bool(row['archived']))


def _viewer(c, uid):
    return bool(c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='viewers'").fetchone() and
                c.execute('SELECT 1 FROM viewers WHERE user_id=?', (uid,)).fetchone())


def _capabilities(c, actor, row):
    if _viewer(c, actor['id']):
        return False, False, False
    admin = bool(actor['admin']); permissions = json.loads(row['permissions'])
    entry = next((u for u in permissions['users'] if u['user_id'] == actor['id']), {})
    use = bool(admin or permissions['public'] or entry.get('use') or entry.get('edit'))
    edit = bool(admin or entry.get('edit'))
    if row['archived']:
        use = edit = admin
    return use, edit, admin


def _access(c, actor, tid, edit=False, manage=False, importing=False):
    row = _template_row(c, tid); use, can_edit, can_manage = _capabilities(c, actor, row)
    if not use or (edit and not can_edit) or (manage and not can_manage) or ((edit or importing) and row['archived']):
        _fail('没有此课表的操作权限或课表已归档', 403)
    return row


def _public_template(c, actor, row):
    _, edit, manage = _capabilities(c, actor, row)
    return dict(_template_payload(row), can_edit=edit and not bool(row['archived']), can_manage=manage,
                merge_candidates=_candidates(json.loads(row['data'])['courses']))


def _source(tid, template, course_map=None, slot_map=None):
    return dict(template_id=tid, name=template['name'], version=template['version'],
                snapshot={k: copy.deepcopy(template[k]) for k in ('courses', 'periods', 'holidays')},
                course_map=course_map or {}, slot_map=slot_map or {})


def _ensure_plan(c, uid):
    row = c.execute('SELECT * FROM personal_course_plans WHERE user_id=?', (uid,)).fetchone()
    if row:
        return row
    flat = json.loads((c.execute('SELECT data FROM user_timetable WHERE user_id=?', (uid,)).fetchone() or ['[]'])[0])
    template = _template_payload(_template_row(c, DEFAULT_TEMPLATE))
    flat = with_ids(flat, _flat(template))
    courses = _legacy_courses(flat)
    plan = dict(courses=courses, periods=[], holidays=[], calendars=[], sources=[], course_aliases={}, archived_courses=[])
    if courses:
        for course in courses:
            for slot in course['slots']:
                slot['calendar_id'] = DEFAULT_TEMPLATE
        plan['calendars'] = [dict(calendar_id=DEFAULT_TEMPLATE, name=template['name'], periods=copy.deepcopy(template['periods']), holidays=copy.deepcopy(template['holidays']))]
        template_slots = {s['slot_id'] for x in template['courses'] for s in x['slots']}
        if any(x['course_id'] in template_slots for x in flat):
            plan['sources'] = [_source(DEFAULT_TEMPLATE, template,
                {x['course_id']: x['course_id'] for x in template['courses'] if any(s['slot_id'] in {r['course_id'] for r in flat} for s in x['slots'])},
                {x['course_id']: x['course_id'] for x in flat if x['course_id'] in template_slots})]
    c.execute('INSERT INTO personal_course_plans VALUES(?,1,?)', (uid, _json(plan)))
    _sync_flat(c, uid, plan)
    return c.execute('SELECT * FROM personal_course_plans WHERE user_id=?', (uid,)).fetchone()


def get_plan(c, uid):
    row = _ensure_plan(c, uid); plan = json.loads(row['data']); plan['version'] = row['version']
    plan['merge_candidates'] = _candidates(plan['courses'])
    actor = c.execute('SELECT id,admin FROM users WHERE id=?', (uid,)).fetchone()
    for source in plan['sources']:
        row = c.execute('SELECT * FROM course_templates WHERE template_id=?', (source['template_id'],)).fetchone()
        source['unavailable'] = not row or bool(row['archived']) or not _capabilities(c, actor, row)[0]
    return plan


def _sync_flat(c, uid, plan):
    c.execute('INSERT OR REPLACE INTO user_timetable VALUES(?,?)', (uid, _json(_flat(plan))))


def _save_plan(c, uid, plan, expected=None):
    existing = _ensure_plan(c, uid)
    if expected is not None and type(expected) is not int:
        _fail('请提供个人课表版本', 409)
    if expected is not None and existing['version'] != expected:
        _fail('个人课表已变化，请刷新或重新预览', 409, plan_version=existing['version'])
    stored = copy.deepcopy(plan)
    for key in ('version', 'merge_candidates'):
        stored.pop(key, None)
    for source in stored.get('sources', []):
        source.pop('unavailable', None)
    c.execute('UPDATE personal_course_plans SET version=version+1,data=? WHERE user_id=?', (_json(stored), uid))
    _sync_flat(c, uid, stored)
    return get_plan(c, uid)


def _start(c, uid):
    row = c.execute('SELECT start FROM settings WHERE user_id=?', (uid,)).fetchone()
    if not row:
        _fail('请先设置学期开始日期')
    return row[0]


def _exceptions(c, uid):
    return json.loads((c.execute('SELECT data FROM user_course_exceptions WHERE user_id=?', (uid,)).fetchone() or ['[]'])[0])


def _write_exceptions(c, uid, changes):
    c.execute('INSERT OR REPLACE INTO user_course_exceptions VALUES(?,?)', (uid, _json(changes)))


def _occurrences(c, uid, start, plan=None):
    plan = plan or get_plan(c, uid); origin = dt.date.fromisoformat(start)
    changes = {(x['course_key'], x['date']): x for x in _exceptions(c, uid)}
    calendars = {x['calendar_id']: x['holidays'] for x in plan['calendars']}
    result = {}; snapshots = {r['occurrence_id']: json.loads(r['data']) for r in c.execute('SELECT occurrence_id,data FROM course_occurrence_archive WHERE user_id=?', (uid,))}
    slots = {s['slot_id']: (course, s) for course in plan['courses'] for s in course['slots']}
    for sid, (course, slot) in slots.items():
        holidays = calendars.get(slot.get('calendar_id'), plan['holidays'])
        for offset in range(126):
            day = origin + dt.timedelta(days=offset)
            if not occurs(slot, origin, day):
                continue
            original = day.isoformat(); oid = sid + ':' + original; change = changes.get((sid, original), {})
            explicit = bool(change.get('new_date') or change.get('new_time')) and not change.get('cancelled')
            actual = change.get('new_date') or original
            holiday = is_holiday(actual, holidays)
            cancelled = bool(change.get('cancelled') or (holiday and not explicit))
            row = dict(course_id=course['course_id'], slot_id=sid, occurrence_id=oid, course_key=sid,
                       original_date=original, original_time=change.get('original_time') or snapshots.get(oid, {}).get('original_time') or slot['time'],
                       date=actual, name=course['name'], time=change.get('new_time') or slot['time'], room=change.get('room', slot['room']),
                       cancelled=cancelled, adjusted=bool(change), kind='regular', holiday=holiday, archived=False)
            result[oid] = row
    for oid, snapshot in snapshots.items():
        if oid in result:
            continue
        row = copy.deepcopy(snapshot); row['archived'] = True
        change = changes.get((row['course_key'], row['original_date']), {})
        explicit = bool(change.get('new_date') or change.get('new_time')) and not change.get('cancelled')
        row.update(cancelled=not explicit, adjusted=bool(change), kind='regular')
        if explicit:
            row.update(date=change.get('new_date') or row['original_date'], time=change.get('new_time') or row['original_time'], room=change.get('room', row['room']))
        result[oid] = row
    # Existing v1 exceptions may have been saved before this module was installed.
    for (sid, original), change in changes.items():
        oid = sid + ':' + original
        if oid in result or sid not in slots:
            continue
        course, slot = slots[sid]; explicit = bool(change.get('new_date') or change.get('new_time')) and not change.get('cancelled')
        result[oid] = dict(course_id=course['course_id'], slot_id=sid, occurrence_id=oid, course_key=sid,
            original_date=original, original_time=change.get('original_time') or slot['time'], date=change.get('new_date') or original,
            name=course['name'], time=change.get('new_time') or slot['time'], room=change.get('room', slot['room']),
            cancelled=not explicit, adjusted=True, kind='regular', holiday=False, archived=True)
    for record in c.execute('SELECT data FROM course_makeups WHERE user_id=?', (uid,)):
        makeup = json.loads(record[0]); oid = makeup['occurrence_id']
        if makeup['kind'] == 'extra':
            row = copy.deepcopy(makeup['original'])
        else:
            row = copy.deepcopy(result.get(oid) or makeup['original'])
        row.update(date=makeup['date'], time=makeup['time'], room=makeup['room'], kind=makeup['kind'],
                   cancelled=bool(makeup.get('cancelled')), adjusted=True)
        result[oid] = row
    course_names = {x['course_id']: x['name'] for x in plan['courses']}
    for row in result.values():
        row['course_id'] = plan.get('course_aliases', {}).get(row['course_id'], row['course_id'])
        if row['course_id'] in course_names:
            row['name'] = course_names[row['course_id']]
    return sorted(result.values(), key=lambda x: (x['date'], x['time'], x['occurrence_id']))


def private_projection(c, uid, start):
    plan = get_plan(c, uid)
    return dict(course_plan=plan, timetable=_flat(plan), course_dates=_occurrences(c, uid, start, plan),
                holidays=copy.deepcopy(plan['holidays']) + [h for x in plan['calendars'] for h in x['holidays']],
                course_exceptions=_exceptions(c, uid),
                course_makeups=[json.loads(r[0]) for r in c.execute('SELECT data FROM course_makeups WHERE user_id=?', (uid,))],
                course_occurrence_snapshots=[json.loads(r[0]) for r in c.execute('SELECT data FROM course_occurrence_archive WHERE user_id=?', (uid,))])


def resolve_occurrence(c, uid, occurrence_id=None, course_key=None, date=None, start=None):
    rows = _occurrences(c, uid, start or _start(c, uid))
    if occurrence_id is None and course_key and date:
        return next((row for row in rows if row['course_key'] == course_key and row['original_date'] == date), None)
    if not isinstance(occurrence_id, str):
        return None
    return next((row for row in rows if row['occurrence_id'] == occurrence_id), None)


def bump_version(c, uid):
    """Invalidate import previews when the enclosing settings transaction changes."""
    _ensure_plan(c, uid)
    c.execute('UPDATE personal_course_plans SET version=version+1 WHERE user_id=?', (uid,))


def preserve_occurrences(c, uid, start):
    """Snapshot original arrangements that have personal records before a rule edit."""
    keys = {(r['course_key'], r['date']) for r in c.execute('SELECT course_key,date FROM course_annotations WHERE user_id=?', (uid,))}
    keys.update((x['course_key'], x['date']) for x in _exceptions(c, uid))
    keys.update((json.loads(r[0])['original']['course_key'], json.loads(r[0])['original']['original_date'])
                for r in c.execute('SELECT data FROM course_makeups WHERE user_id=?', (uid,)))
    protected = []
    for row in _occurrences(c, uid, start):
        if (row['course_key'], row['original_date']) not in keys or row['kind'] == 'extra':
            continue
        base = dict(row, date=row['original_date'], time=row['original_time'], cancelled=False, adjusted=False, kind='regular')
        base['source_holidays'] = copy.deepcopy(_occurrence_holidays(get_plan(c, uid), row))
        c.execute('INSERT OR IGNORE INTO course_occurrence_archive VALUES(?,?,?)', (uid, row['occurrence_id'], _json(base)))
        protected.append(row['occurrence_id'])
    return protected


def _aliases(old, new, previous=None):
    aliases = dict(previous or {})
    owners = {s['slot_id']: course['course_id'] for course in new for s in course['slots']}
    remaining = {x['course_id'] for x in new}
    for course in old:
        destinations = {owners[s['slot_id']] for s in course['slots'] if s['slot_id'] in owners}
        if course['course_id'] not in remaining and len(destinations) == 1:
            aliases[course['course_id']] = destinations.pop()
    for key in list(aliases):
        seen = {key}; value = aliases[key]
        while value in aliases and value not in seen:
            seen.add(value); value = aliases[value]
        aliases[key] = value
    return aliases


def _save_template(c, actor, tid, raw):
    old = _access(c, actor, tid, edit=True)
    if type(raw.get('version')) is not int or raw['version'] != old['version']:
        _fail('模板已变化，请保留草稿并刷新', 409, template_version=old['version'])
    normalized = _normalize(raw); normalized['course_aliases'] = _aliases(json.loads(old['data'])['courses'], normalized['courses'], json.loads(old['data']).get('course_aliases'))
    name = _text(raw.get('name', old['name']), 120, True)
    c.execute('UPDATE course_templates SET name=?,version=version+1,data=? WHERE template_id=?', (name, _json(normalized), tid))
    if tid == DEFAULT_TEMPLATE:
        c.execute('UPDATE timetable_template SET data=? WHERE id=1', (_json(_flat(normalized)),))
        c.execute('UPDATE holidays SET data=? WHERE id=1', (_json(normalized['holidays']),))
    return _public_template(c, actor, _template_row(c, tid))


def _save_personal(c, uid, raw):
    old = get_plan(c, uid)
    if raw.get('version') != old['version'] or type(raw.get('version')) is not int:
        _fail('个人课表已变化，请保留草稿并刷新', 409, plan_version=old['version'])
    # Sources and their base snapshots are server-owned, never accepted from a form.
    payload = dict(raw, calendars=raw.get('calendars', old['calendars']))
    normalized = _normalize(payload, personal=True)
    normalized.update(sources=copy.deepcopy(old['sources']), archived_courses=copy.deepcopy(old.get('archived_courses', [])),
                      course_aliases=_aliases(old['courses'], normalized['courses'], old.get('course_aliases')))
    preserve_occurrences(c, uid, _start(c, uid))
    new_slots = {s['slot_id'] for x in normalized['courses'] for s in x['slots']}
    for course in old['courses']:
        removed = [s for s in course['slots'] if s['slot_id'] not in new_slots]
        if removed:
            normalized['archived_courses'].append(dict(course_id=course['course_id'], name=course['name'], slots=removed, reason='个人排课已移除'))
    return _save_plan(c, uid, normalized, old['version'])


def _course_index(courses):
    return {x['course_id']: x for x in courses}


def _slot_index(courses):
    return {s['slot_id']: (x, s) for x in courses for s in x['slots']}


def _merge_periods(base, personal, incoming, overwrite=False):
    """Merge independent period edits so a new source reference stays resolvable."""
    old = {x['id']: x for x in base}; local = {x['id']: x for x in personal}; new = {x['id']: x for x in incoming}
    result = []
    for key in dict.fromkeys([*old, *local, *new]):
        before = old.get(key); own = local.get(key); source = new.get(key)
        if source == before:
            value = own
        elif own == before or own == source or overwrite:
            value = source
        else:
            value = own
        if value is not None:
            result.append(copy.deepcopy(value))
    return sorted(result, key=lambda x: (x['start'], x['id']))


def _import_preview(c, actor, tid):
    template = _template_payload(_access(c, actor, tid, importing=True)); plan = get_plan(c, actor['id'])
    source = next((x for x in plan['sources'] if x['template_id'] == tid), None)
    incoming = {k: copy.deepcopy(template[k]) for k in ('courses', 'periods', 'holidays')}
    changes = []; conflicts = []; operations = []
    def change(key, label, base, personal, incoming_value, operation):
        if incoming_value == base:
            return
        kind = 'added' if base is None else ('removed' if incoming_value is None else 'changed')
        changes.append(dict(key=key, label=label, kind=kind, before=base, after=incoming_value))
        conflict = personal != base and personal != incoming_value
        if conflict:
            conflicts.append(dict(key=key, label=label, base=base, personal=personal, incoming=incoming_value))
        operations.append(dict(key=key, conflict=conflict, **operation))
    base = source['snapshot'] if source else dict(courses=[], periods=[], holidays=[])
    cmap = dict(source['course_map']) if source else {}; smap = dict(source['slot_map']) if source else {}
    old_courses = _course_index(base['courses']); new_courses = _course_index(incoming['courses'])
    local_courses = _course_index(plan['courses']); local_slots = _slot_index(plan['courses'])
    # A merged personal course is located through surviving slots before aliases.
    for cid, course in new_courses.items():
        mapped = cmap.get(cid)
        alias = plan.get('course_aliases', {}).get(mapped, mapped)
        local = local_courses.get(alias)
        if not local:
            local = next((local_slots[smap[s['slot_id']]][0] for s in course['slots'] if smap.get(s['slot_id']) in local_slots), None)
        if cid not in old_courses:
            change('course/' + cid, course['name'], None, None, course['name'], dict(type='course_add', course=course))
        else:
            change('course/' + cid + '/name', course['name'] + ' · 名称', old_courses[cid]['name'], local['name'] if local else None,
                   course['name'], dict(type='course_name', cid=cid, value=course['name']))
    old_slots = _slot_index(base['courses']); new_slots = _slot_index(incoming['courses'])
    for sid, (course, slot) in new_slots.items():
        current = local_slots.get(smap.get(sid)); old_pair = old_slots.get(sid)
        if not old_pair:
            change('slot/' + sid, course['name'] + ' · 新时段', None, None, slot, dict(type='slot_add', cid=course['course_id'], slot=slot))
            continue
        old = old_pair[1]
        time_fields = ('time', 'time_mode', 'period_start', 'period_end')
        change('slot/' + sid + '/time', course['name'] + ' · 时间',
               {k: old.get(k, '') for k in time_fields},
               {k: current[1].get(k, '') for k in time_fields} if current else None,
               {k: slot.get(k, '') for k in time_fields},
               dict(type='slot_time', sid=sid, value={k: slot.get(k, '') for k in time_fields}))
        for field in ('day', 'room', 'weeks', 'start', 'end'):
            change('slot/' + sid + '/' + field, course['name'] + ' · ' + field, old.get(field, ''), current[1].get(field, '') if current else None,
                   slot.get(field, ''), dict(type='slot_field', sid=sid, field=field, value=slot.get(field, '')))
        if old_pair[0]['course_id'] != course['course_id']:
            # Only source merge/split changes move slot ownership; personal grouping stays otherwise.
            mapped_target = cmap.get(course['course_id']); current_owner = current[0]['course_id'] if current else None
            previous_owner = cmap.get(old_pair[0]['course_id'])
            change('slot/' + sid + '/course', course['name'] + ' · 课程归属', previous_owner, current_owner, mapped_target,
                   dict(type='slot_owner', sid=sid, cid=course['course_id']))
    for sid, (course, slot) in old_slots.items():
        if sid in new_slots:
            continue
        current = local_slots.get(smap.get(sid))
        personal = {k: v for k, v in current[1].items() if k != 'calendar_id'} if current else None
        change('slot/' + sid, course['name'] + ' · 移除时段', slot, personal, None, dict(type='slot_remove', sid=sid))
    calendar = next((x for x in plan['calendars'] if x['calendar_id'] == tid), {})
    for field in ('periods', 'holidays'):
        change('calendar/' + field, template['name'] + (' · 作息' if field == 'periods' else ' · 停课日期'),
               base[field], calendar.get(field, []), incoming[field], dict(type='calendar', field=field, value=incoming[field]))
    annotations = {(r['course_key'], r['date']) for r in c.execute('SELECT course_key,date FROM course_annotations WHERE user_id=?', (actor['id'],))}
    annotations.update((x['course_key'], x['date']) for x in _exceptions(c, actor['id']))
    protected = [r for r in _occurrences(c, actor['id'], _start(c, actor['id']), plan) if (r['course_key'], r['original_date']) in annotations]
    return dict(template_version=template['version'], plan_version=plan['version'], changes=changes, conflicts=conflicts,
                protected_occurrences=protected, _operations=operations, _template=template)


def _do_import(c, actor, tid, data):
    preview = _import_preview(c, actor, tid)
    if data.get('template_version') != preview['template_version'] or data.get('plan_version') != preview['plan_version']:
        _fail('源模板或个人课表已变化，请重新预览', 409, template_version=preview['template_version'], plan_version=preview['plan_version'])
    overwrite = data.get('overwrite', [])
    if not isinstance(overwrite, list) or any(not isinstance(x, str) for x in overwrite):
        _fail('覆盖选项无效')
    if set(overwrite) - {x['key'] for x in preview['conflicts']}:
        _fail('覆盖选项已失效，请重新预览', 409)
    plan = get_plan(c, actor['id']); template = preview['_template']; uid = actor['id']
    preserve_occurrences(c, uid, _start(c, uid))
    source = next((x for x in plan['sources'] if x['template_id'] == tid), None)
    if not source:
        source = _source(tid, template)
        source['snapshot'] = dict(courses=[], periods=[], holidays=[])
        plan['sources'].append(source)
    cmap = source['course_map']; smap = source['slot_map']
    existing_calendar = next((x for x in plan['calendars'] if x['calendar_id'] == tid), None)
    if not existing_calendar:
        existing_calendar = dict(calendar_id=tid, name=template['name'], periods=[], holidays=[]); plan['calendars'].append(existing_calendar)
    existing_calendar['name'] = template['name']
    def local_course(cid, create=False):
        src = next((x for x in template['courses'] if x['course_id'] == cid), None)
        mapped = cmap.get(cid); mapped = plan.get('course_aliases', {}).get(mapped, mapped)
        found = next((x for x in plan['courses'] if x['course_id'] == mapped), None)
        if not found and cid in cmap:
            slots = _slot_index(plan['courses'])
            found = next((slots[smap[s['slot_id']]][0] for s in (src or {}).get('slots', []) if smap.get(s['slot_id']) in slots), None)
        if not found and create:
            mapped = ('c_' + next(iter(src['slots']))['slot_id']) if tid == DEFAULT_TEMPLATE and src and src['slots'] else _id()
            if any(x['course_id'] == mapped for x in plan['courses']):
                mapped = _id()
            found = dict(course_id=mapped, name=src['name'] if src else '课程', slots=[]); plan['courses'].append(found)
        if found:
            cmap[cid] = found['course_id']
        return found
    for operation in preview['_operations']:
        if operation['conflict'] and operation['key'] not in overwrite and not (operation['type'] == 'calendar' and operation['field'] == 'periods'):
            continue
        kind = operation['type']
        if kind == 'course_add':
            local_course(operation['course']['course_id'], True)
        elif kind == 'course_name':
            course = local_course(operation['cid'], True); course['name'] = operation['value']
        elif kind == 'slot_add':
            slot = copy.deepcopy(operation['slot']); sid = slot['slot_id']; local = _slot_index(plan['courses']).get(smap.get(sid))
            if not local:
                target = sid if tid == DEFAULT_TEMPLATE and sid not in _slot_index(plan['courses']) else _id()
                smap[sid] = target; slot.update(slot_id=target, calendar_id=tid)
                local_course(operation['cid'], True)['slots'].append(slot)
        elif kind == 'slot_field':
            pair = _slot_index(plan['courses']).get(smap.get(operation['sid']))
            if pair:
                pair[1][operation['field']] = operation['value']
        elif kind == 'slot_time':
            pair = _slot_index(plan['courses']).get(smap.get(operation['sid']))
            if pair:
                pair[1].update(operation['value'])
        elif kind == 'slot_owner':
            pair = _slot_index(plan['courses']).get(smap.get(operation['sid']))
            if pair:
                target = local_course(operation['cid'], True)
                if target is not pair[0]:
                    pair[0]['slots'].remove(pair[1]); target['slots'].append(pair[1])
        elif kind == 'slot_remove':
            pair = _slot_index(plan['courses']).get(smap.get(operation['sid']))
            if pair:
                plan.setdefault('archived_courses', []).append(dict(course_id=pair[0]['course_id'], name=pair[0]['name'], slots=[copy.deepcopy(pair[1])], reason='来源已移除'))
                pair[0]['slots'].remove(pair[1])
        elif kind == 'calendar':
            if operation['field'] == 'periods':
                existing_calendar['periods'] = _merge_periods(source['snapshot']['periods'], existing_calendar['periods'], operation['value'], operation['key'] in overwrite)
            else:
                existing_calendar[operation['field']] = copy.deepcopy(operation['value'])
    # Empty groups may be deliberate drafts or own extra lessons, including ones
    # from another source. Only collect this source's removed, unchanged groups.
    base_courses = _course_index(source['snapshot']['courses'])
    incoming_courses = _course_index(template['courses'])
    personal_keys = {r[0] for r in c.execute('SELECT course_key FROM course_annotations WHERE user_id=?', (uid,))}
    personal_keys.update(x['course_key'] for x in _exceptions(c, uid))
    makeup_courses = {json.loads(r[0])['original']['course_id'] for r in c.execute('SELECT data FROM course_makeups WHERE user_id=?', (uid,))}
    disposable = set()
    for cid, course in base_courses.items():
        current_id = cmap.get(cid)
        current_id = plan.get('course_aliases', {}).get(current_id, current_id)
        current = next((x for x in plan['courses'] if x['course_id'] == current_id), None)
        removed = cid not in incoming_courses or bool(course['slots']) and not incoming_courses[cid]['slots']
        source_keys = {smap.get(s['slot_id']) for s in course['slots']}
        if (removed and current and not current['slots'] and current['name'] == course['name']
                and current_id not in makeup_courses and not personal_keys.intersection(source_keys)):
            disposable.add(current_id)
    plan['courses'] = [x for x in plan['courses'] if x['course_id'] not in disposable]
    source.update(name=template['name'], version=template['version'], snapshot={k: copy.deepcopy(template[k]) for k in ('courses', 'periods', 'holidays')})
    # Also resolve period references after a source changes its bell schedule.
    # A failed validation rolls back the complete import through route's savepoint.
    normalized = _normalize(plan, personal=True)
    plan.update(normalized)
    saved = _save_plan(c, uid, plan, preview['plan_version'])
    return dict(ok=True, plan=saved, version=saved['version'], changes=preview['changes'], conflicts=preview['conflicts'])


def _public_preview(preview):
    return {k: v for k, v in preview.items() if not k.startswith('_')}


def _own_occurrence(c, uid, data):
    row = resolve_occurrence(c, uid, data.get('occurrence_id'), data.get('course_key'), data.get('date'))
    if row is None:
        _fail('该课次不属于当前个人课表')
    return row


def _semester_date(c, uid, value):
    value = _date(value); start = dt.date.fromisoformat(_start(c, uid))
    if not start <= dt.date.fromisoformat(value) < start + dt.timedelta(days=126):
        _fail('补课或调课日期必须在当前 18 周学期内')
    return value


def _occurrence_holidays(plan, row):
    slot = _slot_index(plan['courses']).get(row['slot_id'])
    if slot:
        calendar = next((x for x in plan['calendars'] if x['calendar_id'] == slot[1].get('calendar_id')), None)
        return calendar['holidays'] if calendar else plan['holidays']
    return row.get('source_holidays', plan['holidays'])


def _check_holiday(plan, row, date, data):
    if 'allow_holiday' in data and type(data['allow_holiday']) is not bool:
        _fail('停课日期确认值无效')
    if is_holiday(date, _occurrence_holidays(plan, row)) and not data.get('allow_holiday'):
        _fail('所选日期为停课日期，请确认后安排', holiday=True, requires_holiday_confirmation=True)


def _put_annotation(c, uid, data):
    row = _own_occurrence(c, uid, data)
    saved = c.execute('SELECT homework_done FROM course_annotations WHERE user_id=? AND course_key=? AND date=?',
                      (uid, row['course_key'], row['original_date'])).fetchone()
    notes = data.get('notes', ''); instructions = data.get('homework_notes', '')
    required = data.get('homework_required', False); done = data.get('homework_done', bool(saved[0]) if saved else False)
    if not isinstance(notes, str) or len(notes) > 4000 or not isinstance(instructions, str) or len(instructions) > 4000 or type(required) is not bool or type(done) is not bool:
        _fail('备注或作业数据无效')
    c.execute('INSERT OR REPLACE INTO course_annotations(user_id,course_key,date,notes,homework_required,homework_notes,homework_done) VALUES(?,?,?,?,?,?,?)',
              (uid, row['course_key'], row['original_date'], notes, required, instructions, done if required else False))
    preserve_occurrences(c, uid, _start(c, uid))
    plan = _save_plan(c, uid, get_plan(c, uid))
    return dict(ok=True, plan_version=plan['version'])


def _put_exception(c, uid, data):
    row = _own_occurrence(c, uid, data); plan = get_plan(c, uid)
    cancelled = data.get('cancelled', False); new_date = data.get('new_date', ''); new_time = data.get('new_time', '')
    if type(cancelled) is not bool or not isinstance(new_date, str) or not isinstance(new_time, str):
        _fail()
    if cancelled and (new_date or new_time):
        _fail('停课不能同时设置调课时间')
    if new_date:
        new_date = _semester_date(c, uid, new_date)
    if new_time:
        new_time = _time(new_time)
    if new_date or new_time:
        _check_holiday(plan, row, new_date or row['original_date'], data)
    preserve_occurrences(c, uid, _start(c, uid))
    if row['kind'] == 'extra':
        _fail('额外加课请使用补课接口编辑')
    c.execute('DELETE FROM course_makeups WHERE user_id=? AND occurrence_id=?', (uid, row['occurrence_id']))
    changes = [x for x in _exceptions(c, uid) if not (x['course_key'] == row['course_key'] and x['date'] == row['original_date'])]
    if cancelled or new_date or new_time:
        changes.append(dict(course_key=row['course_key'], date=row['original_date'], cancelled=cancelled,
                            new_date=new_date, new_time=new_time, original_time=row['original_time'], allow_holiday=bool(data.get('allow_holiday'))))
    _write_exceptions(c, uid, changes)
    saved = _save_plan(c, uid, plan)
    return dict(ok=True, plan_version=saved['version'])


def _put_makeup(c, uid, data, oid=None):
    plan = get_plan(c, uid)
    if oid:
        existing_row = c.execute('SELECT data FROM course_makeups WHERE user_id=? AND occurrence_id=?', (uid, oid)).fetchone()
        if not existing_row:
            _fail('补课记录不存在', 404)
        makeup = json.loads(existing_row[0]); original = makeup['original']; action = data.get('action', 'update')
        if action not in ('update', 'cancel', 'restore'):
            _fail('补课操作无效')
        if action == 'restore' and makeup['kind'] == 'makeup':
            c.execute('DELETE FROM course_makeups WHERE user_id=? AND occurrence_id=?', (uid, oid))
            _write_exceptions(c, uid, [x for x in _exceptions(c, uid) if not (x['course_key'] == original['course_key'] and x['date'] == original['original_date'])])
            saved = _save_plan(c, uid, plan)
            return dict(ok=True, occurrence=resolve_occurrence(c, uid, oid), plan_version=saved['version'])
        makeup['cancelled'] = action == 'cancel'
        if action == 'update':
            makeup.update(date=_semester_date(c, uid, data.get('date', makeup['date'])),
                          time=_time(data.get('time', makeup['time'])), room=_text(data.get('room', makeup['room']), 120))
            _check_holiday(plan, original, makeup['date'], data)
        elif action == 'restore':
            _check_holiday(plan, original, makeup['date'], data)
    else:
        cid = data.get('course_id'); course = next((x for x in plan['courses'] if x['course_id'] == cid), None)
        if not course:
            _fail('课程不属于当前个人课表')
        source = data.get('source_occurrence_id')
        if source:
            original = resolve_occurrence(c, uid, source)
            if not original or original['course_id'] != cid or original['kind'] == 'extra':
                _fail('关联原课次不属于这门课程')
            oid = original['occurrence_id']; kind = 'makeup'
            old = c.execute('SELECT data FROM course_makeups WHERE user_id=? AND occurrence_id=?', (uid, oid)).fetchone()
            if old:
                original = json.loads(old[0])['original']
        else:
            oid = 'extra:' + _id(); kind = 'extra'; key = _id()
            original = dict(course_id=cid, slot_id=key, occurrence_id=oid, course_key=key,
                            original_date=_semester_date(c, uid, data.get('date')), original_time=_time(data.get('time')),
                            name=course['name'], room='', date=data['date'], time=data['time'], cancelled=False,
                            adjusted=True, kind='extra', holiday=False, archived=False)
            # Extra lessons inherit the first slot's source calendar.
            if course['slots']:
                original['source_holidays'] = copy.deepcopy(_occurrence_holidays(plan, dict(slot_id=course['slots'][0]['slot_id'])))
        makeup = dict(occurrence_id=oid, kind=kind, original=copy.deepcopy(original),
                      date=_semester_date(c, uid, data.get('date')), time=_time(data.get('time')),
                      room=_text(data.get('room', original.get('room', '')), 120), cancelled=False)
        _check_holiday(plan, original, makeup['date'], data)
        preserve_occurrences(c, uid, _start(c, uid))
    c.execute('INSERT OR REPLACE INTO course_makeups VALUES(?,?,?)', (uid, oid, _json(makeup)))
    if makeup['kind'] == 'makeup':
        changes = [x for x in _exceptions(c, uid) if not (x['course_key'] == original['course_key'] and x['date'] == original['original_date'])]
        changes.append(dict(course_key=original['course_key'], date=original['original_date'], cancelled=True,
                            new_date='', new_time='', original_time=original['original_time']))
        _write_exceptions(c, uid, changes)
    saved = _save_plan(c, uid, plan)
    return dict(ok=True, occurrence=resolve_occurrence(c, uid, oid), plan_version=saved['version'])


def legacy_timetable(c, actor, method, data):
    row = _access(c, actor, DEFAULT_TEMPLATE, importing=method == 'POST')
    template = _template_payload(row)
    if method == 'GET':
        return 200, dict(courses=_flat(template), holidays=template['holidays'], version=template['version'])
    if method == 'POST':
        preview = _import_preview(c, actor, DEFAULT_TEMPLATE)
        return 200, _do_import(c, actor, DEFAULT_TEMPLATE, dict(template_version=preview['template_version'], plan_version=preview['plan_version']))
    if method == 'PUT':
        _access(c, actor, DEFAULT_TEMPLATE, edit=True)
        if template['periods'] or any(len(x['slots']) != 1 for x in template['courses']) or template.get('course_aliases'):
            _fail('此课表包含新版课程结构，请使用课表设计器', 409)
        flat = data.get('courses')
        if not isinstance(flat, list) or len(flat) > 100:
            _fail()
        try:
            flat = with_ids(flat, _flat(template)); courses = _legacy_courses(flat)
        except (KeyError, TypeError):
            _fail()
        payload = dict(template, courses=courses, holidays=data.get('holidays', template['holidays']))
        _save_template(c, actor, DEFAULT_TEMPLATE, payload)
        return 200, dict(ok=True)
    return None


def _route(c, actor, method, path, data):
    uid = actor['id']
    if path == '/api/timetable':
        return legacy_timetable(c, actor, method, data)
    if path == '/api/course-plan':
        if method == 'GET':
            return 200, get_plan(c, uid)
        if method == 'PUT':
            return 200, _save_personal(c, uid, data)
    if path == '/api/course-annotations' and method == 'PUT':
        return 200, _put_annotation(c, uid, data)
    if path == '/api/course-exceptions' and method == 'PUT':
        return 200, _put_exception(c, uid, data)
    if path == '/api/course-makeups' and method == 'POST':
        return 200, _put_makeup(c, uid, data)
    if path.startswith('/api/course-makeups/') and method == 'PUT':
        return 200, _put_makeup(c, uid, data, unquote(path[len('/api/course-makeups/'):]))
    if path == '/api/timetables':
        if method == 'GET':
            templates = [_public_template(c, actor, row) for row in c.execute('SELECT * FROM course_templates ORDER BY rowid') if _capabilities(c, actor, row)[0]]
            payload = dict(templates=templates)
            if actor['admin']:
                payload['accounts'] = [dict(r) for r in c.execute('SELECT id,name,admin FROM users ORDER BY id') if not _viewer(c, r['id'])]
            return 200, payload
        if method == 'POST':
            if not actor['admin']:
                _fail('仅管理员可创建模板', 403)
            tid = _id(); payload = _normalize(data); payload['course_aliases'] = {}
            c.execute('INSERT INTO course_templates VALUES(?,?,?,?,?,0)', (tid, _text(data.get('name', '新课表'), 120, True), 1, _json(payload), _json(dict(public=False, users=[]))))
            return 200, _public_template(c, actor, _template_row(c, tid))
    match = re.fullmatch(r'/api/timetables/([^/]+)(?:/(permissions|copy|archive|import-preview|import))?', path)
    if match:
        tid = unquote(match[1]); action = match[2]
        if action is None:
            if method == 'GET':
                return 200, _public_template(c, actor, _access(c, actor, tid))
            if method == 'PUT':
                return 200, _save_template(c, actor, tid, data)
        if action == 'permissions':
            row = _access(c, actor, tid, manage=True)
            if method == 'GET':
                return 200, dict(json.loads(row['permissions']), version=row['version'])
            if method in ('PUT', 'POST'):
                if data.get('version') != row['version']:
                    _fail('授权已变化，请刷新', 409)
                if type(data.get('public', False)) is not bool or not isinstance(data.get('users', []), list):
                    _fail('授权格式无效')
                users = []; seen = set()
                for entry in data.get('users', []):
                    if not isinstance(entry, dict) or type(entry.get('user_id')) is not int or entry['user_id'] in seen or type(entry.get('use', False)) is not bool or type(entry.get('edit', False)) is not bool:
                        _fail('用户授权格式无效')
                    target = entry['user_id']; seen.add(target)
                    if not c.execute('SELECT 1 FROM users WHERE id=?', (target,)).fetchone() or _viewer(c, target):
                        _fail('不能授权不存在的账号或展示账号')
                    users.append(dict(user_id=target, use=bool(entry.get('use') or entry.get('edit')), edit=bool(entry.get('edit'))))
                permissions = dict(public=data.get('public', False), users=users)
                c.execute('UPDATE course_templates SET permissions=?,version=version+1 WHERE template_id=?', (_json(permissions), tid))
                return 200, dict(permissions, version=row['version'] + 1)
        if action == 'copy' and method == 'POST':
            if not actor['admin']:
                _fail('仅管理员可复制模板', 403)
            original = _template_payload(_access(c, actor, tid)); new_id = _id(); body = {k: copy.deepcopy(original[k]) for k in ('courses', 'periods', 'holidays')}
            for course in body['courses']:
                course['course_id'] = _id()
                for slot in course['slots']:
                    slot['slot_id'] = _id()
            body['course_aliases'] = {}
            c.execute('INSERT INTO course_templates VALUES(?,?,?,?,?,0)', (new_id, _text(data.get('name', original['name'] + ' · 副本'), 120, True), 1, _json(body), _json(dict(public=False, users=[]))))
            return 200, _public_template(c, actor, _template_row(c, new_id))
        if action == 'archive' and method == 'POST':
            row = _access(c, actor, tid, manage=True)
            if data.get('version') != row['version']:
                _fail('模板已变化，请刷新', 409)
            c.execute('UPDATE course_templates SET archived=1,version=version+1 WHERE template_id=?', (tid,))
            return 200, _public_template(c, actor, _template_row(c, tid))
        if action == 'import-preview' and method == 'POST':
            return 200, _public_preview(_import_preview(c, actor, tid))
        if action == 'import' and method == 'POST':
            return 200, _do_import(c, actor, tid, data)
    return None


def route(c, actor, method, path, data):
    recognized = path in ('/api/timetable', '/api/course-plan', '/api/course-annotations', '/api/course-exceptions', '/api/course-makeups', '/api/timetables') or path.startswith(('/api/timetables/', '/api/course-makeups/'))
    if not recognized:
        return None
    if _viewer(c, actor['id']):
        return 403, dict(error='展示账户不能管理个人课表或模板')
    if data is not None and not isinstance(data, dict):
        return 400, dict(error='课程请求必须为 JSON 对象')
    c.execute('SAVEPOINT course_request')
    try:
        result = _route(c, actor, method, path, data or {})
        c.execute('RELEASE course_request')
        return result
    except CourseError as error:
        c.execute('ROLLBACK TO course_request'); c.execute('RELEASE course_request')
        return error.status, error.payload
    except Exception:
        c.execute('ROLLBACK TO course_request'); c.execute('RELEASE course_request')
        raise
