"""Focused authentication boundaries; no server or real account data required."""
import http.cookies
from pathlib import Path
import sqlite3
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import authentication as auth


class Authentication(unittest.TestCase):
    password = 'a-strong-account-password-2026'

    def setUp(self):
        self.c = sqlite3.connect(':memory:')
        self.c.row_factory = sqlite3.Row
        self.c.executescript('''CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,salt TEXT,password TEXT,admin INTEGER);
            CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id INTEGER,csrf TEXT,expires REAL);
            CREATE TABLE viewers(user_id INTEGER PRIMARY KEY,active INTEGER);''')
        auth.init(self.c)
        for uid, name, password, admin in [(1, 'alice', self.password, 1), (2, 'bob', '1234', 0)]:
            salt = '01' * 16
            self.c.execute('INSERT INTO users(id,name,salt,password,admin) VALUES(?,?,?,?,?)', (uid, name, salt, auth.password_hash(password, salt), admin))
        self.c.execute('INSERT INTO user_auth(user_id,setup_version) VALUES(1,1)')
        self.now = 1800000000.0
        self.clock = patch.object(auth.time, 'time', side_effect=lambda: self.now)
        self.clock.start()
        self.audit = patch.object(auth, '_audit')
        self.audit.start()
        self.jar = {}

    def tearDown(self):
        self.audit.stop()
        self.clock.stop()
        self.c.close()

    def header(self):
        return '; '.join(k + '=' + v for k, v in self.jar.items())

    def receive(self, response):
        for value in response[2]:
            cookie = http.cookies.SimpleCookie(value)
            for key, item in cookie.items():
                if item['max-age'] == '0':
                    self.jar.pop(key, None)
                else:
                    self.jar[key] = item.value
        return response

    def login(self, credential=None, name='alice', **kwargs):
        return self.receive(auth.login(self.c, dict(name=name, credential=credential or self.password, **kwargs),
                                       self.header(), '127.0.0.1', 'test-request'))

    def state(self):
        return auth.session(self.c, self.header())

    def actor(self):
        return self.c.execute('SELECT * FROM users WHERE id=?', (self.state()['user_id'],)).fetchone()

    def request(self, method, path, data=None):
        return self.receive(auth.route(self.c, self.actor(), self.state(), method, path, data or {},
                                       self.header(), '127.0.0.1', 'test-request'))

    def prepare_pin(self):
        self.assertEqual(self.login()[0], 200)
        self.assertEqual(self.request('PUT', '/api/auth/pin', dict(pin='654321'))[0], 200)
        response = self.request('POST', '/api/auth/devices', dict(label='测试设备'))
        self.assertEqual(response[0], 200)
        return response[1]['device']

    def test_pin_requires_device_and_never_grants_management(self):
        self.assertEqual(self.login()[0], 200)
        self.assertTrue(auth.admin_active(self.actor(), self.state()))
        self.prepare_pin()
        trusted_jar = dict(self.jar)
        self.jar = {}
        self.assertEqual(self.login('654321')[0], 401)
        self.jar = trusted_jar
        response = self.login('654321')
        self.assertEqual(response[0], 200)
        self.assertEqual(response[1]['auth']['method'], 'pin')
        self.assertFalse(response[1]['auth']['password_fresh'])
        self.assertFalse(response[1]['auth']['admin_unlocked'])
        self.assertEqual(self.request('PUT', '/api/admin/users/2/permission', dict(admin=True))[0], 403)
        self.assertEqual(self.request('POST', '/api/auth/devices', dict(label='旁路'))[0], 403)
        self.assertEqual(self.request('POST', '/api/auth/password', dict(password='a-new-strong-password'))[0], 403)
        old = self.jar['session']
        response = self.request('POST', '/api/auth/verify', dict(password=self.password))
        self.assertEqual(response[0], 200)
        self.assertNotEqual(old, self.jar['session'])
        self.assertTrue(response[1]['auth']['admin_unlocked'])

    def test_device_expiry_is_fixed_and_bounds_pin_session(self):
        device = self.prepare_pin()
        self.now += 86400
        repeated = self.request('POST', '/api/auth/devices', dict(label='不应续期', current_password=self.password))
        self.assertEqual(repeated[1]['device']['expires'], device['expires'])
        self.now = device['expires'] - 10
        response = self.login('654321')
        self.assertEqual(response[0], 200)
        self.assertEqual(self.state()['expires'], device['expires'])
        self.now = device['expires']
        self.assertIsNone(self.state())
        self.assertEqual(self.login('654321')[0], 401)

    def test_revoking_device_immediately_invalidates_linked_sessions(self):
        device = self.prepare_pin()
        self.assertEqual(self.login('654321')[0], 200)
        pin_jar = dict(self.jar)
        self.jar = {}
        self.assertEqual(self.login()[0], 200)
        response = self.request('DELETE', '/api/auth/devices/' + device['id'])
        self.assertEqual(response[0], 200)
        self.assertIsNotNone(self.state())
        self.jar = pin_jar
        self.assertIsNone(self.state())
        self.assertEqual(self.login('654321')[0], 401)

    def test_management_idle_absolute_and_freshness_expire_separately(self):
        self.assertEqual(self.login()[0], 200)
        started = self.now
        self.now = started + auth.FRESH_SECONDS
        self.assertFalse(auth.fresh(self.state()))
        self.assertTrue(auth.admin_active(self.actor(), self.state()))
        self.now = started + auth.ADMIN_IDLE_SECONDS
        self.assertFalse(auth.admin_active(self.actor(), self.state()))
        self.assertIsNotNone(self.state())
        self.assertEqual(self.request('POST', '/api/auth/verify', dict(password=self.password))[0], 200)
        started = self.now
        for offset in (1700, 3400, 5100, 6800):
            self.now = started + offset
            auth.touch_admin(self.c, self.actor(), self.state())
        self.now = started + auth.ADMIN_ABSOLUTE_SECONDS
        self.assertFalse(auth.admin_active(self.actor(), self.state()))
        self.assertIsNotNone(self.state())

    def test_last_administrator_and_revocation_preserve_planning(self):
        self.login()
        self.assertEqual(self.request('PUT', '/api/admin/users/1/permission', dict(admin=False))[0], 409)
        self.assertEqual(self.request('PUT', '/api/admin/users/2/permission', dict(admin=True))[0], 200)
        self.assertEqual(self.request('PUT', '/api/admin/users/1/permission', dict(admin=False))[0], 200)
        self.assertIsNotNone(self.state())
        self.assertFalse(auth.admin_active(self.actor(), self.state()))
        self.assertEqual(self.request('PUT', '/api/admin/users/2/permission', dict(admin=False))[0], 403)
        self.jar = {}
        response = self.login('1234', name='bob')
        self.assertEqual(response[0], 200)
        self.assertTrue(response[1]['setup_required'])
        self.assertFalse(response[1]['auth']['strong_password'])
        self.assertFalse(response[1]['auth']['admin_unlocked'])
        self.assertEqual(self.request('POST', '/api/auth/verify', dict(password='1234'))[1]['code'], 'auth_setup_required')
        response = self.request('POST', '/api/auth/setup', dict(password=self.password, pin='012345'))
        self.assertEqual(response[0], 200)
        self.assertTrue(response[1]['auth']['admin_unlocked'])
        self.assertFalse(auth.setup_required(self.c, self.actor()))

    def test_pin_lockout_and_password_revocation(self):
        self.prepare_pin()
        for _ in range(5):
            self.assertEqual(self.login('000000')[0], 401)
        self.assertEqual(self.login('654321')[0], 429)
        self.assertEqual(self.login()[0], 200)
        old_jar = dict(self.jar)
        self.assertEqual(self.request('POST', '/api/auth/password', dict(password='new-strong-password-2026'))[0], 200)
        self.assertIsNone(self.state())
        self.jar = old_jar
        self.assertIsNone(self.state())
        self.assertEqual(self.login('654321')[0], 401)


if __name__ == '__main__':
    unittest.main()
