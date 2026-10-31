"""Guarded, one-time ownership handover. Run app.init and take a backup first.

prepare preserves all business content and requires every existing user to complete
credential setup. cleanup stays pending until the new owner has completed setup
and entered management, and refuses to delete any nonempty personal content.
"""
import argparse
import datetime as dt
import hashlib
import json
import re
import sqlite3
from pathlib import Path

KEY = 'auth-ownership-v1'
META = 'auth_ownership_migrations'
PERSONAL = ('settings','categories','tasks','journal','user_timetable',
            'user_course_exceptions','personal_course_plans','course_annotations',
            'course_makeups','course_occurrence_archive')
GLOBAL = ('course_templates','timetable_template','holidays')
EMPTY_ROWS = ('tasks','journal','course_annotations','course_makeups','course_occurrence_archive')
PLAN_KEYS = {'courses','periods','holidays','calendars','sources','course_aliases','archived_courses'}
DEFAULT_CATEGORIES = {'课程':'#7185bd','科研':'#408f80','考试':'#b88355','个人':'#9775ae'}


def _json(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'))


def _quote(name):
    return '"'+name.replace('"','""')+'"'


def _rows(c, sql, params=()):
    cursor = c.execute(sql,params); names = [item[0] for item in cursor.description]
    return [dict(zip(names,row)) for row in cursor]


def _tables(c):
    return {row[0] for row in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def _columns(c, table):
    return {row[1] for row in c.execute('PRAGMA table_info('+_quote(table)+')')}


def _digest(rows):
    text = '\n'.join(sorted(_json(row) for row in rows))
    return dict(count=len(rows),sha256=hashlib.sha256(text.encode()).hexdigest())


def snapshot(c):
    """Safe row counts and fingerprints only; excludes all credentials/role flags."""
    tables = _tables(c); users = {}
    for account in _rows(c,'SELECT id,name,remark FROM users ORDER BY id'):
        uid = account['id']; personal = {}
        for table in PERSONAL:
            if table in tables:
                personal[table] = _digest(_rows(c,'SELECT * FROM '+table+' WHERE user_id=?',(uid,)))
        if 'viewers' in tables:
            personal['viewers'] = _digest(_rows(c,'SELECT * FROM viewers WHERE user_id=? OR owner_id=?',(uid,uid)))
        users[str(uid)] = dict(identity=_digest([account]),tables=personal)
    return dict(users=users,global_tables={table:_digest(_rows(c,'SELECT * FROM '+table)) for table in GLOBAL if table in tables})


def _schema(c):
    required = set(PERSONAL+GLOBAL+('users','user_auth','sessions','trusted_devices','viewers','audit_events'))
    missing = required-_tables(c)
    if missing: raise ValueError('Run app.init first; missing tables: '+','.join(sorted(missing)))
    for table,fields in {'users':{'root_admin','admin','remark'},'user_auth':{'setup_version','pin_hash'},
                         'sessions':{'admin_started','auth_method','strong_password','created','expires'}}.items():
        if fields-_columns(c,table): raise ValueError('Run the new app.init first: '+table)


def _state(c):
    if META not in _tables(c): return None
    row = c.execute('SELECT data FROM '+META+' WHERE name=?',(KEY,)).fetchone()
    return json.loads(row[0]) if row else None


def _save(c, state):
    c.execute('CREATE TABLE IF NOT EXISTS '+META+'(name TEXT PRIMARY KEY,data TEXT NOT NULL)')
    c.execute('INSERT OR REPLACE INTO '+META+' VALUES(?,?)',(KEY,_json(state)))


def _identity(c, owner_id, old_admin_id, state=None):
    if owner_id==old_admin_id: raise ValueError('Owner and old administrator must be different accounts')
    if state and (state['owner_id']!=owner_id or state['old_admin_id']!=old_admin_id):
        raise ValueError('Migration was already prepared for different account IDs')
    owner = _rows(c,'SELECT id,name,admin,root_admin FROM users WHERE id=?',(owner_id,))
    old = _rows(c,'SELECT id,name,admin,root_admin FROM users WHERE id=?',(old_admin_id,))
    if len(owner)!=1 or owner[0]['name']!='griffxen': raise ValueError('Owner must be the confirmed griffxen account')
    if old and old[0]['name']!='admin': raise ValueError('Old account must be the confirmed admin account')
    if old and state and state.get('cleaned_at'): raise ValueError('Deleted account ID unexpectedly reappeared')
    if not old and not (state and state.get('cleaned_at')): raise ValueError('Old administrator is missing unexpectedly')
    if c.execute('SELECT 1 FROM viewers WHERE user_id IN (?,?)',(owner_id,old_admin_id)).fetchone():
        raise ValueError('Ownership migration cannot target a viewer account')
    if c.execute('SELECT 1 FROM users WHERE root_admin=1 AND id<>?',(owner_id,)).fetchone():
        raise ValueError('A different root owner already exists')
    return owner[0],old[0] if old else None


def _audit(c, actor, target_id, action, label, changes=None):
    owner = c.execute('SELECT name FROM users WHERE id=?',(target_id,)).fetchone()
    value = dict(created_at=dt.datetime.now(dt.timezone.utc).isoformat(timespec='microseconds'),
                 actor_id=actor['id'],actor_name=actor['name'],owner_id=target_id,
                 owner_name=owner[0] if owner else 'admin',action=action,type='security',
                 object_id=str(target_id),label=label,summary=label,outcome='success',request_id=KEY,
                 changes=changes or [],management_only=1)
    value['payload_bytes'] = len(_json(value).encode()); value['changes'] = _json(value['changes'])
    allowed = _columns(c,'audit_events'); value = {key:item for key,item in value.items() if key in allowed}
    columns = tuple(value)
    return c.execute('INSERT INTO audit_events('+','.join(columns)+') VALUES('+','.join('?' for _ in columns)+')',tuple(value.values())).lastrowid


def _begin(c, dry_run):
    if c.in_transaction: raise ValueError('Use a fresh connection without a transaction')
    c.execute('BEGIN' if dry_run else 'BEGIN IMMEDIATE')


def prepare(c, owner_id=2, old_admin_id=1, dry_run=False):
    _begin(c,dry_run)
    try:
        _schema(c); before = snapshot(c); state = _state(c)
        owner,old = _identity(c,owner_id,old_admin_id,state)
        if state:
            if not (owner['admin'] and owner['root_admin']): raise ValueError('Prepared owner lost required roles')
            if old and old['admin']: raise ValueError('Old account unexpectedly regained management permission')
            result = dict(status='already_cleaned' if state.get('cleaned_at') else 'already_prepared',dry_run=dry_run,before=before,after=before,unchanged=True)
            c.rollback(); return result
        result = dict(status='would_prepare' if dry_run else 'prepared',dry_run=dry_run,
                      owner_id=owner_id,old_admin_id=old_admin_id,before=before)
        if dry_run:
            result.update(after=before,unchanged=True); c.rollback(); return result
        prepared_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec='microseconds')
        c.execute('UPDATE users SET admin=1,root_admin=1 WHERE id=?',(owner_id,))
        c.execute('UPDATE users SET admin=0 WHERE id=?',(old_admin_id,))
        for (uid,) in c.execute('SELECT id FROM users').fetchall():
            c.execute('INSERT OR IGNORE INTO user_auth(user_id,setup_version) VALUES(?,0)',(uid,))
        c.execute('UPDATE user_auth SET setup_version=0 WHERE user_id IN (SELECT id FROM users)')
        c.execute('DELETE FROM sessions'); c.execute('UPDATE trusted_devices SET revoked=1')
        _audit(c,owner,owner_id,'management_permission_changed','迁移站点所有者',[
            dict(field='admin',before=bool(owner['admin']),after=True),dict(field='root_admin',before=bool(owner['root_admin']),after=True)])
        _audit(c,owner,old_admin_id,'management_permission_changed','撤销原管理员管理权限',[
            dict(field='admin',before=bool(old['admin']),after=False)])
        audit_id = _audit(c,owner,owner_id,'credentials_setup_required','要求现有账户完成首次凭据设置')
        state = dict(owner_id=owner_id,old_admin_id=old_admin_id,prepared_at=prepared_at,prepared_audit_id=audit_id)
        _save(c,state); after = snapshot(c)
        if after!=before: raise ValueError('Business fingerprints changed during ownership prepare')
        c.commit(); result.update(after=after,unchanged=True); return result
    except BaseException:
        c.rollback(); raise


def _default_report(c, uid):
    settings = [{key:value for key,value in row.items() if key!='user_id'} for row in _rows(c,'SELECT * FROM settings WHERE user_id=?',(uid,))]
    categories = [{key:value for key,value in row.items() if key!='user_id'} for row in _rows(c,'SELECT * FROM categories WHERE user_id=? ORDER BY name',(uid,))]
    digest = hashlib.sha256(_json(dict(settings=settings,categories=categories)).encode()).hexdigest()
    settings_ok = not settings or settings==[dict(name='2026 秋季学期',start='2026-09-07')]
    categories_ok = not categories or (len(categories)==4 and all(
        set(item)=={'name','color','warn_days','urgent_days'}
        and item['name'] in DEFAULT_CATEGORIES and item['color']==DEFAULT_CATEGORIES[item['name']]
        and item['warn_days']==7 and item['urgent_days']==2 for item in categories)
        and len({item['name'] for item in categories})==4)
    return dict(sha256=digest,settings_count=len(settings),categories_count=len(categories),known_defaults=settings_ok and categories_ok)


def _ready(c, owner, state):
    auth = c.execute('SELECT setup_version,pin_hash FROM user_auth WHERE user_id=?',(owner['id'],)).fetchone()
    if not (owner['admin'] and owner['root_admin'] and auth and auth[0]>=1 and auth[1]):
        return False,'站点所有者尚未完成密码及 PIN 设置'
    setup = c.execute("SELECT id,created_at FROM audit_events WHERE actor_id=? AND owner_id=? AND action='credentials_setup_completed' AND outcome='success' AND id>? ORDER BY id DESC LIMIT 1",
                      (owner['id'],owner['id'],state['prepared_audit_id'])).fetchone()
    if setup is None: return False,'缺少迁移后本人完成凭据设置的记录'
    proof = c.execute("SELECT 1 FROM audit_events WHERE actor_id=? AND outcome='success' AND action='management_verified' AND id>? AND created_at>=? LIMIT 1",
                      (owner['id'],setup[0],setup[1])).fetchone()
    if not proof: return False,'所有者尚未实际进入管理区完成验证'
    return True,'已完成凭据设置并验证管理访问'


def _empty_check(c, uid, approved_defaults_sha256=None):
    blockers = []; counts = {}
    if uid>=c.execute('SELECT max(id) FROM users').fetchone()[0]:
        blockers.append('Deleting the highest user ID could allow historical identity reuse')
    for table in EMPTY_ROWS:
        counts[table] = c.execute('SELECT count(*) FROM '+table+' WHERE user_id=?',(uid,)).fetchone()[0]
        if counts[table]: blockers.append(table+' contains personal records')
    for table in ('user_timetable','user_course_exceptions','personal_course_plans'):
        expected_columns = {'user_id','data','version'} if table=='personal_course_plans' else {'user_id','data'}
        if _columns(c,table)-expected_columns: blockers.append(table+' contains unreviewed columns')
        rows = c.execute('SELECT data FROM '+table+' WHERE user_id=?',(uid,)).fetchall(); counts[table] = len(rows)
        for row in rows:
            try: data = json.loads(row[0])
            except (ValueError,TypeError): blockers.append(table+' contains invalid JSON'); continue
            if table!='personal_course_plans': empty = data==[]
            else:
                empty = isinstance(data,dict) and not (set(data)-PLAN_KEYS) and all(
                    isinstance(value,dict if key=='course_aliases' else list) and not value for key,value in data.items())
            if not empty: blockers.append(table+' contains personal content')
    counts['viewer_bindings'] = c.execute('SELECT count(*) FROM viewers WHERE user_id=? OR owner_id=?',(uid,uid)).fetchone()[0]
    if counts['viewer_bindings']: blockers.append('Viewer ownership or bindings still reference the old account')
    permissions = 0
    for row in c.execute('SELECT permissions FROM course_templates'):
        try:
            policy = json.loads(row[0]); entries = policy['users']
            if not isinstance(entries,list) or any(not isinstance(item,dict) or type(item.get('user_id')) is not int for item in entries): raise ValueError()
            permissions += sum(item.get('user_id')==uid for item in entries)
        except (ValueError,TypeError,KeyError): blockers.append('Invalid template permission JSON')
    counts['template_permissions'] = permissions
    if permissions: blockers.append('Template permissions still reference the old account')
    defaults = _default_report(c,uid)
    if approved_defaults_sha256 and not re.fullmatch(r'[0-9a-f]{64}',approved_defaults_sha256): raise ValueError('Invalid approved defaults fingerprint')
    if approved_defaults_sha256 and approved_defaults_sha256!=defaults['sha256']:
        blockers.append('Reviewed settings/category fingerprint no longer matches')
    if not defaults['known_defaults'] and approved_defaults_sha256!=defaults['sha256']:
        blockers.append('Settings/categories require exact reviewed fingerprint approval')
    known = set(PERSONAL+GLOBAL+('users','sessions','user_auth','trusted_devices','viewers','audit_events','api_reads','auth_attempts','attempts',META))
    for table in _tables(c)-known:
        columns = _columns(c,table)&{'user_id','owner_id','actor_id','viewer_id'}
        if columns:
            sql = 'SELECT count(*) FROM '+_quote(table)+' WHERE '+' OR '.join(_quote(field)+'=?' for field in sorted(columns))
            if c.execute(sql,(uid,)*len(columns)).fetchone()[0]: blockers.append('Unknown account dependency: '+table)
    return dict(counts=counts,defaults=defaults,blockers=list(dict.fromkeys(blockers)))


def cleanup(c, owner_id=2, old_admin_id=1, dry_run=False, approved_defaults_sha256=None):
    _begin(c,dry_run)
    try:
        _schema(c); before = snapshot(c); state = _state(c)
        if not state:
            c.rollback(); return dict(status='pending',reason='请先执行 prepare',before=before,after=before,unchanged=True,dry_run=dry_run)
        owner,old = _identity(c,owner_id,old_admin_id,state)
        if state.get('cleaned_at'):
            c.rollback(); return dict(status='already_cleaned',before=before,after=before,unchanged=True,dry_run=dry_run)
        ready,reason = _ready(c,owner,state); checks = _empty_check(c,old_admin_id,approved_defaults_sha256)
        result = dict(status='pending' if not ready else 'blocked' if checks['blockers'] else 'ready' if dry_run else 'cleaned',
                      ready=ready,reason=reason,checks=checks,dry_run=dry_run,before=before)
        if not ready or checks['blockers'] or dry_run:
            result.update(after=before,unchanged=True); c.rollback(); return result
        if old['admin'] or old['root_admin']: raise ValueError('Old administrator unexpectedly has management permission')
        _audit(c,owner,old_admin_id,'account_deleted','核查空数据后删除原管理员账户',[
            dict(field='name',before=old['name'],after=None)])
        devices = [row[0] for row in c.execute('SELECT id FROM trusted_devices WHERE user_id=?',(old_admin_id,))]
        c.execute('DELETE FROM sessions WHERE user_id=?',(old_admin_id,))
        c.execute('DELETE FROM user_auth WHERE user_id=?',(old_admin_id,))
        c.execute('DELETE FROM trusted_devices WHERE user_id=?',(old_admin_id,))
        for table in PERSONAL: c.execute('DELETE FROM '+table+' WHERE user_id=?',(old_admin_id,))
        c.execute('DELETE FROM users WHERE id=?',(old_admin_id,))
        if 'attempts' in _tables(c): c.execute('DELETE FROM attempts WHERE ip=?',('account:'+str(old_admin_id),))
        if 'auth_attempts' in _tables(c):
            buckets = ['pin:user:'+str(old_admin_id),'verify:user:'+str(old_admin_id)]+['pin:device:'+device for device in devices]
            c.executemany('DELETE FROM auth_attempts WHERE bucket=?',[(bucket,) for bucket in buckets])
        expected = dict(before,users={uid:data for uid,data in before['users'].items() if uid!=str(old_admin_id)})
        after = snapshot(c)
        if after!=expected: raise ValueError('Other accounts or global content changed during cleanup')
        state['cleaned_at'] = dt.datetime.now(dt.timezone.utc).isoformat(); _save(c,state)
        c.commit(); result.update(after=after,unchanged_other_users=True); return result
    except BaseException:
        c.rollback(); raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db',type=Path,required=True)
    parser.add_argument('--owner-id',type=int,default=2)
    parser.add_argument('--old-admin-id',type=int,default=1)
    parser.add_argument('--phase',choices=('prepare','cleanup'),required=True)
    parser.add_argument('--dry-run',action='store_true')
    parser.add_argument('--approved-defaults-sha256')
    args = parser.parse_args()
    mode = 'ro' if args.dry_run else 'rw'
    c = sqlite3.connect(args.db.resolve().as_uri()+'?mode='+mode,uri=True)
    try:
        if args.dry_run: c.execute('PRAGMA query_only=ON')
        if args.phase=='prepare': result = prepare(c,args.owner_id,args.old_admin_id,args.dry_run)
        else: result = cleanup(c,args.owner_id,args.old_admin_id,args.dry_run,args.approved_defaults_sha256)
        print(json.dumps(result,ensure_ascii=False,indent=2))
    except (ValueError,sqlite3.Error) as error:
        parser.exit(2,str(error)+'\n')
    finally: c.close()


if __name__=='__main__': main()
