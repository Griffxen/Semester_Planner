"""HTTP integration for multi-source timetables and private course records."""
import json
import unittest

import app
import test_app
from sharing import DEFAULT_POLICY, shared_state


class CourseDesignerAPI(unittest.TestCase):
    req = test_app.API.req
    login = test_app.API.login

    def setUp(self):
        test_app.API.setUpClass.__func__(type(self))
        test_app.API.setUp(self)
        self.login()

    def tearDown(self):
        test_app.API.tearDownClass.__func__(type(self))

    def ok(self, path, method='GET', data=None):
        status, body = self.req(path, method, data)
        self.assertEqual(status, 200, body)
        return body

    def template(self, name='专业课'):
        return self.ok('timetables', 'POST', dict(name=name, courses=[dict(
            course_id='1111111111111111', name='数学', slots=[dict(
                slot_id='2222222222222222', day=1, time='09:00–10:00', room='101',
                weeks='all', start=1, end=18, time_mode='clock'), dict(
                slot_id='3333333333333333', day=3, time='13:00–14:00', room='102',
                weeks='all', start=1, end=18, time_mode='clock')])], periods=[],
            holidays=[dict(name='停课', start='2026-09-14', end='2026-09-14')]))

    def import_template(self, template):
        path='timetables/'+template['template_id']
        preview=self.ok(path+'/import-preview', 'POST', {})
        return self.ok(path+'/import', 'POST', dict(
            template_version=preview['template_version'], plan_version=preview['plan_version'], overwrite=[]))

    def test_permissions_revocation_and_personal_snapshot(self):
        template=self.template();path='timetables/'+template['template_id']
        self.req('logout','POST',{});self.login('bob','other-password-123')
        self.assertNotIn(template['template_id'],[t['template_id'] for t in self.ok('timetables')['templates']])
        self.assertEqual(self.req(path)[0],403)
        self.assertEqual(self.req(path+'/import-preview','POST',{})[0],403)
        self.req('logout','POST',{});self.login()
        current=self.ok(path)
        self.ok(path+'/permissions','PUT',dict(version=current['version'],public=False,
            users=[dict(user_id=2,use=True,edit=False)]))
        self.req('logout','POST',{});self.login('bob','other-password-123')
        current=self.ok(path);self.import_template(current)
        self.assertEqual(self.req(path,'PUT',current)[0],403)
        rows=self.ok('state')['course_dates'];self.assertTrue(rows)
        self.req('logout','POST',{});self.login()
        current=self.ok(path)
        self.ok(path+'/permissions','PUT',dict(version=current['version'],public=False,users=[]))
        self.req('logout','POST',{});self.login('bob','other-password-123')
        self.assertEqual(self.req(path)[0],403)
        self.assertEqual(self.req(path+'/import-preview','POST',{})[0],403)
        self.assertEqual(len(self.ok('state')['course_dates']),len(rows))

    def test_makeup_annotations_archive_and_sharing_projection(self):
        template=self.template();self.import_template(template)
        state=self.ok('state')
        source=next(row for row in state['course_dates'] if row['date']=='2026-09-14' and row.get('holiday'))
        annotation=dict(occurrence_id=source['occurrence_id'],notes='私人备注',
            homework_required=True,homework_done=True,homework_notes='私人作业')
        self.ok('course-annotations','PUT',annotation)
        payload=dict(course_id=source['course_id'],source_occurrence_id=source['occurrence_id'],
            date='2026-09-14',time='18:00–19:00',room='201')
        self.assertEqual(self.req('course-makeups','POST',payload)[0],400)
        self.ok('course-makeups','POST',{**payload,'allow_holiday':True})
        def occurrence():
            return next(row for row in self.ok('state')['course_dates'] if row['occurrence_id']==source['occurrence_id'])
        row=occurrence();self.assertFalse(row['cancelled']);self.assertEqual(row['time'],'18:00–19:00')
        self.assertEqual(row['notes'],'私人备注');self.assertTrue(row['homework_done'])
        from urllib.parse import quote
        self.ok('course-makeups/'+quote(source['occurrence_id'],safe=''),'PUT',dict(action='cancel'))
        self.assertTrue(occurrence()['cancelled'])
        plan=self.ok('course-plan');plan['courses'][0]['slots'][0]['day']=2
        self.ok('course-plan','PUT',plan)
        row=occurrence();self.assertEqual(row['notes'],'私人备注')
        with app.connect() as c:
            viewer=dict(user_id=2,owner_id=1,active=1,policy=json.dumps({**DEFAULT_POLICY,
                'enabled':True,'timetable':True,'range':'semester'}))
            visible=shared_state(c,viewer)['course_dates']
        self.assertTrue(all('notes' not in row and 'occurrence_id' not in row for row in visible))
        archive=self.ok('state');self.assertTrue(archive['course_annotations'])

    def test_extra_course_isolation_and_stale_import(self):
        template=self.template();self.import_template(template)
        row=self.ok('state')['course_dates'][0]
        preview=self.ok('timetables/'+template['template_id']+'/import-preview','POST',{})
        self.ok('course-makeups','POST',dict(course_id=row['course_id'],date='2026-09-15',
            time='18:00–19:00',room='203'))
        state=self.ok('state');extra=next(row for row in state['course_dates'] if row['kind']=='extra')
        self.ok('course-annotations','PUT',dict(occurrence_id=extra['occurrence_id'],notes='额外课备注'))
        self.assertEqual(self.req('timetables/'+template['template_id']+'/import','POST',dict(
            template_version=preview['template_version'],plan_version=preview['plan_version'],overwrite=[]))[0],409)
        self.assertEqual(len([r for r in state['course_dates'] if r['kind']=='extra']),1)
        self.req('logout','POST',{});self.login('bob','other-password-123')
        self.assertEqual(self.req('course-annotations','PUT',dict(occurrence_id=extra['occurrence_id'],notes='越权'))[0],400)
        self.assertEqual(self.ok('state')['course_dates'],[])

    def test_multi_source_updates_preserve_local_edits_and_other_source(self):
        first=self.template();first_path='timetables/'+first['template_id']
        second=self.ok(first_path+'/copy','POST',dict(version=first['version'],name='选修课'))
        self.import_template(first);self.import_template(second)
        plan=self.ok('course-plan');self.assertEqual(len(plan['courses']),2)
        source=next(source for source in plan['sources'] if source['template_id']==first['template_id'])
        first_slot=source['slot_map'][first['courses'][0]['slots'][0]['slot_id']]
        own=next(course for course in plan['courses'] if any(slot['slot_id']==first_slot for slot in course['slots']))
        own['name']='个人课程名'
        self.ok('course-plan','PUT',plan)
        current=self.ok(first_path);current['courses'][0]['name']='模板更新课程名'
        self.ok(first_path,'PUT',current)
        self.import_template(self.ok(first_path))
        updated=self.ok('course-plan')
        self.assertEqual(len(updated['courses']),2)
        self.assertIn('个人课程名',[course['name'] for course in updated['courses']])
        self.assertIn('数学',[course['name'] for course in updated['courses']])
        self.import_template(self.ok(first_path))
        self.assertEqual(len(self.ok('course-plan')['courses']),2)


if __name__ == '__main__':
    unittest.main()
