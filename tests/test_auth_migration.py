"""Two grouped checks for handover idempotency and guarded empty-account cleanup."""
import importlib.util
import json
import sqlite3
import time
import unittest
from pathlib import Path

import audit_log

spec = importlib.util.spec_from_file_location('auth_ownership_migration',Path(__file__).resolve().parents[1]/'deploy/migrate-auth-ownership.py')
migration = importlib.util.module_from_spec(spec); spec.loader.exec_module(migration)


class AuthMigration(unittest.TestCase):
    def setUp(self):
        self.c = sqlite3.connect(':memory:')
        self.c.executescript('''
            CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,remark TEXT,admin INTEGER,root_admin INTEGER,salt TEXT,password TEXT);
            INSERT INTO users VALUES(1,'admin','',1,0,'SECRET_SALT','SECRET_PASSWORD'),(2,'griffxen','个人账户',0,0,'KEEP_SALT','KEEP_PASSWORD');
            CREATE TABLE user_auth(user_id INTEGER PRIMARY KEY,pin_salt TEXT DEFAULT '',pin_hash TEXT DEFAULT '',setup_version INTEGER DEFAULT 0);
            INSERT INTO user_auth VALUES(2,'KEEP_PIN_SALT','KEEP_PIN_HASH',1);
            CREATE TABLE sessions(token TEXT,user_id INTEGER,auth_method TEXT,strong_password INTEGER,admin_started REAL,created REAL,expires REAL);
            INSERT INTO sessions VALUES('SECRET_SESSION',1,'password',1,1,1,9999999999);
            CREATE TABLE trusted_devices(id TEXT,user_id INTEGER,revoked INTEGER,token_hash TEXT);
            INSERT INTO trusted_devices VALUES('one',2,0,'KEEP_DEVICE_HASH');
            CREATE TABLE viewers(user_id INTEGER,owner_id INTEGER,policy TEXT,dashboard_token_hash TEXT);
            CREATE TABLE settings(user_id INTEGER,name TEXT,start TEXT);
            INSERT INTO settings VALUES(1,'2026 秋季学期','2026-09-07'),(2,'个人学期','2026-09-07');
            CREATE TABLE categories(user_id INTEGER,name TEXT,color TEXT,warn_days INTEGER,urgent_days INTEGER);
            CREATE TABLE tasks(id TEXT,user_id INTEGER,title TEXT);
            INSERT INTO tasks VALUES('keep',2,'用户数据不变');
            CREATE TABLE journal(user_id INTEGER,date TEXT,body TEXT);
            CREATE TABLE user_timetable(user_id INTEGER,data TEXT);
            INSERT INTO user_timetable VALUES(1,'[]');
            CREATE TABLE user_course_exceptions(user_id INTEGER,data TEXT);
            INSERT INTO user_course_exceptions VALUES(1,'[]');
            CREATE TABLE personal_course_plans(user_id INTEGER,version INTEGER,data TEXT);
            INSERT INTO personal_course_plans VALUES(1,1,'{"courses":[],"sources":[],"holidays":[],"course_aliases":{}}');
            CREATE TABLE course_annotations(user_id INTEGER,course_key TEXT,notes TEXT);
            CREATE TABLE course_makeups(user_id INTEGER,occurrence_id TEXT,data TEXT);
            CREATE TABLE course_occurrence_archive(user_id INTEGER,occurrence_id TEXT,data TEXT);
            CREATE TABLE course_templates(template_id TEXT,data TEXT,permissions TEXT);
            INSERT INTO course_templates VALUES('global','{"courses":["全局课程保留"]}','{"public":true,"users":[{"user_id":2,"use":true}]}');
            CREATE TABLE timetable_template(id INTEGER,data TEXT);
            INSERT INTO timetable_template VALUES(1,'[]');
            CREATE TABLE holidays(id INTEGER,data TEXT);
            INSERT INTO holidays VALUES(1,'[]');
        ''')
        self.c.executemany('INSERT INTO categories VALUES(1,?,?,7,2)',migration.DEFAULT_CATEGORIES.items())
        audit_log.init(self.c); self.c.commit()

    def tearDown(self): self.c.close()

    def test_prepare_is_dry_run_safe_idempotent_and_preserves_content(self):
        before = migration.snapshot(self.c)
        report = migration.prepare(self.c,dry_run=True)
        self.assertEqual(report['status'],'would_prepare'); self.assertNotIn(migration.META,migration._tables(self.c))
        self.assertEqual(migration.snapshot(self.c),before)
        report = migration.prepare(self.c)
        self.assertEqual(report['before'],report['after']); self.assertEqual(report['status'],'prepared')
        self.assertEqual(self.c.execute('SELECT admin,root_admin FROM users WHERE id=2').fetchone(),(1,1))
        self.assertEqual(self.c.execute('SELECT admin FROM users WHERE id=1').fetchone()[0],0)
        self.assertEqual(self.c.execute('SELECT count(*) FROM sessions').fetchone()[0],0)
        self.assertEqual(self.c.execute('SELECT revoked FROM trusted_devices').fetchone()[0],1)
        self.assertEqual(self.c.execute('SELECT setup_version,pin_hash FROM user_auth WHERE user_id=2').fetchone(),(0,'KEEP_PIN_HASH'))
        self.c.execute('UPDATE user_auth SET setup_version=1 WHERE user_id=2'); self.c.commit()
        self.assertEqual(migration.prepare(self.c)['status'],'already_prepared')
        self.assertEqual(self.c.execute('SELECT setup_version FROM user_auth WHERE user_id=2').fetchone()[0],1)
        self.assertNotIn('SECRET',json.dumps(report))
        self.c.execute('UPDATE users SET root_admin=1 WHERE id=1'); self.c.commit()
        with self.assertRaisesRegex(ValueError,'different root'): migration.prepare(self.c)
        self.assertEqual(migration.snapshot(self.c),before)

    def test_cleanup_waits_for_setup_and_blocks_content_or_unreviewed_defaults(self):
        migration.prepare(self.c)
        self.assertEqual(migration.cleanup(self.c)['status'],'pending')
        self.c.execute('UPDATE user_auth SET setup_version=1 WHERE user_id=2')
        migration._audit(self.c,dict(id=2,name='griffxen'),2,'credentials_setup_completed','完成凭据设置')
        started = time.time()
        self.c.execute('INSERT INTO sessions VALUES(?,?,?,?,?,?,?)',('new-session',2,'password',1,started,started,started+3600))
        migration._audit(self.c,dict(id=2,name='griffxen'),2,'password_verified','密码验证')
        self.c.commit()
        self.assertEqual(migration.cleanup(self.c)['status'],'pending')
        migration._audit(self.c,dict(id=2,name='griffxen'),2,'management_verified','已实际进入管理区')
        self.c.execute('UPDATE personal_course_plans SET data=? WHERE user_id=1',
                       (json.dumps(dict(courses=[],holidays=['私人停课记录']),ensure_ascii=False),))
        self.c.commit()
        self.assertEqual(migration.cleanup(self.c)['status'],'blocked')
        self.c.execute("UPDATE personal_course_plans SET data='{}' WHERE user_id=1")
        self.c.execute("UPDATE settings SET name='已核对的旧默认名称' WHERE user_id=1"); self.c.commit()
        blocked = migration.cleanup(self.c,dry_run=True)
        self.assertEqual(blocked['status'],'blocked')
        approved = blocked['checks']['defaults']['sha256']
        self.assertEqual(migration.cleanup(self.c,dry_run=True,approved_defaults_sha256=approved)['status'],'ready')
        self.c.execute("INSERT INTO viewers VALUES(9,1,'{}','SECRET_TOKEN_HASH')"); self.c.commit()
        self.assertEqual(migration.cleanup(self.c,approved_defaults_sha256=approved)['status'],'blocked')
        self.c.execute('DELETE FROM viewers'); self.c.commit()
        before = migration.snapshot(self.c); events_before = self.c.execute('SELECT count(*) FROM audit_events').fetchone()[0]
        report = migration.cleanup(self.c,approved_defaults_sha256=approved)
        self.assertEqual(report['status'],'cleaned')
        self.assertIsNone(self.c.execute('SELECT 1 FROM users WHERE id=1').fetchone())
        self.assertEqual(report['after']['users']['2'],before['users']['2'])
        self.assertEqual(report['after']['global_tables'],before['global_tables'])
        self.assertGreater(self.c.execute('SELECT count(*) FROM audit_events').fetchone()[0],events_before)
        self.assertEqual(migration.cleanup(self.c)['status'],'already_cleaned')


if __name__=='__main__': unittest.main()
