"""Two focused groups cover access statistics, privacy, snapshots and exports."""
import csv
import io
import json
import sqlite3
import unittest
from urllib.parse import urlencode

import api_reads


class APIReads(unittest.TestCase):
    def setUp(self):
        self.c = sqlite3.connect(':memory:'); self.c.row_factory = sqlite3.Row
        self.c.execute('CREATE TABLE viewers(user_id INTEGER)'); self.c.execute('INSERT INTO viewers VALUES(2)')
        api_reads.init(self.c); self.c.commit()
        self.admin = dict(id=1,name='管理员',admin=1)
        self.viewer = dict(user_id=2,name='=SUM(1,1)',owner_id=3,dashboard_token_hash='SECRET_HASH')

    def tearDown(self): self.c.close()

    def append(self, endpoint='agenda',status=200,elapsed=10,viewer=True):
        return api_reads.record(self.c,request_id='request-'+str(status),endpoint=endpoint,method='GET',status=status,duration_ms=elapsed,
                                viewer=self.viewer if viewer else None,
                                result=dict(tasks=[dict(notes='SECRET_BODY'),{}],courses=[dict(token='SECRET_TOKEN')],query='SECRET_QUERY'))

    def get(self, export=False,actor=None,unlocked=True,**query):
        path = api_reads.ROOT+('/export' if export else '')
        return api_reads.route(self.c,actor or self.admin,unlocked,'GET',path,path+'?'+urlencode(query),)

    def test_statistics_bj_boundary_privacy_and_permissions(self):
        first = self.append(elapsed=10)
        self.c.execute("UPDATE api_reads SET created_at='2026-09-30T16:00:00.000001+00:00' WHERE id=?",(first,))
        second = self.append(status=401,elapsed=30,viewer=False)
        self.c.execute("UPDATE api_reads SET created_at='2026-10-01T01:00:00.000001+00:00' WHERE id=?",(second,))
        outside = self.append(endpoint='meta',elapsed=99)
        self.c.execute("UPDATE api_reads SET created_at='2026-09-30T15:59:59.999999+00:00' WHERE id=?",(outside,))
        result = self.get(month='2026-10')[1]
        self.assertEqual(result['summary'],dict(total=2,success=1,failed=1,success_rate=50,average_ms=20,max_ms=30))
        self.assertEqual(result['daily'],[dict(date='2026-10-01',total=2,success=1,failed=1)])
        event = result['events'][-1]
        self.assertEqual((event['task_count'],event['course_count']),(2,1))
        self.assertEqual(set(event),set(api_reads.COLUMNS))
        self.assertNotIn('SECRET',json.dumps(result))
        self.assertIsNone(result['events'][0]['viewer_id'])
        self.assertEqual(self.get(actor=dict(id=3,admin=0))[0],403)
        self.assertEqual(self.get(unlocked=False)[0],403)
        self.assertEqual(self.get(actor=dict(id=2,admin=1))[0],403)
        self.assertEqual(self.get(month='2026-10',viewer_id=2)[1]['summary']['total'],1)
        self.assertEqual(self.get(month='2026-10',endpoint='meta')[1]['summary']['total'],0)
        self.c.rollback()
        self.assertEqual(self.c.execute('SELECT count(*) FROM api_reads').fetchone()[0],0)

    def test_fixed_snapshot_complete_export_and_cursor(self):
        for status in (200,400,405,500): self.append(status=status)
        first = self.get(limit=1)[1]
        self.append(endpoint='meta')
        second = self.get(limit=1,cursor=first['next_cursor'])[1]
        self.assertEqual(second['snapshot_id'],first['snapshot_id'])
        self.assertEqual(second['summary']['total'],4)
        self.assertLess(second['events'][0]['id'],first['events'][0]['id'])
        exported = self.get(export=True,format='json',snapshot_id=first['snapshot_id'])[1]
        self.assertEqual(len(exported['events']),4)
        self.assertEqual(exported['summary']['failed'],3)
        content = self.get(export=True,format='csv',snapshot_id=first['snapshot_id'])[1]
        self.assertTrue(content.startswith(b'\xef\xbb\xbf'))
        rows = list(csv.DictReader(io.StringIO(content.decode('utf-8-sig'))))
        self.assertEqual(len(rows),4); self.assertEqual(rows[0]['viewer_name'],"'=SUM(1,1)")
        self.assertEqual(self.get(cursor='W10')[0],400)
        self.assertEqual(self.get(cursor=first['next_cursor'],endpoint='meta')[0],400)
        self.assertEqual(self.get(month='2026-13')[0],400)


if __name__=='__main__': unittest.main()
