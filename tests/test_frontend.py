"""Transition routes and immutable legacy snapshot; uses no real database."""
import hashlib
import json
import threading
import unittest
import urllib.request
from pathlib import Path

import app


class Frontend(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = 'http://127.0.0.1:' + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_transition_routes_and_local_assets(self):
        for route, mime in [('/', 'text/html'), ('/legacy/', 'text/html'),
                            ('/next/', 'text/html'), ('/next', 'text/html'),
                            ('/legacy/app.js', 'text/javascript'),
                            ('/legacy/share.js', 'text/javascript'),
                            ('/legacy/style.css', 'text/css'),
                            ('/next/app.js', 'text/javascript'),
                            ('/next/icons.js', 'text/javascript'),
                            ('/next/hints.js', 'text/javascript'),
                            ('/next/theme.js', 'text/javascript'),
                            ('/next/modal-shell.js', 'text/javascript'),
                            ('/next/modal-shell.css', 'text/css'),
                            ('/next/dialog-effects.js', 'text/javascript'),
                            ('/next/dialog-effects.css', 'text/css'),
                            ('/next/paint.css', 'text/css'),
                            ('/next/style.css', 'text/css'),
                            ('/next/workload.js', 'text/javascript'),
                            ('/next/workload.css', 'text/css'),
                            ('/m/', 'text/html'), ('/m', 'text/html'),
                            ('/mobile-entry.js', 'text/javascript'),
                            ('/export.js', 'text/javascript'),
                            ('/export.css', 'text/css'),
                            ('/deferred.js', 'text/javascript'),
                            ('/app.js', 'text/javascript'),
                            ('/task-conflicts.js', 'text/javascript'),
                            ('/task-conflicts.css', 'text/css'),
                            ('/deferred.css', 'text/css'),
                            ('/next/deferred.js', 'text/javascript'),
                            ('/next/export-entry.js', 'text/javascript'),
                            ('/m/export-entry.js', 'text/javascript'),
                            ('/m/domain.js', 'text/javascript'),
                            ('/m/app.js', 'text/javascript'),
                            ('/m/tasks.js', 'text/javascript'),
                            ('/m/courses.js', 'text/javascript'),
                            ('/m/manage.js', 'text/javascript'),
                            ('/m/style.css', 'text/css')]:
            with self.subTest(route=route), urllib.request.urlopen(self.url + route) as res:
                self.assertEqual(res.status, 200)
                self.assertTrue(res.headers['Content-Type'].startswith(mime))
                self.assertIn("script-src 'self'", res.headers['Content-Security-Policy'])
        with urllib.request.urlopen(self.url + '/next/') as res:
            html = res.read().decode()
            self.assertIn('href="/legacy/"', html)
            self.assertIn('/app.js', html)
            self.assertIn('/task-conflicts.js', html)
            self.assertLess(html.index('/task-conflicts.js'), html.index('/app.js'))
            self.assertLess(html.index('/next/modal-shell.js'), html.index('/next/app.js'))
        with urllib.request.urlopen(self.url + '/') as res:
            self.assertEqual(res.read(), (app.ROOT / 'static/next/index.html').read_bytes())

    def test_theme_bootstrap_is_csp_compatible_and_precedes_styles(self):
        html = (app.ROOT / 'static/next/index.html').read_text()
        self.assertNotIn('<script>', html)
        self.assertLess(html.index('/next/theme.js'), html.index('/legacy/style.css'))
        self.assertLess(html.index('/next/paint.css'), html.index('/legacy/style.css'))

    def test_legacy_snapshot_hashes(self):
        root = Path(__file__).resolve().parents[1] / 'static' / 'legacy'
        manifest = json.loads((root / 'SHA256SUMS.json').read_text())
        for name, expected in manifest.items():
            with self.subTest(name=name):
                file = root / ('original.html' if name == 'index.html' else name)
                self.assertEqual(hashlib.sha256(file.read_bytes()).hexdigest(), expected)

    def test_mobile_shell_is_independent_and_csp_compatible(self):
        html = (app.ROOT / 'static/mobile/index.html').read_text()
        self.assertNotIn('/legacy/app.js', html)
        self.assertNotIn('/next/app.js', html)
        self.assertNotIn('<script>', html)
        self.assertIn('viewport-fit=cover', html)
        self.assertLess(html.index('/m/app.js'), html.index('/m/tasks.js'))
        self.assertLess(html.index('/task-conflicts.js'), html.index('/m/app.js'))
        for tab in ('agenda', 'overview', 'more'):
            self.assertIn('data-tab="' + tab + '"', html)
        desktop = (app.ROOT / 'static/next/index.html').read_text()
        self.assertLess(desktop.index('/mobile-entry.js'), desktop.index('/app.js'))
