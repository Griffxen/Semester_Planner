"""Retention boundaries and the no-prune-on-failure guarantee."""
import datetime as dt
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import closing

import backup


class Backup(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.out = self.root/'backups'; self.out.mkdir(); self.db = self.root/'source.db'
        with closing(sqlite3.connect(self.db)) as c:
            c.execute('CREATE TABLE sample(value TEXT)'); c.execute("INSERT INTO sample VALUES('保留正文')")
            c.commit()
        self.now = dt.datetime(2026,3,1,1,tzinfo=backup.BJ)

    def tearDown(self): self.temp.cleanup()

    def file(self,stamp):
        path = self.out/('planner-managed-'+stamp+'.db'); path.write_bytes(b'old'); return path

    def test_daily_monthly_union_and_legacy_names(self):
        latest = self.file('20260228-230000-000000')
        duplicate = self.file('20260228-120000-000000')
        boundary = self.file('20260131-230000-000000')  # 30th inclusive day
        january_older = self.file('20260101-230000-000000')
        last_month = self.file('20250430-230000-000000')  # oldest retained month
        too_old = self.file('20250331-230000-000000')
        future = self.file('20260302-000000-000000')
        legacy = self.out/'planner-20200101-000000.db'; legacy.write_bytes(b'legacy')
        malformed = self.file('20261399-999999-000000')
        link = self.out/'planner-managed-20200101-000000-000000.db'; link.symlink_to(legacy)
        target = backup.make_backup(self.db,self.out,self.now)
        self.assertEqual(target.stat().st_mode & 0o777,0o600)
        with closing(sqlite3.connect(target)) as c: self.assertEqual(c.execute('SELECT value FROM sample').fetchone()[0],'保留正文')
        self.assertEqual({p for p in (latest,boundary,last_month,future,legacy,malformed,link,target) if p.exists()},
                         {latest,boundary,last_month,future,legacy,malformed,link,target})
        self.assertFalse(duplicate.exists()); self.assertFalse(january_older.exists()); self.assertFalse(too_old.exists())

    def test_failed_backup_never_prunes_and_bj_filename(self):
        old = self.file('20200101-000000-000000')
        with patch('backup.sqlite3.connect',side_effect=sqlite3.OperationalError('copy failed')):
            with self.assertRaises(sqlite3.OperationalError): backup.make_backup(self.db,self.out,self.now)
        self.assertTrue(old.exists()); self.assertFalse(list(self.out.glob('*.partial')))
        utc = dt.datetime(2026,2,28,18,tzinfo=dt.timezone.utc)
        target = backup.make_backup(self.db,self.out,utc,rotate=False)
        self.assertIn('20260301-020000',target.name); self.assertTrue(old.exists())
        self.assertIsNone(backup.managed_timestamp('planner-managed-20260230-120000-000000.db'))


if __name__=='__main__': unittest.main()
