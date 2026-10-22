"""One-time, explicitly mapped course grouping with business-data accounting.

Run against a consistent rehearsal copy first, then the stopped production DB.
The mapping is private operational data and must not be committed to Git.
"""
import argparse
import copy
import datetime as dt
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app
import course_plans as plans
from courses import expand
from sharing import private_state, shared_state
from dashboard_api import agenda


PROTECTED = ('users', 'sessions', 'attempts', 'settings', 'tasks', 'journal',
             'categories', 'viewers', 'holidays', 'user_course_exceptions', 'course_annotations')


def fingerprint(c, table):
    rows = sorted(json.dumps(dict(row), ensure_ascii=False, sort_keys=True) for row in c.execute('SELECT * FROM '+table))
    return dict(count=len(rows), sha256=hashlib.sha256('\n'.join(rows).encode()).hexdigest())


def flat_map(rows):
    return {row['course_id']: row for row in rows}


def actual(rows):
    return sorted(tuple(row[key] for key in ('course_key', 'original_date', 'date', 'time', 'name', 'room'))
                  for row in rows if not row.get('cancelled'))


def merge(plan, mapping):
    result = copy.deepcopy(plan)
    for group in mapping['groups']:
        pairs = []
        for sid in group['slot_ids']:
            owners = [(course, slot) for course in result['courses'] for slot in course['slots'] if slot['slot_id'] == sid]
            if len(owners) != 1 or owners[0][0]['name'] != group['name']:
                raise ValueError('Approved slot mapping does not match the current course: '+sid)
            pairs.append(owners[0])
        target = pairs[0][0]
        for owner, slot in pairs[1:]:
            if owner is target:
                continue
            target['slots'].append(slot)
            owner['slots'].remove(slot)
        result['courses'] = [course for course in result['courses'] if course['slots']]
    if len(result['courses']) != mapping['expected_courses']:
        raise ValueError('Unexpected course count after grouping')
    if sum(len(course['slots']) for course in result['courses']) != mapping['expected_slots']:
        raise ValueError('Unexpected slot count after grouping')
    return result


def migrate(database, mapping):
    app.DB = database
    c = sqlite3.connect(database);c.row_factory = sqlite3.Row
    try:
        before = {table: fingerprint(c, table) for table in PROTECTED}
        template = flat_map(json.loads(c.execute('SELECT data FROM timetable_template WHERE id=1').fetchone()[0]))
        personal = {row['user_id']: flat_map(json.loads(row['data'])) for row in c.execute('SELECT user_id,data FROM user_timetable')}
        if set(personal) != set(mapping['personal_user_ids']):
            raise ValueError('Personal timetable owners changed; review the migration scope')
        baseline = {}
        holidays_raw = c.execute('SELECT data FROM holidays WHERE id=1').fetchone()[0]
        holidays = json.loads(holidays_raw)
        for uid, timetable in personal.items():
            start = c.execute('SELECT start FROM settings WHERE user_id=?', (uid,)).fetchone()[0]
            exceptions = json.loads((c.execute('SELECT data FROM user_course_exceptions WHERE user_id=?', (uid,)).fetchone() or ['[]'])[0])
            baseline[uid] = actual(expand(list(timetable.values()), start, holidays, exceptions))
        c.close()
        app.init()
        c = app.connect()
        with c:
            admin = c.execute('SELECT * FROM users WHERE admin=1 ORDER BY id LIMIT 1').fetchone()
            tid = mapping['template_id']
            current = plans._public_template(c, admin, plans._template_row(c, tid))
            permissions = plans._template_row(c, tid)['permissions']
            grouped = merge(current, mapping)
            if grouped['courses'] != current['courses']:
                plans._save_template(c, admin, tid, grouped)
            if json.loads(c.execute('SELECT data FROM holidays WHERE id=1').fetchone()[0]) != holidays:
                raise ValueError('Holiday rules changed')
            c.execute('UPDATE holidays SET data=? WHERE id=1', (holidays_raw,))
            for uid in mapping['personal_user_ids']:
                current = plans.get_plan(c, uid)
                grouped = merge(current, mapping)
                if grouped['courses'] != current['courses']:
                    plans._save_personal(c, uid, grouped)
                actor = c.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone()
                preview = plans._import_preview(c, actor, tid)
                plans._do_import(c, actor, tid, dict(template_version=preview['template_version'],
                    plan_version=preview['plan_version'], overwrite=[]))
                projection = private_state(c, uid)
                if actual(projection['course_dates']) != baseline[uid]:
                    raise ValueError('Actual course occurrences changed')
                if flat_map(projection['timetable']) != personal[uid]:
                    raise ValueError('Personal slot values or identities changed')
                for group in mapping['groups']:
                    owners = {course['course_id'] for course in projection['course_plan']['courses']
                              if any(slot['slot_id'] in group['slot_ids'] for slot in course['slots'])}
                    if len(owners) != 1:
                        raise ValueError('Personal course grouping was not preserved')
            if flat_map(json.loads(c.execute('SELECT data FROM timetable_template WHERE id=1').fetchone()[0])) != template:
                raise ValueError('Template slot values or identities changed')
            if plans._template_row(c, tid)['permissions'] != permissions:
                raise ValueError('Template permissions changed')
            after = {table: fingerprint(c, table) for table in PROTECTED}
            if before != after:
                raise ValueError('Protected business data changed: '+','.join(table for table in PROTECTED if before[table] != after[table]))
            today = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).date()
            query = '/api/v1/agenda?from='+today.isoformat()+'&to='+(today+dt.timedelta(days=6)).isoformat()
            for viewer in c.execute('SELECT * FROM viewers'):
                shared_state(c, viewer)
                agenda(c, viewer, query)
            if c.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise ValueError('Database integrity check failed')
        return dict(ok=True, courses=mapping['expected_courses'], slots=mapping['expected_slots'],
                    personal_user_ids=mapping['personal_user_ids'], protected=after,
                    actual_courses_unchanged=True, personal_differences_preserved=True,
                    permissions_preserved=True, sharing_and_dashboard_readable=True)
    finally:
        c.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--mapping', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if not args.database.is_file():
        raise SystemExit('Database does not exist')
    report = migrate(args.database, json.loads(args.mapping.read_text()))
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    args.report.chmod(0o600)
    print(json.dumps({key:value for key,value in report.items() if key != 'protected'}, ensure_ascii=False))
