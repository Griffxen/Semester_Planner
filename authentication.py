"""Password/PIN authentication, trusted devices and short management grants.

Callers own the SQLite transaction and must commit before sending the response.
Public responses and audit events deliberately contain no credential material.
"""
import hashlib
import hmac
import http.cookies
import os
import re
import secrets
import time

SESSION_SECONDS = 7 * 86400
SETUP_SECONDS = 10 * 60
SETUP_VERSION = 1
DEVICE_SECONDS = 30 * 86400
ADMIN_IDLE_SECONDS = 30 * 60
ADMIN_ABSOLUTE_SECONDS = 2 * 3600
FRESH_SECONDS = 5 * 60
ATTEMPT_SECONDS = 15 * 60
DEVICE_COOKIE = 'planner_device'


def password_hash(password, salt):
    return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()


def init(c):
    if 'root_admin' not in {r['name'] for r in c.execute('PRAGMA table_info(users)')}:
        c.execute('ALTER TABLE users ADD COLUMN root_admin INTEGER NOT NULL DEFAULT 0')
    columns = {r['name'] for r in c.execute('PRAGMA table_info(sessions)')}
    for name, definition in (
        ('auth_method', "TEXT NOT NULL DEFAULT 'legacy'"),
        ('strong_password', 'INTEGER NOT NULL DEFAULT 0'),
        ('password_verified', 'REAL NOT NULL DEFAULT 0'),
        ('admin_started', 'REAL NOT NULL DEFAULT 0'),
        ('admin_touched', 'REAL NOT NULL DEFAULT 0'),
        ('device_id', "TEXT NOT NULL DEFAULT ''"),
        ('created', 'REAL NOT NULL DEFAULT 0'),
    ):
        if name not in columns:
            c.execute('ALTER TABLE sessions ADD COLUMN ' + name + ' ' + definition)
    c.execute('''CREATE TABLE IF NOT EXISTS user_auth(
        user_id INTEGER PRIMARY KEY, pin_salt TEXT NOT NULL DEFAULT '',
        pin_hash TEXT NOT NULL DEFAULT '', setup_version INTEGER NOT NULL DEFAULT 0)''')
    if 'setup_version' not in {r['name'] for r in c.execute('PRAGMA table_info(user_auth)')}:
        c.execute('ALTER TABLE user_auth ADD COLUMN setup_version INTEGER NOT NULL DEFAULT 0')
    c.execute('''CREATE TABLE IF NOT EXISTS trusted_devices(
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, token_hash TEXT UNIQUE NOT NULL,
        label TEXT NOT NULL, created REAL NOT NULL, expires REAL NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0)''')
    c.execute('CREATE INDEX IF NOT EXISTS trusted_devices_user ON trusted_devices(user_id)')
    c.execute('CREATE TABLE IF NOT EXISTS auth_attempts(bucket TEXT NOT NULL,time REAL NOT NULL)')
    c.execute('CREATE INDEX IF NOT EXISTS auth_attempts_bucket ON auth_attempts(bucket,time)')


def _value(row, key, default=None):
    return row[key] if row is not None and key in row.keys() else default


def is_root(row):
    return bool(_value(row, 'root_admin', 0))


def setup_required(c, actor):
    if actor is None:
        return True
    row = c.execute('SELECT setup_version FROM user_auth WHERE user_id=?', (actor['id'],)).fetchone()
    return row is None or row['setup_version'] < SETUP_VERSION


def _public_user(c, actor):
    viewer = c.execute('SELECT 1 FROM viewers WHERE user_id=?', (actor['id'],)).fetchone()
    return dict(id=actor['id'], name=actor['name'], admin=bool(actor['admin'] or is_root(actor)),
                root_admin=is_root(actor), viewer=bool(viewer))


def _cookie_token(header, name):
    try:
        cookie = http.cookies.SimpleCookie(header or '')
        value = cookie[name].value
        return value if re.fullmatch(r'[A-Za-z0-9_-]{40,128}', value) else ''
    except (KeyError, http.cookies.CookieError, TypeError):
        return ''


def _digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def _cookie(name, token='', age=0):
    return (name + '=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + str(int(age))
            + ('; Secure' if os.environ.get('PLANNER_SECURE') == '1' else ''))


def _device(c, header, uid=None, now=None):
    token = _cookie_token(header, DEVICE_COOKIE)
    if not token:
        return None
    row = c.execute('SELECT * FROM trusted_devices WHERE token_hash=? AND revoked=0 AND expires>?',
                    (_digest(token), time.time() if now is None else now)).fetchone()
    return row if row is not None and (uid is None or row['user_id'] == uid) else None


def session(c, cookie_header):
    token = _cookie_token(cookie_header, 'session')
    if not token:
        return None
    now = time.time()
    row = c.execute('SELECT * FROM sessions WHERE token=? AND expires>?', (_digest(token), now)).fetchone()
    if row is None:
        return None
    if row['device_id']:
        device = _device(c, cookie_header, row['user_id'], now)
        if device is None or device['id'] != row['device_id']:
            return None
    if row['auth_method'] == 'pin' and not row['device_id']:
        return None
    return row


def fresh(s, now=None):
    now = time.time() if now is None else now
    verified = _value(s, 'password_verified', 0)
    return bool(_value(s, 'auth_method') == 'password' and _value(s, 'strong_password', 0)
                and verified > 0 and 0 <= now - verified < FRESH_SECONDS
                and _value(s, 'expires', 0) > now)


def admin_active(actor, s, now=None):
    now = time.time() if now is None else now
    started = _value(s, 'admin_started', 0)
    touched = _value(s, 'admin_touched', 0)
    return bool((_value(actor, 'admin', 0) or is_root(actor)) and _value(s, 'auth_method') == 'password'
                and _value(s, 'strong_password', 0) and started > 0 and touched > 0
                and 0 <= now - started < ADMIN_ABSOLUTE_SECONDS
                and 0 <= now - touched < ADMIN_IDLE_SECONDS and _value(s, 'expires', 0) > now)


def touch_admin(c, actor, s):
    """Call for an explicit management action, never for background polling."""
    if admin_active(actor, s):
        c.execute('UPDATE sessions SET admin_touched=? WHERE token=?', (time.time(), s['token']))


def context(c, actor, s):
    now = time.time()
    pin = c.execute('SELECT pin_hash FROM user_auth WHERE user_id=?', (actor['id'],)).fetchone()
    device = c.execute('SELECT id FROM trusted_devices WHERE id=? AND user_id=? AND revoked=0 AND expires>?',
                       (s['device_id'], actor['id'], now)).fetchone() if s['device_id'] else None
    pending = setup_required(c, actor)
    active = not pending and admin_active(actor, s, now)
    return dict(method=s['auth_method'], strong_password=bool(s['strong_password']),
                password_fresh=not pending and fresh(s, now), admin_unlocked=active,
                admin_expires=min(s['admin_started'] + ADMIN_ABSOLUTE_SECONDS,
                                  s['admin_touched'] + ADMIN_IDLE_SECONDS) if active else None,
                pin_enabled=bool(pin and pin['pin_hash']), trusted_device=bool(device),
                session_expires=s['expires'], setup_required=pending)


def _audit(c, actor, action, label, request_id='', owner_id=None, changes=None, outcome='success', object_id=None):
    from audit_log import record
    record(c, actor, action, 'auth', str(object_id if object_id is not None else actor['id'] if actor else ''),
           label, owner_id=owner_id if owner_id is not None else actor['id'] if actor else None,
           changes=changes, request_id=request_id, outcome=outcome)


def _error(status, message, code=None):
    body = dict(error=message)
    if code:
        body['code'] = code
    return status, body, []


def _limited(c, buckets, limit, now):
    return any(c.execute('SELECT count(*) FROM auth_attempts WHERE bucket=? AND time>?',
                         (bucket, now - ATTEMPT_SECONDS)).fetchone()[0] >= limit for bucket in buckets)


def _failed(c, buckets, now):
    c.executemany('INSERT INTO auth_attempts(bucket,time) VALUES(?,?)', [(bucket, now) for bucket in buckets])


def _clear_attempts(c, buckets):
    c.executemany('DELETE FROM auth_attempts WHERE bucket=?', [(bucket,) for bucket in buckets])


def _matches(password, actor):
    # Unknown accounts still perform the same expensive hash operation.
    salt = actor['salt'] if actor is not None else '00' * 16
    expected = actor['password'] if actor is not None else '0' * 128
    return hmac.compare_digest(password_hash(password, salt), expected) and actor is not None


def _issue(c, actor, method, device=None, strong=False, unlock=False, previous=None):
    now = time.time()
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(24)
    lifetime = SETUP_SECONDS if method == 'setup' else SESSION_SECONDS
    expires = min(now + lifetime, device['expires']) if device is not None else now + lifetime
    if previous is not None:
        c.execute('DELETE FROM sessions WHERE token=?', (previous['token'],))
    c.execute('DELETE FROM sessions WHERE expires<=?', (now,))
    c.execute('''INSERT INTO sessions(token,user_id,csrf,expires,auth_method,strong_password,
        password_verified,admin_started,admin_touched,device_id,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)''',
              (_digest(token), actor['id'], csrf, expires, method, int(strong),
               now if method == 'password' and strong else 0, now if unlock else 0,
               now if unlock else 0, device['id'] if device is not None else '', now))
    s = c.execute('SELECT * FROM sessions WHERE token=?', (_digest(token),)).fetchone()
    pending = setup_required(c, actor)
    body = dict(ok=True, csrf=csrf, auth=context(c, actor, s), user=_public_user(c, actor),
                setup_required=pending, setup_url='/setup/' if pending else None)
    return s, body, [_cookie('session', token, max(0, expires - now))]


def login(c, data, cookie_header, ip, request_id):
    if not isinstance(data, dict):
        return _error(400, '请填写账户和登录凭据')
    name = data.get('name', '')
    credential = data.get('credential', data.get('password', ''))
    if not isinstance(name, str) or not 1 <= len(name) <= 64 or not isinstance(credential, str) or not 1 <= len(credential) <= 256:
        return _error(400, '请填写账户和登录凭据')
    now = time.time()
    c.execute('DELETE FROM auth_attempts WHERE time<=?', (now - ATTEMPT_SECONDS,))
    ip_bucket = 'login:ip:' + str(ip)
    if _limited(c, [ip_bucket], 8, now):
        return _error(429, '尝试过多，请 15 分钟后重试', 'authentication_limited')
    actor = c.execute('SELECT * FROM users WHERE name=?', (name,)).fetchone()
    pending = actor is not None and setup_required(c, actor)
    password_valid = _matches(credential, actor)
    device = _device(c, cookie_header, actor['id'], now) if actor is not None else None
    method = 'password'
    if not password_valid:
        pin = c.execute('SELECT * FROM user_auth WHERE user_id=?', (actor['id'],)).fetchone() if actor else None
        buckets = ['pin:user:' + str(actor['id']), 'pin:device:' + device['id']] if actor is not None and device is not None else []
        if buckets and _limited(c, buckets, 5, now):
            return _error(429, 'PIN 尝试过多，请 15 分钟后重试，或使用密码', 'pin_limited')
        valid_pin = bool(not pending and pin and pin['pin_hash'] and device is not None and re.fullmatch(r'[0-9]{4,6}', credential)
                         and hmac.compare_digest(password_hash(credential, pin['pin_salt']), pin['pin_hash']))
        if not valid_pin:
            _failed(c, [ip_bucket] + buckets, now)
            _audit(c, actor, 'login_failed', '登录失败', request_id, outcome='failure')
            return _error(401, '账户或登录凭据不正确；新设备请使用密码', 'invalid_credential')
        method = 'pin'
        _clear_attempts(c, buckets)
    view = c.execute('SELECT active FROM viewers WHERE user_id=?', (actor['id'],)).fetchone()
    if view and not view['active']:
        return _error(403, '该展示账户已停用')
    if pending:
        previous = session(c, cookie_header)
        _, body, cookies = _issue(c, actor, 'setup', previous=previous)
        body['mode'] = 'setup'
        _clear_attempts(c, [ip_bucket])
        _audit(c, actor, 'setup_login', '使用原密码进入首次安全设置', request_id)
        return 200, body, cookies
    requested_management = data.get('mode', 'planning') in ('admin', 'management')
    strong = method == 'password' and len(credential) >= 12
    if requested_management and (method != 'password' or not strong or not (actor['admin'] or is_root(actor))):
        return _error(403, '进入管理需要管理权限和至少 12 位密码', 'management_auth_required')
    manage = bool(strong and (actor['admin'] or is_root(actor)) and data.get('mode') != 'planning_only')
    previous = session(c, cookie_header)
    _, body, cookies = _issue(c, actor, method, device, strong, manage, previous)
    body['mode'] = 'management' if requested_management else 'planning'
    _clear_attempts(c, [ip_bucket])
    _audit(c, actor, 'login', '使用密码登录' if method == 'password' else '使用 PIN 登录', request_id,
           changes=[dict(field='method', before=None, after=method)])
    return 200, body, cookies


def _proof(c, actor, s, data, ip, request_id, allow_legacy=False):
    supplied = data.get('current_password')
    if supplied is None and fresh(s):
        return None
    if not isinstance(supplied, str) or not 1 <= len(supplied) <= 256:
        return _error(403, '请先使用密码验证身份', 'password_required')
    now = time.time()
    buckets = ['verify:user:' + str(actor['id']), 'verify:ip:' + str(ip)]
    if _limited(c, buckets, 5, now):
        return _error(429, '密码验证次数过多，请 15 分钟后重试', 'authentication_limited')
    if not _matches(supplied, actor):
        _failed(c, buckets, now)
        _audit(c, actor, 'password_verification_failed', '密码验证失败', request_id, outcome='failure')
        return _error(403, '当前密码不正确', 'invalid_password')
    if len(supplied) < 12 and not allow_legacy:
        return _error(403, '请先将账户密码升级为至少 12 位', 'strong_password_required')
    _clear_attempts(c, buckets)
    return None


def _revoke_devices(c, uid):
    c.execute('UPDATE trusted_devices SET revoked=1 WHERE user_id=?', (uid,))
    c.execute("DELETE FROM sessions WHERE user_id=? AND (auth_method='pin' OR device_id<>'')", (uid,))


def route(c, actor, s, method, path, data, cookie_header, ip, request_id):
    pending = setup_required(c, actor)
    if pending and (path, method) not in {('/api/auth/context', 'GET'), ('/api/auth/setup', 'POST')}:
        if (path, method) == ('/api/logout', 'POST'):
            return None
        return _error(403, '请先完成强密码和 PIN 的首次安全设置', 'auth_setup_required')
    permission = re.fullmatch(r'/api/admin/users/([1-9][0-9]*)/permission', path)
    recognized = path in ('/api/auth/verify', '/api/auth/admin', '/api/auth/pin', '/api/auth/devices',
                          '/api/auth/password', '/api/auth/context', '/api/auth/setup') or path.startswith('/api/auth/devices/') or permission
    if not recognized:
        return None
    if not isinstance(data, dict):
        return _error(400, '需要 JSON 对象')
    now = time.time()
    viewer = c.execute('SELECT 1 FROM viewers WHERE user_id=?', (actor['id'],)).fetchone()
    if viewer and (permission or path == '/api/auth/admin'):
        return _error(403, '展示账户不能使用管理功能')
    if path == '/api/auth/context' and method == 'GET':
        return 200, dict(auth=context(c, actor, s), csrf=s['csrf'], user=_public_user(c, actor),
                         setup_required=pending, setup_url='/setup/' if pending else None), []
    if path == '/api/auth/setup' and method == 'POST':
        if not pending:
            return _error(409, '首次安全设置已完成', 'auth_setup_completed')
        valid_session = c.execute("SELECT * FROM sessions WHERE token=? AND user_id=? AND auth_method='setup' AND expires>?",
                                  (s['token'], actor['id'], now)).fetchone()
        if valid_session is None or not 0 <= now - valid_session['created'] < SETUP_SECONDS:
            return _error(403, '请使用原密码重新登录后完成设置', 'auth_setup_session_required')
        password, pin = data.get('password'), data.get('pin')
        trust = data.get('trust_device', False)
        label = data.get('label', '此设备')
        if not isinstance(password, str) or not 12 <= len(password) <= 256:
            return _error(400, '新密码应为 12–256 位')
        if not isinstance(pin, str) or not re.fullmatch(r'[0-9]{4,6}', pin):
            return _error(400, 'PIN 应为 4–6 位数字')
        if type(trust) is not bool:
            return _error(400, '设备信任选项应为布尔值')
        if trust and (not isinstance(label, str) or not 1 <= len(label.strip()) <= 80 or any(ord(ch) < 32 for ch in label)):
            return _error(400, '设备名称应为 1–80 位')
        salt, pin_salt = secrets.token_hex(16), secrets.token_hex(16)
        hashed, pin_hash = password_hash(password, salt), password_hash(pin, pin_salt)
        c.execute('UPDATE users SET salt=?,password=? WHERE id=?', (salt, hashed, actor['id']))
        c.execute('''INSERT INTO user_auth(user_id,pin_salt,pin_hash,setup_version) VALUES(?,?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET pin_salt=excluded.pin_salt,pin_hash=excluded.pin_hash,setup_version=excluded.setup_version''',
                  (actor['id'], pin_salt, pin_hash, SETUP_VERSION))
        c.execute('DELETE FROM sessions WHERE user_id=?', (actor['id'],))
        _revoke_devices(c, actor['id'])
        device, device_cookie = None, _cookie(DEVICE_COOKIE)
        if trust:
            token, did = secrets.token_urlsafe(32), secrets.token_hex(12)
            c.execute('INSERT INTO trusted_devices(id,user_id,token_hash,label,created,expires) VALUES(?,?,?,?,?,?)',
                      (did, actor['id'], _digest(token), label.strip(), now, now + DEVICE_SECONDS))
            device = c.execute('SELECT * FROM trusted_devices WHERE id=?', (did,)).fetchone()
            device_cookie = _cookie(DEVICE_COOKIE, token, DEVICE_SECONDS)
        updated = c.execute('SELECT * FROM users WHERE id=?', (actor['id'],)).fetchone()
        _, body, cookies = _issue(c, updated, 'password', device=device, strong=True,
                                  unlock=bool(not viewer and (updated['admin'] or is_root(updated))))
        cookies.append(device_cookie)
        _audit(c, updated, 'credentials_setup_completed', '完成强密码和 PIN 首次安全设置', request_id)
        if trust:
            _audit(c, updated, 'device_trusted', '信任设备：' + label.strip(), request_id, object_id=device['id'],
                   changes=[dict(field='device', before=None, after=label.strip())])
        return 200, body, cookies
    if path == '/api/auth/verify' and method == 'POST':
        if not isinstance(data.get('password'), str) or not data['password']:
            return _error(403, '请输入账户密码', 'password_required')
        error = _proof(c, actor, s, {'current_password': data.get('password')}, ip, request_id)
        if error:
            return error
        device = _device(c, cookie_header, actor['id'], now)
        _, body, cookies = _issue(c, actor, 'password', device, True, bool(not viewer and (actor['admin'] or is_root(actor))), s)
        _audit(c, actor, 'password_verified', '密码验证并解锁管理' if actor['admin'] else '密码验证', request_id)
        return 200, body, cookies
    if path == '/api/auth/admin' and method == 'DELETE':
        c.execute('UPDATE sessions SET admin_started=0,admin_touched=0 WHERE token=?', (s['token'],))
        updated = c.execute('SELECT * FROM sessions WHERE token=?', (s['token'],)).fetchone()
        _audit(c, actor, 'management_locked', '退出管理状态', request_id)
        return 200, dict(ok=True, auth=context(c, actor, updated)), []
    if path == '/api/auth/password' and method == 'POST':
        password = data.get('password')
        if not isinstance(password, str) or not 12 <= len(password) <= 256:
            return _error(400, '新密码应为 12–256 位')
        error = _proof(c, actor, s, data, ip, request_id, allow_legacy=True)
        if error:
            return error
        salt = secrets.token_hex(16)
        c.execute('UPDATE users SET salt=?,password=? WHERE id=?', (salt, password_hash(password, salt), actor['id']))
        c.execute('DELETE FROM sessions WHERE user_id=?', (actor['id'],))
        _revoke_devices(c, actor['id'])
        _audit(c, actor, 'password_changed', '修改账户密码并退出所有设备', request_id)
        return 200, dict(ok=True, reauth=True), [_cookie('session'), _cookie(DEVICE_COOKIE)]
    if path == '/api/auth/pin' and method in ('PUT', 'DELETE'):
        if method == 'PUT' and (not isinstance(data.get('pin'), str) or not re.fullmatch(r'[0-9]{4,6}', data['pin'])):
            return _error(400, 'PIN 应为 4–6 位数字')
        error = _proof(c, actor, s, data, ip, request_id)
        if error:
            return error
        salt = secrets.token_hex(16) if method == 'PUT' else ''
        hashed = password_hash(data['pin'], salt) if method == 'PUT' else ''
        c.execute('''INSERT INTO user_auth(user_id,pin_salt,pin_hash) VALUES(?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET pin_salt=excluded.pin_salt,pin_hash=excluded.pin_hash''', (actor['id'], salt, hashed))
        _revoke_devices(c, actor['id'])
        # Retain planning on this browser after explicit password proof, but remove its old device binding.
        _, body, cookies = _issue(c, actor, 'password', strong=True, previous=s)
        cookies.append(_cookie(DEVICE_COOKIE))
        _audit(c, actor, 'pin_changed' if method == 'PUT' else 'pin_disabled',
               '设置 PIN 并撤销原设备信任' if method == 'PUT' else '关闭 PIN 并撤销设备信任', request_id)
        return 200, body, cookies
    if path == '/api/auth/devices' and method == 'GET':
        current = _device(c, cookie_header, actor['id'], now)
        rows = c.execute('SELECT id,label,created,expires FROM trusted_devices WHERE user_id=? AND revoked=0 AND expires>? ORDER BY created DESC', (actor['id'], now)).fetchall()
        return 200, dict(devices=[dict(r, current=bool(current and current['id'] == r['id'])) for r in rows]), []
    if path == '/api/auth/devices' and method == 'POST':
        label = data.get('label', '此设备')
        if not isinstance(label, str) or not 1 <= len(label.strip()) <= 80 or any(ord(ch) < 32 for ch in label):
            return _error(400, '设备名称应为 1–80 位')
        error = _proof(c, actor, s, data, ip, request_id)
        if error:
            return error
        old = _device(c, cookie_header, actor['id'], now)
        if old:
            # Repeated trust requests never prolong an existing device's fixed deadline.
            return 200, dict(ok=True, device=dict(id=old['id'], label=old['label'], expires=old['expires'])), []
        token = secrets.token_urlsafe(32)
        did = secrets.token_hex(12)
        c.execute('INSERT INTO trusted_devices(id,user_id,token_hash,label,created,expires) VALUES(?,?,?,?,?,?)',
                  (did, actor['id'], _digest(token), label.strip(), now, now + DEVICE_SECONDS))
        c.execute('UPDATE sessions SET device_id=?,expires=min(expires,?) WHERE token=?', (did, now + DEVICE_SECONDS, s['token']))
        _audit(c, actor, 'device_trusted', '信任设备：' + label.strip(), request_id, object_id=did,
               changes=[dict(field='device', before=None, after=label.strip())])
        return 200, dict(ok=True, device=dict(id=did, label=label.strip(), expires=now + DEVICE_SECONDS)), [_cookie(DEVICE_COOKIE, token, DEVICE_SECONDS)]
    match = re.fullmatch(r'/api/auth/devices/([A-Za-z0-9_-]{1,128})', path)
    if match and method == 'DELETE':
        error = _proof(c, actor, s, data, ip, request_id)
        if error:
            return error
        device = c.execute('SELECT id,label FROM trusted_devices WHERE id=? AND user_id=? AND revoked=0', (match[1], actor['id'])).fetchone()
        if device is None:
            return _error(404, '设备不存在')
        c.execute('UPDATE trusted_devices SET revoked=1 WHERE id=?', (device['id'],))
        c.execute('DELETE FROM sessions WHERE device_id=?', (device['id'],))
        current = device['id'] == s['device_id']
        _audit(c, actor, 'device_revoked', '撤销设备：' + device['label'], request_id, object_id=device['id'])
        return 200, dict(ok=True, reauth=current), [_cookie('session'), _cookie(DEVICE_COOKIE)] if current else []
    if permission and method == 'PUT':
        if not admin_active(actor, s):
            return _error(403, '请先使用密码进入管理', 'management_auth_required')
        error = _proof(c, actor, s, data, ip, request_id)
        if error:
            return error
        if type(data.get('admin')) is not bool:
            return _error(400, '管理权限应为布尔值')
        uid = int(permission[1])
        target = c.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone()
        if target is None:
            return _error(404, '账户不存在')
        if c.execute('SELECT 1 FROM viewers WHERE user_id=?', (uid,)).fetchone():
            return _error(400, '展示账户不能获得管理权限')
        desired = int(data['admin'])
        if is_root(target) and not desired:
            return _error(403, '根管理员的管理权限不能撤销', 'root_admin_protected')
        if target['admin'] == desired:
            return 200, dict(ok=True, admin=bool(desired)), []
        changed = c.execute('''UPDATE users SET admin=? WHERE id=? AND admin<>?
            AND (?=1 OR (SELECT count(*) FROM users WHERE admin=1)>1)''', (desired, uid, desired, desired)).rowcount
        if not changed:
            return _error(409, '必须保留至少一位管理员', 'last_administrator')
        c.execute('UPDATE sessions SET admin_started=0,admin_touched=0 WHERE user_id=?', (uid,))
        _audit(c, actor, 'management_permission_changed', '授予管理权限' if desired else '撤销管理权限', request_id,
               owner_id=uid, object_id=uid, changes=[dict(field='admin', before=bool(target['admin']), after=bool(desired))])
        return 200, dict(ok=True, admin=bool(desired)), []
    return _error(405, '此接口不支持该操作')
