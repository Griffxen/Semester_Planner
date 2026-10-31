"""Two HTTP boundaries for mandatory enrollment, protected ownership and viewer PIN."""
from contextlib import closing
import json
import unittest

import app
from sharing import DEFAULT_POLICY
from tests import test_management_api as fixtures


class FirstSetupAPI(unittest.TestCase):
    password = fixtures.ManagementAPI.password
    setUp = fixtures.ManagementAPI.setUp
    tearDown = fixtures.ManagementAPI.tearDown
    request = fixtures.ManagementAPI.request
    refresh = fixtures.ManagementAPI.refresh

    def test_setup_blocks_old_routes_and_other_admin_cannot_reset_root(self):
        with closing(app.connect()) as c, c:
            c.execute('UPDATE users SET root_admin=1 WHERE id=1')
            c.execute('UPDATE users SET admin=1 WHERE id=2')
        status, login = self.request('login', 'POST', dict(name='alice', credential=self.password))
        self.assertEqual(status, 200)
        self.assertTrue(login['setup_required'])
        for path, method, body in [('state','GET',None),('auth/verify','POST',dict(password=self.password)),
                                   ('password','POST',dict(password=self.password,current_password=self.password)),
                                   ('tasks','POST',dict(title='blocked')),('admin/api-reads','GET',None)]:
            status, error = self.request(path, method, body)
            self.assertEqual((status,error['code']),(403,'auth_setup_required'))
        self.assertEqual(self.request('auth/setup','POST',dict(password=self.password,pin='123'))[0],400)
        self.assertTrue(self.request('auth/context')[1]['auth']['setup_required'])
        self.assertEqual(self.request('auth/setup','POST',dict(password=self.password,pin='001234'))[0],200)
        state = self.refresh()
        self.assertTrue(state['user']['root_admin'])
        self.assertFalse(state['auth']['setup_required'])
        self.assertEqual(self.request('auth/devices')[1]['devices'],[])
        other_password='another-strong-password-2026'
        self.assertTrue(self.request('login','POST',dict(name='bob',credential=other_password))[1]['setup_required'])
        self.assertEqual(self.request('auth/setup','POST',dict(password=other_password,pin='002345'))[0],200)
        self.assertEqual(self.request('admin/users/1/permission','PUT',dict(admin=False))[0],403)
        status, error = self.request('users','POST',dict(action='reset',name='alice',password=self.password))
        self.assertEqual((status,error['code']),(403,'root_administrator_protected'))

    def test_viewer_enrollment_trusted_pin_remains_read_only(self):
        app.create_user('reader','reader-password-2026')
        with closing(app.connect()) as c, c:
            reader=c.execute("SELECT id FROM users WHERE name='reader'").fetchone()[0]
            c.execute('INSERT INTO viewers(user_id,owner_id,policy) VALUES(?,1,?)',(reader,json.dumps(DEFAULT_POLICY)))
        self.assertTrue(self.request('login','POST',dict(name='reader',credential='reader-password-2026'))[1]['setup_required'])
        status, result = self.request('auth/setup','POST',dict(password='reader-password-2026',pin='000123',trust_device=True,label='test viewer'))
        self.assertEqual(status,200)
        self.assertTrue(result['auth']['trusted_device'])
        self.assertEqual(self.request('logout','POST',{})[0],200)
        status, result=self.request('login','POST',dict(name='reader',credential='000123'))
        self.assertEqual((status,result['auth']['method']),(200,'pin'))
        self.assertFalse(result['auth']['admin_unlocked'])
        self.assertTrue(self.refresh()['readonly'])
        self.assertEqual(self.request('auth/devices')[0],200)
        for path,method,data in [('tasks','POST',dict(title='blocked')),('users','GET',None),('audit/events','GET',None),('admin/api-reads','GET',None)]:
            self.assertEqual(self.request(path,method,data)[0],403)


if __name__=='__main__': unittest.main()
