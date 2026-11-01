"""QQ diagnostics: never query message bodies or print passwords."""
import argparse
import json
import sys
from pathlib import Path
from .reader import QQError, capture, load_config, message_union


def process_status():
    result = {'platform': sys.platform, 'install': 'unknown', 'login': 'unknown', 'process_running': None}
    if sys.platform == 'win32':
        try:
            from wxtext.windows import WindowsSource
            running = bool(WindowsSource().processes({'qq.exe'}))
            result.update(process_running=running, install='detected' if running else 'unknown')
            # A running process is not evidence of an authenticated QQ session.
        except Exception:
            result['process_check'] = 'access_failed'
        if result['install'] == 'unknown':
            try:
                import winreg
                for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
                    for base in (r'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
                                 r'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'):
                        try:
                            with winreg.OpenKey(hive, base) as parent:
                                for index in range(winreg.QueryInfoKey(parent)[0]):
                                    with winreg.OpenKey(parent, winreg.EnumKey(parent, index)) as entry:
                                        try:
                                            name = winreg.QueryValueEx(entry, 'DisplayName')[0]
                                            if name in ('QQ', 'QQNT') or name.startswith('QQ '):
                                                result['install'] = 'detected'
                                        except OSError:
                                            pass
                        except OSError:
                            pass
            except Exception:
                pass
    return result


def diagnose(filename):
    result = {**process_status(), 'config': False, 'database': False, 'key': 'unknown', 'success': False}
    try:
        config, _ = load_config(filename)
        result['config'] = True
        result['database'] = (config['db_dir'] / 'nt_msg.db').is_file()
        result['key'] = 'configured' if config.get('password') else 'missing'
        with capture(config) as (db, _, plain):
            message_union(db)  # schema inspection only; never SELECT message bodies
            result.update(success=True, key='not_required' if plain else 'verified', schema='supported')
    except QQError as error:
        result['code'] = error.code
    except Exception:
        result['code'] = 'QQ_READ_FAILED'
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    result = diagnose(args.config)
    print(json.dumps(result))
    raise SystemExit(0 if result['success'] else 1)


if __name__ == '__main__':
    main()
