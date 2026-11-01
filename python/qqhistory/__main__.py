"""One bounded request per process; keys and SQL errors never cross stdout."""
import json
import sys
from .reader import QQError, capture, load_config, query, fingerprint
import hashlib


def main():
    try:
        request = json.load(sys.stdin)
        config, config_revision = load_config(request['config'])
        with capture(config) as (db, source_revision, plain):
            aux = [fingerprint(config['db_dir'] / name) for name in ('group_info.db', 'profile_info.db')]
            revision = hashlib.sha256((config_revision + source_revision + repr(aux)).encode()).hexdigest()
            if request.get('revision') and request['revision'] != revision:
                raise QQError('CURSOR_STALE')
            data = query(db, config, request['action'], request.get('args', {}))
            if request['action'] == 'status':
                from .check import process_status
                data['diagnostic'] = {**process_status(), 'config': True, 'database': True,
                                      'key': 'not_required' if plain else 'verified'}
            if aux != [fingerprint(config['db_dir'] / name) for name in ('group_info.db', 'profile_info.db')]:
                raise QQError('QQ_SOURCE_BUSY')
            result = {'success': True, 'data': data, 'revision': revision, 'uin': str(config['uin']),
                      'plain': plain}
        print(json.dumps(result, ensure_ascii=False))
    except QQError as error:
        print(json.dumps({'success': False, 'code': error.code}))
    except Exception:
        print(json.dumps({'success': False, 'code': 'QQ_READ_FAILED'}))


if __name__ == '__main__':
    main()
