import sqlite3
import tempfile
import unittest
from pathlib import Path

from fixtures import make_account, install_snapshot
from weflow_backend.backend import Backend
from wxtext.adapter import message_table


class DiscoveryEvidenceTests(unittest.TestCase):
    def test_sessions_and_cache_across_backend_processes(self):
        with tempfile.TemporaryDirectory() as home:
            home = Path(home)
            root, _ = make_account(home)
            table = message_table('123@chatroom')
            with sqlite3.connect(root / 'message/message_1.db') as db:
                db.execute(f'INSERT INTO {table} VALUES(?,?,?,?,?,?,?,?)',
                           (2, 999, 10000, 2, 7, 1699999999, '你创建了群聊', 0))
            db.close()
            backend = Backend(home / 'state')
            meta = install_snapshot(backend, root)
            backend.root, backend.meta, backend.owner = root, meta, 'wxid_me'
            sessions = backend.getSessions()['sessions']
            self.assertTrue(any(s['username'] == '123@chatroom' for s in sessions))
            evidence = backend.getChatCreationEvidence(['123@chatroom'])
            self.assertEqual(evidence['remaining'], 0)
            self.assertEqual(evidence['entries']['123@chatroom'], {'firstAt': 1699999999, 'createdAt': 1699999999})
            backend.close()
            restarted = Backend(home / 'state')
            restarted.root, restarted.meta, restarted.owner = root, meta, 'wxid_me'
            # A cache hit must not open or scan a message database.
            restarted.listMessageDbs = lambda: {'data': []}
            self.assertEqual(restarted.getChatCreationEvidence(['123@chatroom'])['entries'], evidence['entries'])
            restarted.close()


if __name__ == '__main__':
    unittest.main()
