import hashlib
import hmac
import json
import sqlite3
import struct
import tempfile
import unittest
from pathlib import Path
from qqhistory.reader import QQError, capture, load_config, parse_body, query
from qqhistory.prepare import verify_password
from qqhistory.check import diagnose


def varint(number):
    value = bytearray()
    while number > 127:
        value.append((number & 127) | 128)
        number >>= 7
    return bytes(value + bytes([number]))


def field(number, value):
    if isinstance(value, int):
        return varint(number << 3) + varint(value)
    return varint((number << 3) | 2) + varint(len(value)) + value


def body(text):
    return field(40800, field(45002, 1) + field(45101, text.encode()))


def fixture(path):
    db = sqlite3.connect(path)
    for table in ('c2c_msg_table', 'group_msg_table'):
        db.execute(f'''CREATE TABLE {table} ("40001" INTEGER PRIMARY KEY, "40030" INTEGER,
          "40033" INTEGER, "40050" INTEGER, "40013" INTEGER, "40800" BLOB, "40093" TEXT)''')
    return db


class QQTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.path = self.root / 'nt_msg.db'
        self.db = fixture(self.path)
        self.config = {'db_dir': self.root, 'uin': '123'}

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def add(self, identity, text, timestamp=1000, table='c2c_msg_table', peer=456):
        self.db.execute(f'INSERT INTO {table} VALUES (?, ?, ?, ?, ?, ?, ?)',
                        (identity, peer, 456, timestamp, 0, body(text), 'Alice'))
        self.db.commit()

    def args(self, **extra):
        return {'_begin': 0, '_end': 2000, 'chat_ids': ['qq:123:private:456'], **extra}

    def test_chat_first_seen_sort_and_filter(self):
        self.add(1, 'one', timestamp=100, table='group_msg_table', peer=111)
        self.add(2, 'two', timestamp=300, table='group_msg_table', peer=111)
        self.add(3, 'three', timestamp=200, table='group_msg_table', peer=222)
        found = query(self.db, self.config, 'find', {'kind': 'group', 'sort': 'created_at'})['chats']
        self.assertEqual([c['first_seen'] for c in found], [200, 100])
        self.assertEqual(found[1]['last_active'], 300)
        filtered = query(self.db, self.config, 'find', {'_created_since': 150})['chats']
        self.assertEqual(len(filtered), 1)

    def test_protobuf_exact_field_unicode_mixed_and_invalid(self):
        self.assertEqual(parse_body(body('你好🙂\nexact'))['text'], '你好🙂\nexact')
        mixed = body('hello') + field(40800, field(45002, 2) + field(45402, b'photo.jpg'))
        self.assertEqual(parse_body(mixed)['unresolved_elements'], 1)
        self.assertEqual(parse_body(mixed)['text'], 'hello')
        self.assertEqual(parse_body(b'\x80')['parse_status'], 'invalid')
        self.assertEqual(parse_body(field(1, b'not a message'))['text'], '')
        self.assertEqual(parse_body(field(40800, field(45002, 1) + field(45101, b'\xff')))['parse_status'], 'invalid')

    def test_query_keyset_ids_filter_and_injection(self):
        self.add(9007199254740993, 'first')
        self.add(9007199254740994, "literal ' OR 1=1 --")
        self.add(7, 'group', table='group_msg_table', peer=789)
        first = query(self.db, self.config, 'read', self.args(limit=1))
        self.assertTrue(first['has_more'])
        self.assertTrue(first['messages'][0]['id'].endswith('9007199254740993'))
        second = query(self.db, self.config, 'read', self.args(_position=first['position'], limit=1))
        self.assertEqual(second['messages'][0]['text'], "literal ' OR 1=1 --")
        self.assertFalse(second['has_more'])
        result = query(self.db, self.config, 'search', self.args(query={'terms': ["' OR 1=1 --"]}))
        self.assertEqual(len(result['messages']), 1)
        with self.assertRaises(QQError):
            query(self.db, self.config, 'read', self.args(chat_ids=['qq:999:private:456']))
        descending = query(self.db, self.config, 'read', self.args(direction='desc'))
        self.assertEqual(descending['messages'][0]['text'], second['messages'][0]['text'])

    def test_live_wal_capture_is_read_only_and_sees_commits(self):
        self.db.execute('PRAGMA journal_mode=WAL')
        self.add(1, 'before')
        before = self.path.read_bytes()
        wal_before = Path(str(self.path) + '-wal').read_bytes()
        with capture(self.config) as (db, revision, plain):
            self.assertTrue(plain)
            self.assertEqual(len(query(db, self.config, 'read', self.args())['messages']), 1)
            with self.assertRaises(sqlite3.OperationalError):
                db.execute('DELETE FROM c2c_msg_table')
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(Path(str(self.path) + '-wal').read_bytes(), wal_before)
        self.add(2, 'after')
        with capture(self.config) as (db, updated, _):
            self.assertNotEqual(revision, updated)
            self.assertEqual(len(query(db, self.config, 'read', self.args())['messages']), 2)

    def test_uid_fallback_keeps_unknown_senders_and_peers_separate(self):
        self.db.execute('ALTER TABLE c2c_msg_table ADD COLUMN "40020" TEXT')
        self.db.execute('ALTER TABLE c2c_msg_table ADD COLUMN "40021" TEXT')
        self.db.execute('INSERT INTO c2c_msg_table VALUES (1,0,0,1000,0,?,NULL,?,?)',
                        (body('UID text'), 'u_sender', 'u_peer'))
        self.db.commit()
        chats = query(self.db, self.config, 'find', {})
        self.assertEqual(chats['chats'][0]['id'], 'qq:123:private:u_peer')
        result = query(self.db, self.config, 'read', self.args(chat_ids=['qq:123:private:u_peer']))
        self.assertEqual(result['messages'][0]['sender_id'], 'qq:123:person:u_sender')
        self.db.execute('UPDATE c2c_msg_table SET "40020"=NULL')
        result = query(self.db, self.config, 'read', self.args(chat_ids=['qq:123:private:u_peer']))
        self.assertIsNone(result['messages'][0]['sender_id'])

    def test_unknown_peer_rows_do_not_break_listing_or_unscoped_search(self):
        self.add(1, 'known')
        self.db.execute('INSERT INTO group_msg_table VALUES (2,0,0,1000,0,?,NULL)', (body('unknown'),))
        self.db.commit()
        found = query(self.db, self.config, 'find', {})
        self.assertEqual(len(found['chats']), 1)
        self.assertEqual(found['unidentified_messages'], 1)
        result = query(self.db, self.config, 'search', {'_begin': 0, '_end': 2000, 'query': {'terms': ['known']}})
        self.assertEqual(len(result['messages']), 1)
        self.assertEqual(result['unidentified_messages'], 1)

    def test_search_reports_unreadable_nonmatching_elements(self):
        self.db.execute('INSERT INTO c2c_msg_table VALUES (1,456,456,1000,0,?,NULL)',
                        (field(40800, field(45002, 2)),))
        result = query(self.db, self.config, 'search', self.args(query={'terms': ['missing']}))
        self.assertEqual(result['messages'], [])
        self.assertEqual(result['unresolved_elements_scanned'], 1)

    def test_names_never_use_last_sender_as_group_name(self):
        self.add(1, 'group', table='group_msg_table', peer=789)
        names = sqlite3.connect(self.root / 'group_info.db')
        names.execute('CREATE TABLE group_list ("60001" INTEGER, "60007" TEXT, "60026" TEXT)')
        names.execute('INSERT INTO group_list VALUES (789, ?, ?)', ('Group', 'Team'))
        names.commit(); names.close()
        result = query(self.db, self.config, 'find', {'query': 'Team'})
        self.assertEqual(result['chats'][0]['name'], 'Team')
        self.assertNotEqual(result['chats'][0]['name'], 'Alice')

    def test_schema_budget_and_capture_mutation_fail_closed(self):
        self.add(1, 'x' * 2000)
        with self.assertRaisesRegex(QQError, 'OUTPUT_BUDGET_TOO_SMALL'):
            query(self.db, self.config, 'read', self.args(max_chars=1000))
        with self.assertRaisesRegex(QQError, 'QQ_SOURCE_BUSY'):
            with capture(self.config):
                self.add(2, 'mutated')
        self.db.execute('ALTER TABLE c2c_msg_table RENAME COLUMN "40800" TO unknown')
        with self.assertRaisesRegex(QQError, 'QQ_SCHEMA_UNSUPPORTED'):
            query(self.db, self.config, 'status', {})

    def test_config_reload_and_diagnostics_have_no_message_contents(self):
        self.add(1, 'SECRET_MESSAGE')
        config = self.root / 'qq-config.json'
        key = self.root / 'key.json'
        key.write_text(json.dumps({'password': 'a' * 32}))
        config.write_text(json.dumps({'db_dir': str(self.root), 'uin': '123', 'key_file': str(key)}))
        value, revision = load_config(config)
        self.assertEqual(value['password'], 'a' * 32)
        key.write_text(json.dumps({'password': 'b' * 32}))
        self.assertNotEqual(load_config(config)[1], revision)
        diagnostic = diagnose(config)
        self.assertTrue(diagnostic['success'])
        self.assertNotIn('SECRET_MESSAGE', json.dumps(diagnostic))
        self.assertNotIn('b' * 32, json.dumps(diagnostic))

    def test_default_directory_uses_configured_root_then_redirected_documents(self):
        from unittest.mock import patch
        from qqhistory.reader import discover_db_dir
        public = self.root / 'public'
        ini = public / 'Documents' / 'Tencent' / 'QQ' / 'UserDataInfo.ini'
        ini.parent.mkdir(parents=True)
        custom = self.root / 'custom'
        documents = self.root / 'redirected'
        fallback = documents / 'Tencent Files' / '123' / 'nt_qq' / 'nt_db'
        fallback.mkdir(parents=True)
        (fallback / 'nt_msg.db').touch()
        ini.write_text('[UserDataSet]\nUserDataSavePath=' + str(custom) + '\n')
        with patch.dict('os.environ', {'PUBLIC': str(public)}), patch('qqhistory.reader.documents_folder', return_value=documents):
            self.assertEqual(discover_db_dir('123'), fallback)
            configured = custom / '123' / 'nt_qq' / 'nt_db'
            configured.mkdir(parents=True)
            (configured / 'nt_msg.db').touch()
            self.assertEqual(discover_db_dir('123'), configured)
            with self.assertRaisesRegex(QQError, 'QQ_DB_NOT_FOUND'):
                discover_db_dir('999')

    def test_password_authentication_sha1_sha256_sha512(self):
        for digest in ('sha1', 'sha256', 'sha512'):
            password, salt = b'0123456789abcdef0123456789abcdef', bytes(range(16))
            size = hashlib.new(digest).digest_size
            reserve = ((16 + size + 15) // 16) * 16
            page = bytearray(salt + bytes(4080))
            key = hashlib.pbkdf2_hmac('sha512', password, salt, 4000, 32)
            mac_key = hashlib.pbkdf2_hmac('sha512', key, bytes(x ^ 0x3a for x in salt), 2, 32)
            end = 4096 - reserve
            page[end + 16:end + 16 + size] = hmac.digest(mac_key, page[16:end + 16] + struct.pack('<I', 1), digest)
            self.assertTrue(verify_password(password, bytes(page), 'HMAC_' + digest.upper()))
            self.assertFalse(verify_password(b'wrong', bytes(page), 'HMAC_' + digest.upper()))

class QQEncryptedTests(unittest.TestCase):
    def test_real_sqlcipher_header_password_and_committed_wal(self):
        try:
            from sqlcipher3 import dbapi2 as cipher
        except ImportError:
            self.skipTest('sqlcipher3 not installed')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = root / 'raw.db'
            password = "0123456789abcdef0123456789abcdef"
            db = cipher.connect(str(raw))
            try:
                db.execute('PRAGMA cipher_page_size=4096')
                db.execute(f"PRAGMA key='{password}'")
                db.execute('PRAGMA kdf_iter=4000')
                db.execute('PRAGMA cipher_hmac_algorithm=HMAC_SHA1')
                db.execute('PRAGMA cipher_kdf_algorithm=PBKDF2_HMAC_SHA512')
                db.execute('CREATE TABLE c2c_msg_table ("40001" INTEGER, "40030" INTEGER, "40033" INTEGER, "40050" INTEGER, "40013" INTEGER, "40800" BLOB)')
                db.commit()
                db.execute('PRAGMA journal_mode=WAL')
                db.execute('INSERT INTO c2c_msg_table VALUES (1,456,456,1000,0,?)', (body('encrypted WAL message'),))
                db.commit()
                path = root / 'nt_msg.db'
                path.write_bytes(bytes(1024) + raw.read_bytes())
                Path(str(path) + '-wal').write_bytes(Path(str(raw) + '-wal').read_bytes())
                config = {'db_dir': root, 'uin': '123', 'password': password}
                with capture(config) as (reader, _, plain):
                    self.assertFalse(plain)
                    result = query(reader, config, 'read', {'_begin': 0, '_end': 2000})
                    self.assertEqual(result['messages'][0]['text'], 'encrypted WAL message')
                # The exact hex-looking password is a passphrase, never a raw key.
                self.assertTrue(verify_password(password.encode(), raw.read_bytes()[:4096]))
                with self.assertRaises(Exception):
                    with capture({**config, 'password': 'wrong'}):
                        pass
            finally:
                db.close()

class QQMemoryTests(unittest.TestCase):
    def test_candidate_scan_reuses_read_only_reader_and_authenticates(self):
        try:
            from unittest.mock import patch
            import wxtext.windows
        except ImportError:
            self.skipTest('existing WeChat native-reader dependencies not installed')
        from contextlib import nullcontext
        from qqhistory.prepare import discover, candidate_strings
        self.assertEqual(list(candidate_strings(b'\x00' + b'0123456789abcdef' + b'\xff')), [b'0123456789abcdef'])
        password = b'0123456789abcdef0123456789abcdef'
        salt = bytes(range(16))
        key = hashlib.pbkdf2_hmac('sha512', password, salt, 4000, 32)
        mac_key = hashlib.pbkdf2_hmac('sha512', key, bytes(x ^ 0x3a for x in salt), 2, 32)
        page = bytearray(salt + bytes(4080))
        page[4064:4084] = hmac.digest(mac_key, page[16:4064] + struct.pack('<I', 1), 'sha1')
        # HMAC_SHA1 reserve is 48: IV at 4048, digest at 4064.
        block = b'\x00' + b'x' * 32 + b'\x00' + password + b'\x00'
        class Source:
            def processes(self, names):
                assert names == {'qq.exe'}
                return [type('Process', (), {'pid': 42})()]
            def handle(self, pid, rights):
                assert (pid, rights) == (42, 0x1010)
                return nullcontext('read-only-handle')
        class Reader:
            def regions(self):
                return [(0x10000, len(block))]
            def read(self, address, size):
                return block[:size]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'nt_msg.db').write_bytes(bytes(1024) + page)
            with patch('wxtext.windows.WindowsSource', return_value=Source()), patch('wxtext.windows.ProcessReader', return_value=Reader()):
                self.assertEqual(discover({'db_dir': root}), password.decode())
                with self.assertRaisesRegex(QQError, 'QQ_KEY_NOT_FOUND'):
                    discover({'db_dir': root}, seconds=0)


if __name__ == '__main__':
    unittest.main()
