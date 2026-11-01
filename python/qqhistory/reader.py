"""QQ NT snapshots, protobuf parsing and bounded parameterized queries."""
import hashlib
import json
import re
import shutil
import sqlite3
import tempfile
from contextlib import contextmanager
from pathlib import Path


class QQError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def fields(blob):
    if len(blob) > 8_000_000:
        raise ValueError('protobuf too large')
    pos = 0
    def varint():
        nonlocal pos
        value = 0
        for shift in range(0, 70, 7):
            if pos >= len(blob):
                raise ValueError('truncated varint')
            byte = blob[pos]
            pos += 1
            value |= (byte & 127) << shift
            if byte < 128:
                return value
        raise ValueError('varint overflow')
    while pos < len(blob):
        tag = varint()
        number, wire = tag >> 3, tag & 7
        if not number:
            raise ValueError('invalid tag')
        if wire == 0:
            value = varint()
        elif wire in (1, 2, 5):
            size = varint() if wire == 2 else (8 if wire == 1 else 4)
            if pos + size > len(blob):
                raise ValueError('truncated field')
            value = blob[pos:pos + size]
            pos += size
        else:
            raise ValueError('unsupported wire type')
        yield number, wire, value


def parse_body(blob):
    text, unresolved = [], 0
    try:
        for number, wire, value in fields(blob or b''):
            if number != 40800 or wire != 2:
                unresolved += 1
                continue
            segment = list(fields(value))
            kind = next((v for n, w, v in segment if n == 45002 and w == 0), None)
            strings = [v.decode('utf-8', errors='strict') for n, w, v in segment if n == 45101 and w == 2]
            if kind == 1 and strings:
                text.extend(strings)
            else:
                unresolved += 1
        if not blob:
            unresolved += 1
        return {'text': ''.join(text), 'type': 'text' if text and not unresolved else 'other',
                'unresolved_elements': unresolved, 'parse_status': 'partial' if unresolved else 'parsed'}
    except (ValueError, UnicodeError):
        return {'text': '', 'type': 'other', 'unresolved_elements': 1, 'parse_status': 'invalid'}


def load_config(filename):
    path = Path(filename).resolve()
    try:
        raw = path.read_bytes()
        value = json.loads(raw.decode('utf-8-sig'))
        root = Path(value['db_dir']).expanduser()
        if not root.is_absolute() or not str(value['uin']).isdigit():
            raise ValueError()
        if value.get('hmac', 'HMAC_SHA1') not in ('HMAC_SHA1', 'HMAC_SHA256', 'HMAC_SHA512'):
            raise ValueError()
        password = None
        key_raw = b''
        if value.get('key_file'):
            key_path = Path(value['key_file'])
            if not key_path.is_absolute():
                key_path = path.parent / key_path
            key_raw = key_path.read_bytes()
            password = json.loads(key_raw.decode('utf-8-sig'))['password']
            if not isinstance(password, str) or not password or '\x00' in password:
                raise ValueError()
        value.update(db_dir=root, password=password)
        return value, hashlib.sha256(raw + key_raw).hexdigest()
    except (OSError, ValueError, KeyError, TypeError):
        raise QQError('QQ_CONFIG_INVALID') from None


def fingerprint(path):
    values = []
    for suffix in ('', '-wal', '-journal'):
        candidate = Path(str(path) + suffix)
        try:
            stat = candidate.stat()
            with candidate.open('rb') as stream:
                first = stream.read(8192)
                stream.seek(max(0, stat.st_size - 8192))
                last = stream.read(8192)
            # SQLite's change counter / SQLCipher first-page MAC and WAL tail
            # distinguish same-size commits even on coarse-timestamp filesystems.
            guard = hashlib.sha256(first + last).hexdigest()
            values.append((suffix, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_ino, guard))
        except FileNotFoundError:
            values.append((suffix, None))
    return values


@contextmanager
def capture(config, filename='nt_msg.db'):
    source = config['db_dir'] / filename
    if not source.is_file():
        raise QQError('QQ_DB_NOT_FOUND')
    # A hot rollback journal cannot safely be reconstructed as a WAL capture.
    if Path(str(source) + '-journal').exists():
        raise QQError('QQ_SOURCE_BUSY')
    before = fingerprint(source)
    with tempfile.TemporaryDirectory(prefix='weflow-qq-') as directory:
        target = Path(directory) / filename
        with source.open('rb') as incoming, target.open('wb') as outgoing:
            header = incoming.read(16)
            plain = header == b'SQLite format 3\x00'
            incoming.seek(0 if plain else 1024)
            shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
        wal = Path(str(source) + '-wal')
        if wal.exists():
            shutil.copyfile(wal, str(target) + '-wal')
        if fingerprint(source) != before:
            raise QQError('QQ_SOURCE_BUSY')
        db = None
        try:
            if plain:
                db = sqlite3.connect(str(target))
            else:
                if not config.get('password'):
                    raise QQError('QQ_KEY_REQUIRED')
                try:
                    from sqlcipher3 import dbapi2 as cipher
                except ImportError:
                    raise QQError('QQ_SQLCIPHER_UNAVAILABLE') from None
                db = cipher.connect(str(target))
                db.execute('PRAGMA cipher_page_size=4096')
                password = config['password'].replace("'", "''")
                db.execute(f"PRAGMA key='{password}'")
                db.execute('PRAGMA kdf_iter=4000')
                db.execute('PRAGMA cipher_hmac_algorithm=' + config.get('hmac', 'HMAC_SHA1'))
                db.execute('PRAGMA cipher_kdf_algorithm=PBKDF2_HMAC_SHA512')
            db.execute('PRAGMA query_only=ON')
            db.execute('SELECT count(*) FROM sqlite_master').fetchone()
            yield db, hashlib.sha256(repr(before).encode()).hexdigest(), plain
            if fingerprint(source) != before:
                raise QQError('QQ_SOURCE_BUSY')
        finally:
            if db is not None:
                db.close()


TABLES = (('private', 'c2c_msg_table'), ('group', 'group_msg_table'))
REQUIRED = {'40001', '40030', '40033', '40050', '40013', '40800'}


def message_union(db):
    selects = []
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for kind, table in TABLES:
        if table not in tables:
            continue
        cols = {row[1] for row in db.execute(f'PRAGMA table_info("{table}")')}
        if not REQUIRED <= cols:
            raise QQError('QQ_SCHEMA_UNSUPPORTED')
        name = '"40093"' if '40093' in cols else "''"
        card = '"40090"' if '40090' in cols else "''"
        sender_fallback = '"40020"' if '40020' in cols else 'NULL'
        peer_fallback = '"40021"' if '40021' in cols else 'NULL'
        peer = f'CASE WHEN "40030" IS NOT NULL AND "40030" != 0 THEN CAST("40030" AS TEXT) ELSE {peer_fallback} END'
        sender = f'CASE WHEN "40033" IS NOT NULL AND "40033" != 0 THEN CAST("40033" AS TEXT) ELSE {sender_fallback} END'
        selects.append(f'''SELECT '{kind}' kind, CAST("40001" AS TEXT) id,
          {peer} peer, {sender} sender,
          "40050" timestamp, "40013" direction, "40800" body, {name} nickname, {card} card
          FROM "{table}"''')
    if not selects:
        raise QQError('QQ_SCHEMA_UNSUPPORTED')
    return ' UNION ALL '.join(selects)


def chat_id(uin, kind, peer):
    if not isinstance(peer, str) or not re.fullmatch(r'(?:[1-9][0-9]*|u_[A-Za-z0-9_-]+)', peer):
        raise QQError('QQ_PEER_ID_UNAVAILABLE')
    return f'qq:{uin}:{kind}:{peer}'



def contact_names(config):
    """Known, version-specific name tables; absent schemas fall back to IDs."""
    names = {}
    specs = [('group_info.db', ('group_list', 'group_detail_info_ver1'), '60001', ('60026', '60007'), 'group'),
             ('profile_info.db', ('profile_info_v6',), '1002', ('20009', '20002'), 'private')]
    for filename, tables, key, name_cols, kind in specs:
        if not (config['db_dir'] / filename).is_file():
            continue
        try:
            with capture(config, filename) as (db, _, _):
                for table in tables:
                    cols = {r[1] for r in db.execute(f'PRAGMA table_info("{table}")')}
                    selected = [col for col in name_cols if col in cols]
                    if key not in cols or not selected:
                        continue
                    columns = ','.join('"' + col + '"' for col in [key, *selected])
                    for row in db.execute(f'SELECT {columns} FROM "{table}"'):
                        name = next((str(v) for v in row[1:] if v), None)
                        if name:
                            names[chat_id(str(config['uin']), kind, str(row[0]))] = name
        except Exception:
            # Auxiliary names never determine message identity or completeness.
            continue
    names.update(config.get('chat_names', {}))
    return names


def query(db, config, action, args):
    union = message_union(db)
    uin = str(config['uin'])
    if action == 'status':
        return {'state': 'ready', 'capabilities': {'text': True, 'live': True, 'complete_group_members': False,
                'media': False, 'quotes': False}, 'tables': [t for _, t in TABLES if db.execute(
                    "SELECT 1 FROM sqlite_master WHERE name=?", (t,)).fetchone()]}
    if action == 'find':
        rows = db.execute(f'''SELECT kind, peer, MAX(timestamp) last_active, COUNT(*) message_count
            FROM ({union}) GROUP BY kind, peer ORDER BY last_active DESC, kind, peer''')
        names = contact_names(config)
        chats = []
        for kind, peer, last, count in rows:
            identity = chat_id(uin, kind, peer)
            name = names.get(identity, peer)
            if args.get('kind', 'all') not in ('all', kind):
                continue
            if args.get('query', '').casefold() not in (name + ' ' + peer).casefold():
                continue
            if last < args.get('_active_since', 0):
                continue
            chats.append({'id': identity, 'name': name, 'kind': kind, 'last_active': last,
                          'message_count': count, 'name_source': 'contact_or_configured' if identity in names else 'id'})
        offset = args.get('_offset', 0)
        limit = args.get('limit', 20)
        return {'chats': chats[offset:offset + limit], 'has_more': len(chats) > offset + limit,
                'position': offset + limit}
    where, params = ['timestamp >= ?', 'timestamp < ?'], [args['_begin'], args['_end']]
    if args.get('chat_ids'):
        scope = []
        for identity in args['chat_ids']:
            parts = identity.split(':')
            if len(parts) != 4 or parts[:2] != ['qq', uin] or parts[2] not in ('private', 'group') or not re.fullmatch(r'(?:[1-9][0-9]*|u_[A-Za-z0-9_-]+)', parts[3]):
                raise QQError('INVALID_CHAT_ID')
            scope.append('(kind=? AND peer=?)')
            params.extend(parts[2:])
        where.append('(' + ' OR '.join(scope) + ')')
    desc = args.get('direction') == 'desc'
    op, order = ('<', 'DESC') if desc else ('>', 'ASC')
    if args.get('_position'):
        where.append(f'(timestamp, kind, CAST(id AS INTEGER)) {op} (?, ?, ?)')
        timestamp, kind, identity = args['_position']
        params.extend([timestamp, kind, int(identity)])
    sql = f'''SELECT * FROM ({union}) WHERE {' AND '.join(where)}
              ORDER BY timestamp {order}, kind {order}, CAST(id AS INTEGER) {order} LIMIT 10001'''
    messages, position, scanned, used, unresolved = [], args.get('_position'), 0, 0, 0
    limit, budget = args.get('limit', 500), args.get('max_chars', 120000) - 2500
    rows = db.execute(sql, params)
    more = False
    for kind, identity, peer, sender, timestamp, direction, body, nickname, card in rows:
        if scanned >= 10000 or len(messages) >= limit:
            more = True
            break
        parsed = parse_body(body)
        message = {'id': f'qq:{uin}:{kind}:{peer}:{identity}', 'chat_id': chat_id(uin, kind, peer),
                   'sender_id': f'qq:{uin}:person:{sender}' if sender else None, 'sender_name': card or nickname or sender,
                   'timestamp': timestamp, 'is_self': True if direction in (1, 2) else False if direction == 0 else None,
                   **parsed}
        match = not args.get('sender_ids') or message['sender_id'] in args['sender_ids']
        match = match and (not args.get('types') or message['type'] in args['types'])
        if action == 'search':
            hits = [term.casefold() in message['text'].casefold() for term in args['query']['terms']]
            match = match and (all(hits) if args['query'].get('operator') == 'all' else any(hits))
        size = len(json.dumps(message, ensure_ascii=False))
        if match and used + size > budget:
            if not messages:
                raise QQError('OUTPUT_BUDGET_TOO_SMALL')
            more = True
            break
        scanned += 1
        unresolved += parsed['unresolved_elements']
        position = [timestamp, kind, identity]
        if match:
            used += size
            messages.append(message)
    return {'messages': messages, 'has_more': more, 'position': position, 'scanned': scanned, 'unresolved_elements_scanned': unresolved}
