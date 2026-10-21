"""Force actions on isolated data; force never overrides task ownership or version."""
import unittest

import app
import test_app as api_tests


class TaskConflicts(unittest.TestCase):
    setUpClass = classmethod(api_tests.API.setUpClass.__func__)
    tearDownClass = classmethod(api_tests.API.tearDownClass.__func__)
    req = api_tests.API.req
    login = api_tests.API.login

    def setUp(self):
        api_tests.API.setUp(self)
        with app.connect() as c:
            c.execute('DELETE FROM tasks')
        self.login()

    def create(self, **changes):
        data = dict(title='冲突验收', date='2026-10-21', category='科研', done=False,
                    milestones=[dict(label='未完成节点', stop_at='2026-10-21T12:00', done=False),
                                dict(label='已完成节点', stop_at='2026-10-21T13:00', done=True)])
        data.update(changes)
        self.assertEqual(self.req('tasks', 'POST', data)[0], 200)
        return self.state()['tasks'][0] if not data.get('deferred') else self.state()['deferred_tasks'][0]

    def state(self):
        return self.req('state')[1]

    def test_complete_conflict_force_and_edit(self):
        task = self.create()
        path = 'tasks/' + task['id']
        status, result = self.req(path, 'PUT', {**task, 'done': True, 'notes': '待保存草稿'})
        self.assertEqual((status, result['code']), (409, 'unfinished_milestones'))
        self.assertEqual(self.state()['tasks'], [task])
        self.assertEqual(self.req(path, 'PUT', {**task, 'done': True, 'force_complete': 'true'})[0], 400)
        self.assertEqual(self.req(path, 'PUT', {**task, 'done': True, 'force_complete': True})[0], 200)
        completed = self.state()['tasks'][0]
        self.assertTrue(completed['done'])
        self.assertEqual(completed['milestones'], task['milestones'])
        self.assertNotIn('force_complete', completed)
        self.assertEqual(self.req(path, 'PUT', {**completed, 'notes': '已完成任务正常编辑'})[0], 200)
        self.assertEqual(self.req(path, 'PUT', {**task, 'done': True, 'force_complete': True})[0], 409)

    def test_normal_complete_and_reopen(self):
        task = self.create()
        nodes = [{**node, 'done': True} for node in task['milestones']]
        path = 'tasks/' + task['id']
        self.assertEqual(self.req(path, 'PUT', {**task, 'done': True, 'milestones': nodes})[0], 200)
        task = self.state()['tasks'][0]
        self.assertEqual(self.req(path, 'PUT', {**task, 'done': False})[0], 200)
        task = self.state()['tasks'][0]
        self.assertEqual(self.req(path, 'PUT', {**task, 'done': True, 'milestones': []})[0], 200)

    def test_delete_conflict_for_pending_and_completed_and_undo(self):
        for done in (False, True):
            task = self.create(done=done)
            path = 'tasks/' + task['id']
            status, result = self.req(path, 'DELETE', {'version': task['version']})
            self.assertEqual((status, result['code']), (409, 'task_not_deferred'))
            self.assertEqual(self.state()['tasks'], [task])
            self.assertEqual(self.req(path, 'DELETE', {'version': task['version'], 'force_delete': 'true'})[0], 400)
            self.assertEqual(self.req(path, 'DELETE', {'version': task['version'], 'force_delete': True})[0], 200)
            self.assertEqual(self.state()['tasks'], [])
            # POST restoration must retain completed tasks with unfinished nodes.
            self.assertEqual(self.req('tasks', 'POST', task)[0], 200)
            restored = self.state()['tasks'][0]
            self.assertEqual(restored['done'], done)
            self.assertEqual(restored['milestones'], task['milestones'])
            self.assertNotIn('force_delete', restored)
            self.req('tasks/' + restored['id'], 'DELETE', {'version': restored['version'], 'force_delete': True})

    def test_deferred_delete_and_force_permissions(self):
        deferred = self.create(deferred=True)
        self.assertEqual(self.req('tasks/' + deferred['id'], 'DELETE', {'version': deferred['version']})[0], 200)
        task = self.create()
        path = 'tasks/' + task['id']
        self.assertEqual(self.req(path, 'DELETE', {'version': 0, 'force_delete': True})[0], 409)
        token = self.csrf
        self.csrf = 'invalid'
        self.assertEqual(self.req(path, 'DELETE', {'version': task['version'], 'force_delete': True})[0], 403)
        self.csrf = token
        self.req('logout', 'POST', {})
        self.login('bob', 'other-password-123')
        self.assertEqual(self.req(path, 'DELETE', {'version': task['version'], 'force_delete': True})[0], 409)
        self.assertEqual(self.req(path, 'PUT', {**task, 'done': True, 'force_complete': True})[0], 409)
        self.req('logout', 'POST', {})
        self.login()
        self.assertEqual(self.state()['tasks'], [task])
