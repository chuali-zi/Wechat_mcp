"""Explicit best-effort, read-only QQ password discovery. Never invoked by MCP."""
import argparse
import hashlib
import hmac
import json
import re
import struct
import time
from pathlib import Path
from .reader import QQError, load_config, capture, message_union


def verify_password(password, page, algorithm='HMAC_SHA1'):
    if len(page) != 4096:
        return False
    digest = {'HMAC_SHA1': 'sha1', 'HMAC_SHA256': 'sha256', 'HMAC_SHA512': 'sha512'}[algorithm]
    size = hashlib.new(digest).digest_size
    reserve = ((16 + size + 15) // 16) * 16
    key = hashlib.pbkdf2_hmac('sha512', password, page[:16], 4000, 32)
    mac_key = hashlib.pbkdf2_hmac('sha512', key, bytes(x ^ 0x3a for x in page[:16]), 2, 32)
    end = 4096 - reserve
    actual = hmac.digest(mac_key, page[16:end + 16] + struct.pack('<I', 1), digest)
    return hmac.compare_digest(actual, page[end + 16:end + 16 + size])


def discover(config, seconds=20):
    from wxtext.windows import WindowsSource, ProcessReader
    from wxtext.keyscan import memory_chunks
    source = WindowsSource()
    with (config['db_dir'] / 'nt_msg.db').open('rb') as stream:
        stream.seek(1024)
        page = stream.read(4096)
    tested = set()
    deadline = time.monotonic() + seconds
    for process in source.processes({'qq.exe'}):
        with source.handle(process.pid, 0x1010) as handle:
            for _, block in memory_chunks(ProcessReader(source, handle), deadline):
                # Only full, NUL-terminated printable 32-byte passwords. No offsets,
                # executable signatures, injection, process writes or privilege changes.
                for match in re.finditer(rb'(?<![\x21-\x7e])([\x21-\x7e]{32})\x00', block):
                    candidate = match[1]
                    if time.monotonic() >= deadline or len(tested) >= 4096:
                        raise QQError('QQ_KEY_NOT_FOUND')
                    if candidate in tested:
                        continue
                    tested.add(candidate)
                    if verify_password(candidate, page, config.get('hmac', 'HMAC_SHA1')):
                        return candidate.decode('ascii')
    raise QQError('QQ_KEY_NOT_FOUND')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--output', required=True, help='New key JSON file; existing files are never overwritten')
    args = parser.parse_args()
    try:
        config, _ = load_config(args.config)
        password = discover(config)
        with capture({**config, 'password': password}) as (db, _, _):
            message_union(db)
        # Exclusive creation: do not overwrite arbitrary files or print the secret.
        with Path(args.output).open('x', encoding='utf-8') as stream:
            json.dump({'password': password}, stream)
        print(json.dumps({'success': True, 'key_saved': True}))
    except Exception as error:
        print(json.dumps({'success': False, 'code': getattr(error, 'code', 'QQ_PREPARE_FAILED')}))
        raise SystemExit(1)


if __name__ == '__main__':
    main()
