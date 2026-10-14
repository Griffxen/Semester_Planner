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
                            ('/next/paint.css', 'text/css'),
                            ('/next/style.css', 'text/css')]:
            with self.subTest(route=route), urllib.request.urlopen(self.url + route) as res:
                self.assertEqual(res.status, 200)
                self.assertTrue(res.headers['Content-Type'].startswith(mime))
                self.assertIn("script-src 'self'", res.headers['Content-Security-Policy'])
        with urllib.request.urlopen(self.url + '/next/') as res:
            html = res.read().decode()
            self.assertIn('href="/legacy/"', html)
            self.assertIn('/legacy/app.js', html)
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
