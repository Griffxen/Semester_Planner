"""Focused first-login setup, read-only PIN and root protection boundaries."""
import unittest
from unittest.mock import patch

import authentication as auth
import test_authentication


class AuthSetup(unittest.TestCase):
    password = test_authentication.Authentication.password
    setUp = test_authentication.Authentication.setUp
    tearDown = test_authentication.Authentication.tearDown
    header = test_authentication.Authentication.header
    receive = test_authentication.Authentication.receive
    login = test_authentication.Authentication.login
    state = test_authentication.Authentication.state
    actor = test_authentication.Authentication.actor
    request = test_authentication.Authentication.request

    def test_setup_only_session_atomic_completion_and_preserved_marker(self):
        self.c.execute('DELETE FROM user_auth WHERE user_id=1')
        response = self.login()
        self.assertEqual(response[0], 200)
        self.assertTrue(response[1]['setup_required'])
        self.assertEqual(response[1]['setup_url'], '/setup/')
        self.assertEqual(response[1]['user']['name'], 'alice')
        self.assertEqual(self.state()['auth_method'], 'setup')
        self.assertEqual(self.state()['expires'] - self.now, auth.SETUP_SECONDS)
        self.assertFalse(auth.admin_active(self.actor(), self.state()))
        self.assertEqual(self.request('POST', '/api/auth/verify', dict(password=self.password))[1]['code'], 'auth_setup_required')
        self.assertEqual(self.request('PUT', '/api/auth/pin', dict(pin='012345'))[0], 403)
        before = self.actor()['password']
        self.assertEqual(self.request('POST', '/api/auth/setup', dict(password=self.password, pin='１２３４５６'))[0], 400)
        self.assertEqual(self.actor()['password'], before)
        self.assertTrue(auth.setup_required(self.c, self.actor()))
        self.c.commit()
        with patch.object(auth, '_audit', side_effect=RuntimeError('audit unavailable')):
            with self.assertRaises(RuntimeError), self.c:
                self.request('POST', '/api/auth/setup', dict(password='new-setup-password-2026', pin='012345'))
        self.assertEqual(self.actor()['password'], before)
        self.assertTrue(auth.setup_required(self.c, self.actor()))
        old = self.jar['session']
        response = self.request('POST', '/api/auth/setup', dict(password='new-setup-password-2026', pin='012345'))
        self.assertEqual(response[0], 200)
        self.assertFalse(response[1]['setup_required'])
        self.assertNotEqual(old, self.jar['session'])
        self.assertTrue(response[1]['auth']['admin_unlocked'])
        self.assertNotIn(auth.DEVICE_COOKIE, self.jar)
        self.assertEqual(self.c.execute('SELECT count(*) FROM trusted_devices WHERE revoked=0').fetchone()[0], 0)
        self.assertEqual(self.request('PUT', '/api/auth/pin', dict(pin='000123'))[0], 200)
        self.assertFalse(auth.setup_required(self.c, self.actor()))

    def test_expired_or_legacy_session_cannot_setup_and_viewer_pin_stays_unprivileged(self):
        response = self.login('1234', name='bob')
        self.assertTrue(response[1]['setup_required'])
        stale = self.state()
        actor = self.actor()
        self.now += auth.SETUP_SECONDS
        self.assertIsNone(self.state())
        response = auth.route(self.c, actor, stale, 'POST', '/api/auth/setup',
                              dict(password=self.password, pin='012345'), self.header(), '127.0.0.1', 'test')
        self.assertEqual(response[0], 403)
        self.login('1234', name='bob')
        self.c.execute("UPDATE sessions SET auth_method='legacy' WHERE user_id=2")
        self.assertEqual(self.request('POST', '/api/auth/setup', dict(password=self.password, pin='012345'))[1]['code'], 'auth_setup_session_required')
        self.c.execute('INSERT INTO viewers(user_id,active) VALUES(2,1)')
        self.login('1234', name='bob')
        response = self.request('POST', '/api/auth/setup', dict(password=self.password, pin='000123', trust_device=True, label='展示设备'))
        self.assertEqual(response[0], 200)
        self.assertTrue(response[1]['user']['viewer'])
        self.assertTrue(response[1]['auth']['trusted_device'])
        self.assertFalse(response[1]['auth']['admin_unlocked'])
        self.assertEqual(self.login('000123', name='bob')[1]['auth']['method'], 'pin')
        self.assertEqual(self.request('GET', '/api/auth/devices')[0], 200)
        self.assertEqual(self.request('PUT', '/api/admin/users/1/permission', dict(admin=True))[0], 403)

    def test_root_permission_is_protected_after_account_rename(self):
        self.c.execute('UPDATE users SET root_admin=1 WHERE id=1')
        self.login()
        self.assertTrue(auth.is_root(self.actor()))
        self.assertTrue(self.request('GET', '/api/auth/context')[1]['user']['root_admin'])
        self.assertEqual(self.request('PUT', '/api/admin/users/2/permission', dict(admin=True))[0], 200)
        self.c.execute("UPDATE users SET name='renamed-root' WHERE id=1")
        response = self.request('PUT', '/api/admin/users/1/permission', dict(admin=False))
        self.assertEqual(response[0], 403)
        self.assertEqual(response[1]['code'], 'root_admin_protected')
        self.assertTrue(auth.is_root(self.actor()))
        self.assertTrue(auth.admin_active(self.actor(), self.state()))


if __name__ == '__main__':
    unittest.main()
