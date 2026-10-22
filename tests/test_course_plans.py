"""Isolated domain regressions; never open the application's production database."""
import copy
import datetime as dt
import json
import sqlite3
import unittest

import course_plans as cp
from courses import migrate_ids


class CoursePlans(unittest.TestCase):
    def setUp(self):
        self.c = sqlite3.connect(':memory:'); self.c.row_factory = sqlite3.Row
        self.c.executescript('''
            CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,admin INTEGER);
            INSERT INTO users VALUES(1,'管理员',1),(2,'本人',0),(3,'协作者',0),(4,'展示',0);
            CREATE TABLE settings(user_id INTEGER PRIMARY KEY,name TEXT,start TEXT);
            INSERT INTO settings VALUES(1,'学期','2026-09-07'),(2,'学期','2026-09-07'),(3,'学期','2026-09-07');
            CREATE TABLE viewers(user_id INTEGER PRIMARY KEY,owner_id INTEGER);
            INSERT INTO viewers VALUES(4,2);
            CREATE TABLE timetable_template(id INTEGER PRIMARY KEY,data TEXT);
            CREATE TABLE user_timetable(user_id INTEGER PRIMARY KEY,data TEXT);
            CREATE TABLE holidays(id INTEGER PRIMARY KEY,data TEXT);
            INSERT INTO holidays VALUES(1,'[]');
            CREATE TABLE user_course_exceptions(user_id INTEGER PRIMARY KEY,data TEXT);
            CREATE TABLE course_annotations(user_id INTEGER,course_key TEXT,date TEXT,notes TEXT,
              homework_required INTEGER,homework_notes TEXT,homework_done INTEGER,
              PRIMARY KEY(user_id,course_key,date));
        ''')
        self.old = [dict(course_id='a' * 16, name='数学', day=1, time='08:00–09:00', room='A', weeks='all', start=1, end=18),
                    dict(course_id='b' * 16, name='数学', day=3, time='10:00–11:00', room='B', weeks='odd', start=1, end=16)]
        self.c.execute('INSERT INTO timetable_template VALUES(1,?)', (json.dumps(self.old),))
        self.c.execute('INSERT INTO user_timetable VALUES(2,?)', (json.dumps(self.old),))
        cp.init(self.c)

    def tearDown(self):
        self.c.close()

    def req(self, path, method='GET', data=None, uid=1, status=200):
        actor = self.c.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone()
        result = cp.route(self.c, actor, method, '/api/' + path, data)
        self.assertIsNotNone(result)
        self.assertEqual(result[0], status, result)
        return result[1]

    def slot(self, sid='slot1', **values):
        return dict(dict(slot_id=sid, day=1, time='08:00–09:00', room='A', weeks='all', start=1, end=18,
                         time_mode='clock', period_start='', period_end=''), **values)

    def template(self, name='课表', **values):
        raw = dict(name=name, courses=[dict(course_id='course1', name='英语', slots=[self.slot()])], periods=[], holidays=[])
        raw.update(values)
        return self.req('timetables', 'POST', raw)

    def authorize(self, template, uid=2, use=True, edit=False, public=False):
        return self.req('timetables/' + template['template_id'] + '/permissions', 'PUT',
            dict(version=template['version'], public=public, users=[dict(user_id=uid, use=use, edit=edit)]))

    def import_template(self, template, uid=2, overwrite=None):
        path = 'timetables/' + template['template_id']
        preview = self.req(path + '/import-preview', 'POST', {}, uid)
        result = self.req(path + '/import', 'POST', dict(template_version=preview['template_version'],
             plan_version=preview['plan_version'], overwrite=overwrite or []), uid)
        return result['plan']

    def projection(self):
        return cp.private_projection(self.c, 2, '2026-09-07')

    def test_idempotent_migration_keeps_slot_keys_and_explicit_merge_candidates(self):
        plan = self.req('course-plan', uid=2)
        self.assertEqual(len(plan['courses']), 2)
        self.assertEqual(plan['merge_candidates'][0]['name'], '数学')
        self.assertEqual([x['slots'][0]['slot_id'] for x in plan['courses']], ['a' * 16, 'b' * 16])
        before = self.projection()
        cp.init(self.c); migrate_ids(self.c); cp.init(self.c)
        self.assertEqual(before, self.projection())
        self.assertEqual(self.c.execute('SELECT count(*) FROM course_templates').fetchone()[0], 1)

    def test_multi_slot_same_day_and_odd_even_weeks(self):
        plan = self.req('course-plan', uid=2)
        slots = [self.slot('one', weeks='odd'), self.slot('two', time='10:00–11:00', weeks='even'),
                 self.slot('three', time='13:00–14:00', weeks='odd')]
        plan['courses'] = [dict(course_id='combined', name='同一门课', slots=slots)]
        self.req('course-plan', 'PUT', plan, 2)
        rows = self.projection()['course_dates']
        self.assertEqual(len({x['course_id'] for x in rows}), 1)
        self.assertEqual(len(rows), 27)
        self.assertEqual([x['time'] for x in rows if x['date'] == '2026-09-07'], ['08:00–09:00', '13:00–14:00'])
        self.assertEqual([x['time'] for x in rows if x['date'] == '2026-09-14'], ['10:00–11:00'])

    def test_template_acl_editor_cannot_authorize_or_cross_read(self):
        first = self.template('甲'); second = self.template('乙')
        self.req('timetables/' + first['template_id'], uid=2, status=403)
        grant = self.authorize(first, 3, edit=True)
        editable = self.req('timetables/' + first['template_id'], uid=3)
        self.assertTrue(editable['can_edit']); self.assertFalse(editable['can_manage'])
        editable['name'] = '协作修改'
        saved = self.req('timetables/' + first['template_id'], 'PUT', editable, 3)
        self.req('timetables/' + first['template_id'] + '/permissions', 'PUT', grant, 3, status=403)
        self.req('timetables/' + second['template_id'], uid=3, status=403)
        self.req('timetables/' + first['template_id'], 'PUT', editable, 3, status=409)
        self.req('course-plan', uid=4, status=403)
        self.assertEqual(saved['name'], '协作修改')

    def test_import_is_idempotent_and_sources_do_not_replace_each_other(self):
        first = self.template('甲'); self.authorize(first)
        second = self.template('乙'); self.authorize(second)
        initial = self.import_template(first)
        again = self.import_template(first)
        self.assertEqual(initial['courses'], again['courses'])
        merged = self.import_template(second)
        self.assertEqual(len(merged['courses']), len(initial['courses']) + 1)
        names = [x['name'] for x in merged['courses']]
        self.assertEqual(names.count('英语'), 2)
        self.assertEqual(len(merged['sources']), 3)
        self.req('timetable', 'POST', {}, 2)
        self.assertEqual(len(self.req('course-plan', uid=2)['courses']), len(merged['courses']))

    def test_three_way_import_keeps_personal_conflict_and_applies_source_room(self):
        template = self.template(); self.authorize(template)
        plan = self.import_template(template)
        target = next(x for x in plan['courses'] if x['name'] == '英语')
        target['slots'][0]['time'] = '09:00–10:00'
        self.req('course-plan', 'PUT', plan, 2)
        source = self.req('timetables/' + template['template_id'])
        source['courses'][0]['slots'][0].update(time='11:00–12:00', room='新教室')
        self.req('timetables/' + template['template_id'], 'PUT', source)
        preview = self.req('timetables/' + template['template_id'] + '/import-preview', 'POST', {}, 2)
        self.assertEqual([x['key'] for x in preview['conflicts']], ['slot/slot1/time'])
        kept = self.import_template(template)
        slot = next(x for x in kept['courses'] if x['name'] == '英语')['slots'][0]
        self.assertEqual((slot['time'], slot['room']), ('09:00–10:00', '新教室'))
        source = self.req('timetables/' + template['template_id']); source['courses'][0]['slots'][0]['time'] = '12:00–13:00'
        self.req('timetables/' + template['template_id'], 'PUT', source)
        replaced = self.import_template(template, overwrite=['slot/slot1/time'])
        self.assertEqual(next(x for x in replaced['courses'] if x['name'] == '英语')['slots'][0]['time'], '12:00–13:00')

    def test_revocation_and_archive_keep_private_snapshot_and_deny_future_updates(self):
        template = self.template(); self.authorize(template)
        plan = self.import_template(template)
        source = self.req('timetables/' + template['template_id'])
        self.req('timetables/' + template['template_id'] + '/permissions', 'PUT', dict(version=source['version'], public=False, users=[]))
        kept = self.req('course-plan', uid=2)
        self.assertEqual(kept['courses'], plan['courses'])
        self.assertTrue(next(x for x in kept['sources'] if x['template_id'] == template['template_id'])['unavailable'])
        self.req('timetables/' + template['template_id'] + '/import-preview', 'POST', {}, 2, status=403)
        source = self.req('timetables/' + template['template_id'])
        archived = self.req('timetables/' + template['template_id'] + '/archive', 'POST', dict(version=source['version']))
        self.assertFalse(archived['can_edit']); self.assertTrue(archived['can_manage'])
        self.req('timetables/' + template['template_id'] + '/import-preview', 'POST', {}, status=403)
        self.assertEqual(len(self.projection()['course_dates']), 44)

    def test_preview_rejects_changed_source_personal_or_annotation_version(self):
        template = self.template(); self.authorize(template)
        path = 'timetables/' + template['template_id']
        preview = self.req(path + '/import-preview', 'POST', {}, 2)
        row = self.projection()['course_dates'][0]
        self.req('course-annotations', 'PUT', dict(occurrence_id=row['occurrence_id'], notes='新备注'), 2)
        self.req(path + '/import', 'POST', dict(template_version=preview['template_version'], plan_version=preview['plan_version']), 2, status=409)
        self.assertFalse(any(x['name'] == '英语' for x in self.req('course-plan', uid=2)['courses']))
        preview = self.req(path + '/import-preview', 'POST', {}, 2)
        source = self.req(path); source['name'] = '改名'; self.req(path, 'PUT', source)
        self.req(path + '/import', 'POST', dict(template_version=preview['template_version'], plan_version=preview['plan_version']), 2, status=409)

    def test_rule_removal_and_semester_change_preserve_annotated_original_occurrence(self):
        row = self.projection()['course_dates'][0]
        self.req('course-annotations', 'PUT', dict(occurrence_id=row['occurrence_id'], notes='讲义', homework_required=True, homework_notes='第 2 题'), 2)
        plan = self.req('course-plan', uid=2); plan['courses'][0]['slots'][0]['day'] = 2
        self.req('course-plan', 'PUT', plan, 2)
        archived = next(x for x in self.projection()['course_dates'] if x['occurrence_id'] == row['occurrence_id'])
        self.assertTrue(archived['archived']); self.assertTrue(archived['cancelled'])
        self.assertEqual((archived['original_date'], archived['original_time']), ('2026-09-07', '08:00–09:00'))
        cp.preserve_occurrences(self.c, 2, '2026-09-07'); cp.bump_version(self.c, 2)
        self.c.execute("UPDATE settings SET start='2026-09-14' WHERE user_id=2")
        projection = cp.private_projection(self.c, 2, '2026-09-14')
        self.assertTrue(any(x['occurrence_id'] == row['occurrence_id'] for x in projection['course_dates']))
        self.assertEqual(self.c.execute('SELECT notes FROM course_annotations WHERE user_id=2').fetchone()[0], '讲义')

    def test_source_removal_archives_record_and_keeps_active_reschedule(self):
        row = self.projection()['course_dates'][0]
        self.req('course-exceptions', 'PUT', dict(occurrence_id=row['occurrence_id'], new_date='2026-09-08', new_time='15:00–16:00'), 2)
        template = self.req('timetables/default'); template['courses'] = template['courses'][1:]
        self.req('timetables/default', 'PUT', template)
        self.import_template(template)
        archived = next(x for x in self.projection()['course_dates'] if x['occurrence_id'] == row['occurrence_id'])
        self.assertTrue(archived['archived']); self.assertFalse(archived['cancelled'])
        self.assertEqual((archived['date'], archived['time']), ('2026-09-08', '15:00–16:00'))
        self.assertTrue(self.req('course-plan', uid=2)['archived_courses'])

    def test_linked_makeup_on_holiday_keeps_identity_and_cancellation_semantics(self):
        template = self.req('timetables/default')
        template['holidays'] = [dict(name='停课', start='2026-09-07', end='2026-09-14')]
        self.req('timetables/default', 'PUT', template)
        self.import_template(template)
        row = next(x for x in self.projection()['course_dates'] if x['original_date'] == '2026-09-07')
        self.assertTrue(row['holiday']); self.assertTrue(row['cancelled'])
        payload = dict(course_id=row['course_id'], source_occurrence_id=row['occurrence_id'], date='2026-09-08', time='15:00–16:00')
        self.req('course-makeups', 'POST', payload, 2, status=400)
        created = self.req('course-makeups', 'POST', dict(payload, allow_holiday=True), 2)['occurrence']
        self.assertEqual(created['occurrence_id'], row['occurrence_id']); self.assertFalse(created['cancelled'])
        self.req('course-annotations', 'PUT', dict(occurrence_id=row['occurrence_id'], notes='补课备注'), 2)
        cancelled = self.req('course-makeups/' + row['occurrence_id'], 'PUT', dict(action='cancel'), 2)['occurrence']
        self.assertTrue(cancelled['cancelled']); self.assertEqual(cancelled['date'], '2026-09-08')
        restored = self.req('course-makeups/' + row['occurrence_id'], 'PUT', dict(action='restore'), 2)['occurrence']
        self.assertEqual(restored['date'], row['original_date']); self.assertTrue(restored['cancelled']); self.assertTrue(restored['holiday'])
        self.assertEqual(self.c.execute('SELECT notes FROM course_annotations').fetchone()[0], '补课备注')

    def test_extra_lessons_have_independent_ids_annotations_cancel_restore(self):
        cid = self.req('course-plan', uid=2)['courses'][0]['course_id']
        payload = dict(course_id=cid, date='2026-09-08', time='15:00–16:00', room='C')
        first = self.req('course-makeups', 'POST', payload, 2)['occurrence']
        second = self.req('course-makeups', 'POST', payload, 2)['occurrence']
        self.assertNotEqual(first['occurrence_id'], second['occurrence_id'])
        self.req('course-annotations', 'PUT', dict(course_key=first['course_key'], date=first['original_date'], notes='独立'), 2)
        self.req('course-makeups/' + first['occurrence_id'], 'PUT', dict(action='cancel'), 2)
        rows = self.projection()['course_dates']; self.assertEqual(len([x for x in rows if x['kind'] == 'extra' and not x['cancelled']]), 1)
        self.req('course-makeups/' + first['occurrence_id'], 'PUT', dict(action='restore'), 2)
        self.req('course-annotations', 'PUT', dict(occurrence_id=first['occurrence_id'], notes='仍可编辑'), 3, status=400)
        self.assertEqual(len(self.projection()['course_makeups']), 2)

    def test_period_times_use_each_source_calendar_and_validate_period_deletion(self):
        periods = [dict(id='1', label='第一节', start='08:00', end='08:45'), dict(id='2', label='第二节', start='09:00', end='09:45')]
        template = self.template(periods=periods, courses=[dict(course_id='p', name='节次课', slots=[self.slot(time_mode='period', period_start='1', period_end='2')])])
        self.assertEqual(template['courses'][0]['slots'][0]['time'], '08:00–09:45')
        self.authorize(template); plan = self.import_template(template)
        plan['periods'] = [dict(id='1', label='本人节次', start='17:00', end='18:00')]
        saved = self.req('course-plan', 'PUT', plan, 2)
        self.assertEqual(next(x for x in saved['courses'] if x['name'] == '节次课')['slots'][0]['time'], '08:00–09:45')
        template = self.req('timetables/' + template['template_id']); template['periods'] = periods[:1]
        self.req('timetables/' + template['template_id'], 'PUT', template, status=400)
        self.assertEqual(self.req('timetables/' + template['template_id'])['version'], template['version'])

    def test_merge_preserves_slots_aliases_and_legacy_write_cannot_flatten_v2(self):
        template = self.req('timetables/default')
        first, second = template['courses']; first['slots'].extend(second['slots']); template['courses'] = [first]
        merged = self.req('timetables/default', 'PUT', template)
        self.assertEqual(merged['course_aliases'][second['course_id']], first['course_id'])
        self.req('timetable', 'PUT', dict(courses=self.old), status=409)
        plan = self.import_template(merged)
        self.assertEqual(len(plan['courses']), 1)
        self.assertEqual(len(plan['courses'][0]['slots']), 2)
        before = [r['occurrence_id'] for r in self.projection()['course_dates']]
        self.import_template(merged)
        self.assertEqual(before, [r['occurrence_id'] for r in self.projection()['course_dates']])

    def test_import_retains_personal_empty_courses_and_extra_only_courses(self):
        template = self.template(); self.authorize(template)
        plan = self.req('course-plan', uid=2)
        plan['courses'].extend([dict(course_id='draft', name='待排课', slots=[]),
                                dict(course_id='extra_only', name='只加课', slots=[])])
        self.req('course-plan', 'PUT', plan, 2)
        self.req('course-makeups', 'POST', dict(course_id='extra_only', date='2026-09-08', time='15:00–16:00'), 2)
        imported = self.import_template(template)
        self.assertTrue({'draft', 'extra_only'} <= {x['course_id'] for x in imported['courses']})
        self.import_template(template)
        self.assertTrue(any(x['kind'] == 'extra' and x['course_id'] == 'extra_only' for x in self.projection()['course_dates']))

    def test_source_split_creates_new_personal_course_and_preserves_slot_ids(self):
        template = self.template(courses=[dict(course_id='english', name='英语', slots=[self.slot('morning'), self.slot('evening', day=3)])])
        self.authorize(template); plan = self.import_template(template)
        source = next(x for x in plan['sources'] if x['template_id'] == template['template_id'])
        sid = source['slot_map']['evening']
        current = self.req('timetables/' + template['template_id'])
        second = current['courses'][0]['slots'].pop()
        current['courses'].append(dict(course_id='practice', name='英语实践', slots=[second]))
        self.req('timetables/' + template['template_id'], 'PUT', current)
        plan = self.import_template(template)
        self.assertEqual(len([x for x in plan['courses'] if x['name'].startswith('英语')]), 2)
        practice = next(x for x in plan['courses'] if x['name'] == '英语实践')
        self.assertEqual([x['slot_id'] for x in practice['slots']], [sid])
        self.assertEqual(len(next(x for x in plan['courses'] if x['name'] == '英语')['slots']), 1)

    def test_period_import_keeps_local_period_edit_and_adds_new_source_reference(self):
        periods = [dict(id='1', label='第一节', start='08:00', end='08:45')]
        template = self.template(periods=periods, courses=[dict(course_id='p', name='节次课', slots=[self.slot(time_mode='period', period_start='1', period_end='1')])])
        self.authorize(template); plan = self.import_template(template)
        calendar = next(x for x in plan['calendars'] if x['calendar_id'] == template['template_id'])
        calendar['periods'][0]['label'] = '个人第一节'
        self.req('course-plan', 'PUT', plan, 2)
        source = self.req('timetables/' + template['template_id'])
        source['periods'].append(dict(id='2', label='新第二节', start='09:00', end='09:45'))
        source['courses'][0]['slots'][0].update(period_start='2', period_end='2')
        self.req('timetables/' + template['template_id'], 'PUT', source)
        imported = self.import_template(template)
        calendar = next(x for x in imported['calendars'] if x['calendar_id'] == template['template_id'])
        self.assertEqual([x['label'] for x in calendar['periods']], ['个人第一节', '新第二节'])
        self.assertEqual(next(x for x in imported['courses'] if x['name'] == '节次课')['slots'][0]['time'], '09:00–09:45')

    def test_source_switching_to_period_mode_cannot_erase_personal_clock_time(self):
        template = self.template(); self.authorize(template); plan = self.import_template(template)
        own = next(x for x in plan['courses'] if x['name'] == '英语')
        own['slots'][0]['time'] = '15:00–16:00'
        self.req('course-plan', 'PUT', plan, 2)
        source = self.req('timetables/' + template['template_id'])
        source['periods'] = [dict(id='1', label='一', start='08:00', end='09:00')]
        source['courses'][0]['slots'][0].update(time_mode='period', period_start='1', period_end='1')
        self.req('timetables/' + template['template_id'], 'PUT', source)
        saved = self.import_template(template)
        own = next(x for x in saved['courses'] if x['name'] == '英语')['slots'][0]
        self.assertEqual((own['time'], own['time_mode']), ('15:00–16:00', 'clock'))

    def test_personal_merge_keeps_extra_lessons_in_retained_course(self):
        plan = self.req('course-plan', uid=2); first, second = plan['courses']
        extra = self.req('course-makeups', 'POST', dict(course_id=second['course_id'], date='2026-09-08', time='15:00–16:00'), 2)['occurrence']
        plan = self.req('course-plan', uid=2); first, second = plan['courses']
        first['name'] = '合并后的数学'; first['slots'].extend(second['slots']); plan['courses'] = [first]
        self.req('course-plan', 'PUT', plan, 2)
        row = next(x for x in self.projection()['course_dates'] if x['occurrence_id'] == extra['occurrence_id'])
        self.assertEqual((row['course_id'], row['name']), (first['course_id'], '合并后的数学'))
        self.req('course-annotations', 'PUT', dict(occurrence_id=extra['occurrence_id'], notes='合并后仍在'), 2)


if __name__ == '__main__':
    unittest.main()
