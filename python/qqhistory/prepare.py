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


def candidate_strings(block):
    # Candidates may end at any non-printable byte, not necessarily NUL.
    # Check entire runs so arbitrary substrings of text do not dominate the scan.
    for match in re.finditer(rb'(?<![\x21-\x7e])(?:[\x21-\x7e]{16}|[\x21-\x7e]{32})(?![\x21-\x7e])', block):
        yield match.group()


def discover(config, seconds=120):
    from wxtext.windows import WindowsSource, ProcessReader
    from wxtext.keyscan import memory_chunks
    source = WindowsSource()
    with (config['db_dir'] / 'nt_msg.db').open('rb') as stream:
        stream.seek(1024)
        page = stream.read(4096)
    tested = set()
    deadline = time.monotonic() + seconds
    # Focus on memory near this account or database filename first; scanning all
    # printable process strings is both slow and prone to exhausting the budget.
    anchors = re.compile(rb'nt_msg\.db|' + re.escape(str(config.get('uin', '')).encode('ascii')),
                         re.IGNORECASE) if config.get('uin') else re.compile(rb'nt_msg\.db', re.I)
    for process in source.processes({'qq.exe'}):
        with source.handle(process.pid, 0x1010) as handle:
            for _, block in memory_chunks(ProcessReader(source, handle), deadline):
                windows = [block[max(0, m.start() - 4096):m.end() + 4096] for m in anchors.finditer(block)]
                # Include the block for test readers and as a fallback when no path is present.
                if not windows:
                    windows = [block]
                for window in windows:
                    for candidate in candidate_strings(window):
                        if time.monotonic() >= deadline or len(tested) >= 40000:
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
