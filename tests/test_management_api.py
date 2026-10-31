"""Two focused HTTP checks for authentication gates and audit transactions."""
import http.cookiejar
from contextlib import closing
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app


class ManagementAPI(unittest.TestCase):
    password = 'management-integration-password-2026'

    def setUp(self):
        self.old_db = app.DB
        self.temp = tempfile.TemporaryDirectory()
        app.DB = Path(self.temp.name) / 'planner.db'
        app.init()
        app.create_user('alice', self.password)
        app.create_user('bob', 'another-strong-password-2026')
        self.server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:' + str(self.server.server_port)
        self.jar = http.cookiejar.CookieJar()
        self.client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.csrf = ''

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        app.DB = self.old_db
        self.temp.cleanup()

    def request(self, path, method='GET', data=None, client=None):
        request = urllib.request.Request(self.url + '/api/' + path, method=method,
            data=None if data is None else json.dumps(data).encode(),
            headers={'Content-Type': 'application/json', 'X-CSRF-Token': self.csrf})
        try:
            response = (client or self.client).open(request)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = json.load(response)
        if client is None and body.get('csrf'):
            self.csrf = body['csrf']
        return response.status, body

    def refresh(self):
        status, body = self.request('state')
        self.assertEqual(status, 200)
        self.csrf = body['csrf']
        return body

    def login(self, credential=None):
        status, body = self.request('login', 'POST', dict(name='alice', credential=credential or self.password))
        self.assertEqual(status, 200)
        if body.get('setup_required'):
            status, body = self.request('auth/setup', 'POST', dict(password=self.password, pin='005555'))
            self.assertEqual(status, 200)
        self.refresh()
        return body

    def task_count(self):
        with closing(app.connect()) as c:
            return c.execute("SELECT count(*) FROM audit_events WHERE type='task'").fetchone()[0]

    def test_pin_management_gates_and_password_upgrade_over_http(self):
        self.assertTrue(self.login()['auth']['admin_unlocked'])
        self.assertEqual(self.request('auth/pin', 'PUT', dict(pin='012345'))[0], 200)
        self.refresh()
        self.assertEqual(self.request('auth/devices', 'POST', dict(label='集成测试设备'))[0], 200)
        self.refresh()
        pin = self.login('012345')
        self.assertEqual(pin['auth']['method'], 'pin')
        self.assertFalse(pin['auth']['admin_unlocked'])
        self.assertEqual(self.request('users')[0], 403)
        self.assertEqual(self.request('audit/events?scope=all')[0], 403)
        self.assertEqual(self.request('timetables', 'POST', dict(name='测试模板', courses=[], periods=[], holidays=[]))[0], 403)
        self.assertEqual(self.request('tasks', 'POST', dict(title='PIN 仍可规划', category='课程', date='2026-10-30'))[0], 200)
        old_cookie = next(cookie.value for cookie in self.jar if cookie.name == 'session')
        old_csrf = self.csrf
        status, verified = self.request('auth/verify', 'POST', dict(password=self.password))
        self.assertEqual(status, 200)
        self.assertTrue(verified['auth']['admin_unlocked'])
        self.assertNotEqual(old_csrf, self.csrf)
        self.assertNotEqual(old_cookie, next(cookie.value for cookie in self.jar if cookie.name == 'session'))
        self.refresh()
        self.assertEqual(self.request('users')[0], 200)
        self.assertEqual(self.request('admin/users/2/permission', 'PUT', dict(admin=True))[0], 200)
        self.assertEqual(self.request('users', 'POST', dict(action='create', name='wrong-proof',
            password='new-strong-password-2026', current_password='explicitly-wrong-password'))[0], 403)
        stranger = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.assertEqual(self.request('login', 'POST', dict(name='alice', credential='012345'), client=stranger)[0], 401)

    def test_audit_diff_noop_conflict_and_failed_audit_rollback(self):
        self.login()
        self.assertEqual(self.request('tasks', 'POST', dict(title='修改前', category='课程', date='2026-10-30'))[0], 200)
        task = self.refresh()['tasks'][0]
        self.assertEqual(self.request('tasks/' + task['id'], 'PUT', {**task, 'title': '修改后'})[0], 200)
        with closing(app.connect()) as c:
            row = c.execute("SELECT changes FROM audit_events WHERE type='task' ORDER BY id DESC LIMIT 1").fetchone()
        title = next(change for change in json.loads(row['changes']) if change['field'] == 'title')
        self.assertEqual((title['before'], title['after']), ('修改前', '修改后'))
        count = self.task_count()
        current = self.refresh()['tasks'][0]
        self.assertEqual(self.request('tasks/' + current['id'], 'PUT', current)[0], 200)
        changed = self.refresh()['tasks'][0]
        self.assertEqual(changed['version'], current['version'] + 1)
        self.assertEqual(self.task_count(), count)
        self.assertEqual(self.request('tasks/' + current['id'], 'PUT', {**current, 'title': '旧版本覆盖'})[0], 409)
        self.assertEqual(self.task_count(), count)
        with patch.object(app.audit_log, 'record_changes', side_effect=RuntimeError('simulated audit failure')), \
                patch.object(app.logging, 'exception') as logged:
            status, body = self.request('tasks/' + changed['id'], 'PUT', {**changed, 'title': '应当回滚'})
        self.assertEqual(status, 500)
        self.assertIn('request_id', body)
        self.assertNotIn('ok', body)
        logged.assert_called_once()
        after = self.refresh()['tasks'][0]
        self.assertEqual((after['title'], after['version']), (changed['title'], changed['version']))
        self.assertEqual(self.task_count(), count)


if __name__ == '__main__':
    unittest.main()
