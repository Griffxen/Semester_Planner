"""Essential regressions for holidays and persistent personal course changes."""
import json
import unittest
import test_app
import app
from sharing import DEFAULT_POLICY, shared_state


class Courses(unittest.TestCase):
    req=test_app.API.req
    login=test_app.API.login

    def setUp(self):
        test_app.API.setUpClass.__func__(type(self))
        test_app.API.setUp(self)
        self.login()
        self.req('timetable','POST',{})

    def tearDown(self):
        test_app.API.tearDownClass.__func__(type(self))

    def test_annotations_follow_occurrence_and_survive_restore_and_import(self):
        state=self.req('state')[1];row=state['course_dates'][0]
        key=row['course_key'];date=row['original_date']
        data=dict(course_key=key,date=date,notes='带讲义 <script>',homework_required=True,homework_done=True,homework_notes='交第二章习题\n纸质版')
        self.assertEqual(self.req('course-annotations','PUT',data)[0],200)
        def occurrence():
            return next(c for c in self.req('state')[1]['course_dates'] if c['course_key']==key and c['original_date']==date)
        self.assertEqual(occurrence()['notes'],data['notes'])
        other=next(c for c in self.req('state')[1]['course_dates'] if c['course_key']==key and c['original_date']!=date)
        self.assertFalse(other['homework_required'])
        change=dict(course_key=key,date=date,new_date='2026-09-20',new_time='18:00–19:00')
        self.assertEqual(self.req('course-exceptions','PUT',change)[0],200)
        self.assertEqual(occurrence()['date'],'2026-09-20')
        self.assertTrue(occurrence()['homework_required'])
        self.assertTrue(occurrence()['homework_done'])
        self.assertEqual(self.req('course-exceptions','PUT',dict(course_key=key,date=date))[0],200)
        self.assertEqual(self.req('timetable','POST',{})[0],200)
        self.assertEqual(occurrence()['homework_notes'],data['homework_notes'])
        self.assertTrue(occurrence()['homework_done'])
        legacy={k:v for k,v in data.items() if k!='homework_done'}
        self.assertEqual(self.req('course-annotations','PUT',legacy)[0],200)
        self.assertTrue(occurrence()['homework_done'])
        self.assertEqual(self.req('course-annotations','PUT',{**data,'homework_done':False})[0],200)
        self.assertFalse(occurrence()['homework_done'])
        with app.connect() as c:
            viewer=dict(user_id=2,owner_id=1,active=1,policy=json.dumps({**DEFAULT_POLICY,'enabled':True,'timetable':True,'range':'semester'}))
            shared=shared_state(c,viewer)['course_dates']
            self.assertTrue(shared)
            self.assertTrue(all('notes' not in x and 'homework_notes' not in x and 'homework_required' not in x and 'homework_done' not in x for x in shared))
        self.assertEqual(self.req('course-annotations','PUT',{**data,'homework_required':False})[0],200)
        self.assertFalse(occurrence()['homework_required'])
        self.assertFalse(occurrence()['homework_done'])
        for invalid in [dict(homework_required='yes'),dict(homework_done='yes'),dict(homework_done=1),dict(notes='x'*4001),dict(homework_notes=None),dict(course_key='unknown'),dict(date='2026-02-30')]:
            self.assertEqual(self.req('course-annotations','PUT',{**data,**invalid})[0],400)
        self.req('logout','POST',{});self.login('bob','other-password-123')
        self.assertEqual(self.req('course-annotations','PUT',data)[0],400)
        self.req('timetable','POST',{})
        self.assertTrue(all(not c['homework_required'] and not c['homework_done'] and not c['notes'] for c in self.req('state')[1]['course_dates']))

    def test_existing_homework_migration_preserves_content(self):
        row=self.req('state')[1]['course_dates'][0]
        data=dict(course_key=row['course_key'],date=row['original_date'],notes='原备注',homework_required=True,homework_notes='原作业说明')
        self.assertEqual(self.req('course-annotations','PUT',data)[0],200)
        with app.connect() as c:
            c.execute('ALTER TABLE course_annotations DROP COLUMN homework_done')
        app.init();app.init()
        migrated=next(c for c in self.req('state')[1]['course_dates'] if c['course_key']==data['course_key'] and c['original_date']==data['date'])
        self.assertEqual(migrated['notes'],data['notes'])
        self.assertEqual(migrated['homework_notes'],data['homework_notes'])
        self.assertTrue(migrated['homework_required'])
        self.assertFalse(migrated['homework_done'])

    def test_holidays_are_inclusive_and_admin_only(self):
        template=self.req('timetable')[1]
        holiday=dict(name='国庆',start='2026-10-01',end='2026-10-07')
        self.assertEqual(self.req('timetable','PUT',{**template,'holidays':[holiday]})[0],200)
        # Template edits affect a personal snapshot only after an explicit update.
        self.assertTrue(any('2026-10-01'<=c['date']<='2026-10-07' and not c['cancelled'] for c in self.req('state')[1]['course_dates']))
        self.assertEqual(self.req('timetable','POST',{})[0],200)
        state=self.req('state')[1]
        self.assertFalse(any('2026-10-01'<=c['date']<='2026-10-07' and not c['cancelled'] for c in state['course_dates']))
        self.assertTrue(any(c.get('holiday') and c['cancelled'] for c in state['course_dates']))
        self.assertTrue(any(c['date']=='2026-09-30' for c in state['course_dates']))
        self.assertTrue(any(c['date']=='2026-10-08' for c in state['course_dates']))
        self.assertEqual(self.req('timetable','PUT',{**template,'holidays':[{**holiday,'end':'2026-09-30'}]})[0],400)
        self.assertEqual(self.req('course-exceptions','PUT',dict(course_key=template['courses'][1]['course_id'],date='2026-09-14',new_date='2026-10-01'))[0],400)
        self.req('logout','POST',{});self.login('bob','other-password-123')
        self.assertEqual(self.req('timetable','PUT',template)[0],403)
        self.req('timetable','POST',{})
        self.assertFalse(any('2026-10-01'<=c['date']<='2026-10-07' and not c['cancelled'] for c in self.req('state')[1]['course_dates']))

    def test_personal_changes_survive_import_and_restore(self):
        template=self.req('timetable')[1];course=dict(template['courses'][1])
        key=course['course_id'];original='2026-09-14'
        change=dict(course_key=key,date=original,cancelled=True,new_date='',new_time='')
        self.assertEqual(self.req('course-exceptions','PUT',change)[0],200)
        cancelled=next(c for c in self.req('state')[1]['course_dates'] if c['course_key']==key and c['original_date']==original)
        self.assertTrue(cancelled['cancelled'])
        moved={**change,'cancelled':False,'new_date':'2026-09-19','new_time':'09:00–10:00'}
        self.assertEqual(self.req('course-exceptions','PUT',moved)[0],200)
        changed_courses=list(reversed(template['courses']))
        next(c for c in changed_courses if c['course_id']==key)['time']='11:00–12:00'
        self.assertEqual(self.req('timetable','PUT',{'courses':changed_courses})[0],200)
        self.req('timetable','POST',{})
        app.init()  # Restart/migration must keep both identities and overrides.
        state=self.req('state')[1]
        actual=next(c for c in state['course_dates'] if c['course_key']==key and c['original_date']==original)
        self.assertEqual((actual['date'],actual['time'],actual['original_time']),('2026-09-19','09:00–10:00',course['time']))
        self.assertEqual(len(state['course_exceptions']),1)
        self.req('logout','POST',{});self.login('bob','other-password-123');self.req('timetable','POST',{})
        self.assertEqual(self.req('state')[1]['course_exceptions'],[])
        self.assertTrue(any(c['course_key']==key and c['date']==original for c in self.req('state')[1]['course_dates']))
        self.assertEqual(self.req('course-exceptions','PUT',{**moved,'course_key':'unknown'})[0],400)
        self.assertEqual(self.req('course-exceptions','PUT',{**moved,'new_time':'10:00–09:00'})[0],400)
        self.assertEqual(self.req('course-exceptions','PUT',{**moved,'date':'2026-09-15'})[0],400)
        self.assertEqual(self.req('course-exceptions','PUT',change)[0],200)  # Ordinary accounts can change their own classes.
        self.req('logout','POST',{});self.login()
        self.assertEqual(self.req('state')[1]['course_exceptions'][0]['new_date'],'2026-09-19')
        self.assertEqual(self.req('course-exceptions','PUT',{**change,'cancelled':False})[0],200)
        state=self.req('state')[1]
        self.assertEqual(state['course_exceptions'],[])
        restored=next(c for c in state['course_dates'] if c['course_key']==key and c['original_date']==original)
        self.assertEqual((restored['date'],restored['time'],restored['adjusted']),(original,'11:00–12:00',False))

    def test_sharing_uses_actual_dates_and_hides_cancelled_courses(self):
        course=self.req('state')[1]['timetable'][1]
        change=dict(course_key=course['course_id'],date='2026-09-14',cancelled=False,new_date='2026-09-19',new_time='09:00–10:00')
        self.req('course-exceptions','PUT',change)
        self.req('shares','POST',dict(action='create',name='viewer',password='1234',owner_id=1,current_password='test-password-123'))
        viewer=self.req('shares')[1]['shares'][0]
        policy={**DEFAULT_POLICY,'enabled':True,'range':'custom','start':'2026-09-19','end':'2026-09-19','timetable':True}
        self.req('shares','PUT',dict(id=viewer['id'],version=viewer['version'],policy=policy))
        with app.connect() as c:
            record=c.execute('SELECT * FROM viewers WHERE user_id=?',(viewer['id'],)).fetchone()
            dates=shared_state(c,record)['course_dates']
        self.assertEqual(dates,[dict(date='2026-09-19',name=course['name'],time='09:00–10:00',room=course['room'])])
        self.req('course-exceptions','PUT',{**change,'cancelled':True,'new_date':'','new_time':''})
        with app.connect() as c:
            self.assertEqual(shared_state(c,record)['course_dates'],[])
        self.req('logout','POST',{});self.login('viewer','1234')
        self.assertEqual(self.req('course-exceptions','PUT',change)[0],403)


if __name__=='__main__':unittest.main()
