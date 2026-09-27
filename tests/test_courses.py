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

    def test_holidays_are_inclusive_and_admin_only(self):
        template=self.req('timetable')[1]
        holiday=dict(name='国庆',start='2026-10-01',end='2026-10-07')
        self.assertEqual(self.req('timetable','PUT',{**template,'holidays':[holiday]})[0],200)
        state=self.req('state')[1]
        self.assertFalse(any('2026-10-01'<=c['date']<='2026-10-07' for c in state['course_dates']))
        self.assertTrue(any(c['date']=='2026-09-30' for c in state['course_dates']))
        self.assertTrue(any(c['date']=='2026-10-08' for c in state['course_dates']))
        self.assertEqual(self.req('timetable','PUT',{**template,'holidays':[{**holiday,'end':'2026-09-30'}]})[0],400)
        self.assertEqual(self.req('course-exceptions','PUT',dict(course_key=template['courses'][1]['course_id'],date='2026-09-14',new_date='2026-10-01'))[0],400)
        self.req('logout','POST',{});self.login('bob','other-password-123')
        self.assertEqual(self.req('timetable','PUT',template)[0],403)
        self.req('timetable','POST',{})
        self.assertFalse(any('2026-10-01'<=c['date']<='2026-10-07' for c in self.req('state')[1]['course_dates']))

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
