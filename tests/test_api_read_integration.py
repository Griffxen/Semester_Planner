"""One HTTP scenario for Dashboard read accounting and independent failure handling."""
from contextlib import closing
import hashlib
import http.cookiejar
import json
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app
from sharing import DEFAULT_POLICY
from tests import test_management_api as management_tests


class APIReadIntegration(unittest.TestCase):
    # Reuse only the fixture/helpers; do not inherit unrelated test methods.
    password = management_tests.ManagementAPI.password
    setUp = management_tests.ManagementAPI.setUp
    tearDown = management_tests.ManagementAPI.tearDown
    request = management_tests.ManagementAPI.request
    refresh = management_tests.ManagementAPI.refresh
    login = management_tests.ManagementAPI.login

    def dashboard(self, path, token='', method='GET'):
        request = urllib.request.Request(self.url + '/api/v1/' + path, method=method,
            data=b'{}' if method != 'GET' else None,
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'} if token else {})
        try:
            response = urllib.request.urlopen(request)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def records(self, expected):
        # Response bytes may reach the client just before the independent statistics commit.
        deadline = time.monotonic() + 2
        while True:
            with closing(app.connect()) as c:
                rows = [dict(row) for row in c.execute('SELECT * FROM api_reads ORDER BY id')]
            if len(rows) >= expected or time.monotonic() >= deadline:
                return rows
            threading.Event().wait(.01)

    def test_http_status_accounting_privacy_and_statistics_failure(self):
        token = 'T' * 43
        marker = 'raw-query-must-never-be-stored'
        app.create_user('reader', 'reader-strong-password-2026')
        with closing(app.connect()) as c, c:
            reader = c.execute("SELECT id FROM users WHERE name='reader'").fetchone()[0]
            c.execute('INSERT INTO viewers(user_id,owner_id,policy,dashboard_token_hash) VALUES(?,?,?,?)',
                      (reader, 1, json.dumps(DEFAULT_POLICY), hashlib.sha256(token.encode()).hexdigest()))
        self.assertEqual(self.dashboard('agenda?from=2026-10-30&to=2026-10-30', token)[0], 200)
        self.assertEqual(self.dashboard('agenda/meta', token)[0], 200)
        self.assertEqual(self.dashboard('agenda/meta')[0], 401)
        self.assertEqual(self.dashboard('agenda?from=2026-10-30&to=2026-10-01&secret=' + marker, token)[0], 400)
        self.assertEqual(self.dashboard('agenda/meta', token, 'POST')[0], 405)
        with patch.object(app, 'dashboard_meta', side_effect=RuntimeError('simulated projection failure')), \
                patch.object(app.logging, 'exception'):
            self.assertEqual(self.dashboard('agenda/meta', token)[0], 500)
        rows = self.records(6)
        self.assertEqual(len(rows), 6)
        self.assertEqual(sorted(row['status'] for row in rows), [200, 200, 400, 401, 405, 500])
        self.assertEqual(len({row['request_id'] for row in rows}), 6)
        self.assertTrue(all(row['duration_ms'] >= 0 for row in rows))
        self.assertEqual([row['viewer_id'] for row in rows if row['status'] == 400], [reader])
        self.assertEqual([row['viewer_id'] for row in rows if row['status'] == 500], [reader])
        self.assertTrue(all(row['viewer_id'] is None for row in rows if row['status'] in (401, 405)))
        serialized = json.dumps(rows)
        for secret in (token, hashlib.sha256(token.encode()).hexdigest(), marker, 'Authorization'):
            self.assertNotIn(secret, serialized)
        with patch.object(app.api_reads, 'record', side_effect=RuntimeError('simulated statistics failure')), \
                patch.object(app.logging, 'exception'):
            self.assertEqual(self.dashboard('agenda/meta', token)[0], 200)
        self.login()
        status, body = self.request('admin/api-reads')
        self.assertEqual(status, 200)
        self.assertEqual((body['summary']['total'], body['summary']['success'], body['summary']['failed']), (6, 2, 4))
        self.assertEqual(self.request('auth/admin', 'DELETE', {})[0], 200)
        self.assertEqual(self.request('admin/api-reads')[0], 403)


if __name__ == '__main__':
    unittest.main()
