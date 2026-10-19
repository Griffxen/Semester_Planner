"""Export selection and permission regressions; isolated database only."""
import copy
import json
import unittest
import test_app
import app
from exporting import project_export


def source():
    return dict(settings=dict(name='测试学期',start='2026-09-07'),readonly=False,
        categories=[dict(name='课程',color='#7185bd')],
        tasks=[dict(id='t1',title='私人任务',short_title='简称',category='课程',date='2026-09-14',end_date='2026-09-18',
            start_time='09:00',end_time='12:00',due='2026-09-22T10:00',done=False,notes='任务秘密',
            milestones=[dict(label='节点',stop_at='2026-09-23T11:00',done=False),dict(label='完成节点',stop_at='2026-09-23T12:00',done=True)])],
        course_dates=[dict(course_key='c1',original_date='2026-09-15',date='2026-09-16',time='09:00-11:00',name='课程名',room='教室',adjusted=True,
            notes='课程秘密',homework_required=True,homework_done=False,homework_notes='作业秘密'),
            dict(course_key='cancel',original_date='2026-09-16',date='2026-09-16',time='12:00',name='取消',room='',cancelled=True)],
        journal=[dict(date='2026-09-16',body='手记秘密')])


class Projection(unittest.TestCase):
    def export(self,**kw):return project_export(source(),dict(range='custom',start='2026-09-16',end='2026-09-23',**kw))
    def test_deferred_reference_is_private_to_complete_backup(self):
        s=source()
        s['tasks'][0].update(deferred=False,deferred_at='',previous_schedule={'date':'2020-01-01','milestones':[{'label':'原节点秘密'}]})
        s['deferred_tasks']=[dict(id='deferred',title='暂缓秘密',deferred=True)]
        selected=project_export(s,dict(range='custom',start='2026-09-01',end='2026-10-01',nodes=False))
        self.assertNotIn('previous_schedule',selected['tasks'][0]);self.assertNotIn('deferred_at',selected['tasks'][0])
        self.assertEqual(selected['tasks'][0]['milestones'],[])
        s['tasks']=[]
        selected=project_export(s,dict(range='custom',start='2026-09-01',end='2026-10-01'))
        self.assertEqual(selected['tasks'],[]);self.assertNotIn('deferred_tasks',selected)
    def test_boundaries_points_and_privacy(self):
        s=source();before=copy.deepcopy(s);d=project_export(s,dict(range='custom',start='2026-09-23',end='2026-09-23'))
        self.assertEqual(s,before);self.assertFalse(d['tasks'][0]['schedule_visible']);self.assertEqual(d['tasks'][0]['date'],'')
        self.assertEqual(len(d['tasks'][0]['milestones']),1);self.assertEqual(d['tasks'][0]['notes'],'')
        d=self.export();self.assertEqual(d['tasks'][0]['date'],'2026-09-16');self.assertEqual(d['tasks'][0]['start_time'],'00:00')
        self.assertTrue(d['tasks'][0]['continues_before']);self.assertEqual(d['journal'],[])
        self.assertNotIn('秘密',json.dumps(d,ensure_ascii=False));self.assertEqual(len(d['course_dates']),1)
        self.assertEqual(d['course_dates'][0]['export_key'],'c1@2026-09-15')
    def test_exclusions_and_optional_fields(self):
        d=self.export(notes=True,course_notes=True,homework=True,journal='selected',journal_dates=['2026-09-16'])
        for text in ['任务秘密','课程秘密','作业秘密','手记秘密']:self.assertIn(text,json.dumps(d,ensure_ascii=False))
        d=self.export(exclude_tasks=['t1'],exclude_courses=['c1@2026-09-15'],journal='all',exclude_journal=['2026-09-16'])
        self.assertEqual(d['tasks'],[]);self.assertEqual(d['course_dates'],[]);self.assertEqual(d['journal'],[])
    def test_busy_scrubs_selection_and_supports_exclusion(self):
        d=self.export(busy_only=True,notes=True,course_notes=True,homework=True,journal='all')
        for text in ['私人任务','简称','秘密','节点','c1','t1','课程名']:self.assertNotIn(text,json.dumps(d,ensure_ascii=False))
        self.assertEqual(d['journal'],[])
        d=self.export(busy_only=True,exclude_tasks=['busy-0'],exclude_courses=['occupied@2026-09-16@09:00-11:00'])
        self.assertEqual(d['tasks'],[]);self.assertEqual(d['course_dates'],[])
    def test_outside_semester_invalid_and_empty(self):
        d=project_export(source(),dict(range='custom',start='2027-01-01',end='2027-01-02'))
        self.assertEqual(d['range']['start'],'2027-01-01');self.assertEqual(d['tasks'],[])
        for p in [dict(range='bad'),dict(range='custom',start='2026-10-01',end='2026-09-01'),dict(done='false'),dict(exclude_tasks='t1')]:
            with self.assertRaises(ValueError):project_export(source(),p)
    def test_restricted_intersection_and_private_course_fields(self):
        s=source();s.update(readonly=True,share=dict(start='2026-09-16',end='2026-09-17'))
        d=project_export(s,dict(range='custom',start='2026-09-01',end='2026-09-30',course_notes=True,homework=True))
        self.assertEqual(d['range'],dict(start='2026-09-16',end='2026-09-17'))
        self.assertNotIn('notes',d['course_dates'][0]);self.assertNotIn('homework_notes',d['course_dates'][0])


class ExportAPI(unittest.TestCase):
    req=test_app.API.req
    login=test_app.API.login
    @classmethod
    def setUpClass(cls):test_app.API.setUpClass.__func__(cls)
    @classmethod
    def tearDownClass(cls):test_app.API.tearDownClass.__func__(cls)
    def setUp(self):test_app.API.setUp(self)
    def test_permissions_and_fresh_projection(self):
        self.assertEqual(self.req('export-preview','POST',{})[0],401);self.login()
        token=self.csrf;self.csrf='bad';self.assertEqual(self.req('export-preview','POST',{})[0],403);self.csrf=token
        self.assertEqual(self.req('export-preview','POST',{})[0],200)
        self.assertEqual(self.req('shares','POST',dict(action='create',name='export-viewer',password='1234',owner_id=1,current_password='test-password-123'))[0],200)
        sh=self.req('shares')[1]['shares'][0];vid=sh['id']
        from sharing import DEFAULT_POLICY
        p={**DEFAULT_POLICY,'enabled':True,'categories':['课程'],'range':'semester','export':True}
        self.assertEqual(self.req('shares','PUT',dict(id=vid,version=sh['version'],policy=p))[0],200)
        self.assertEqual(self.req('export-preview','POST',dict(preview_id=vid))[0],200)
        self.assertEqual(self.req('export-preview','POST',dict(preview_id=vid,format='json'))[0],403)
        self.assertEqual(self.req('export-preview','POST',dict(preview_id=99999))[0],403)
        self.req('logout','POST',{});self.login('export-viewer','1234')
        self.assertEqual(self.req('export-preview','POST',{})[0],200)
        self.assertEqual(self.req('export-preview','POST',dict(format='json'))[0],403)
        self.assertEqual(self.req('export-preview','POST',dict(preview_id=vid))[0],403)
        with app.connect() as c:
            p['export']=False;c.execute('UPDATE viewers SET policy=? WHERE user_id=?',(json.dumps(p),vid))
        self.assertEqual(self.req('export-preview','POST',{})[0],403)
