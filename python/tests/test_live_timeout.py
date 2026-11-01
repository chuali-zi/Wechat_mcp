"""Deterministic live deadline regressions; no Windows or wall-clock sleeps."""
from contextlib import redirect_stdout
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from weflow_backend.backend import Backend, live_query
from weflow_backend import cli
from weflow_backend.timeouts import live_timeout_ms
from wxtext.errors import ToolError


class LiveTimeoutTests(unittest.TestCase):
    def test_configuration(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(live_timeout_ms(), 30000)
        with patch.dict(os.environ, WEFLOW_LIVE_TIMEOUT_MS='60000'):
            self.assertEqual(live_timeout_ms(), 60000)
            self.assertEqual(live_timeout_ms(45000), 45000)
        for value in ('', '0', '-1', 'NaN', '1.5', '2147481648'):
            with self.subTest(value=value), self.assertRaises(ToolError):
                live_timeout_ms(value)

    def test_flag_before_or_after_subcommand_and_precedence(self):
        for argv in (['--live-timeout-ms', '45000', 'sessions'],
                     ['sessions', '--live-timeout-ms', '45000']):
            with patch.dict(os.environ, WEFLOW_LIVE_TIMEOUT_MS='invalid'):
                self.assertEqual(cli.parser().parse_args(argv).live_timeout_ms, 45000)
        with self.assertRaises(ToolError):
            cli.parser().parse_args(['sessions', '--live-timeout-ms', '0'])

    def test_cli_passes_flag_over_invalid_environment_to_backend(self):
        with patch.dict(os.environ, WEFLOW_LIVE_TIMEOUT_MS='invalid'), \
             patch.object(cli, 'Backend') as constructor, \
             patch.object(cli, 'execute', return_value={'success': True}), \
             redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(['sessions', '--live-timeout-ms', '45000']), 0)
            self.assertEqual(constructor.call_args.kwargs['live_read_timeout_ms'], 45000)
        with patch.dict(os.environ, WEFLOW_LIVE_TIMEOUT_MS='invalid'), \
             redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(['sessions']), 2)

    def test_gui_inherits_cli_override(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / 'WeFlow.exe'
            app.touch()
            args = cli.parser().parse_args(['launch', '--app', str(app), '--live-timeout-ms', '45000'])
            _, _, environment = cli.gui_command(args, Path(directory))
            self.assertEqual(environment['WEFLOW_LIVE_TIMEOUT_MS'], '45000')

    def test_actual_session_listing_can_cross_old_cutoff(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            backend = Backend(Path(directory))
            backend.mode = 'live'
            backend._last_status_state = 'ready'
            backend.pollLiveChanges = lambda: []
            clock = [100.0]
            def slow_contacts():
                clock[0] += 2.1
                return []
            backend.contact_rows = slow_contacts
            backend.listMessageDbs = lambda: {'data': []}
            with patch('weflow_backend.backend.time.monotonic', side_effect=lambda: clock[0]):
                self.assertEqual(backend.getSessions()['sessions'], [])
                backend.session_cache = None
                backend.live_read_timeout_ms = 2000
                with self.assertRaises(ToolError) as expired:
                    backend.getSessions()
                self.assertEqual(expired.exception.code, 'LIVE_READ_TIMEOUT')
                self.assertIsNone(backend._deadline)
            backend.close()

    def test_direct_and_rpc_deadlines_allow_slow_reads_and_still_expire(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            backend = Backend(Path(directory))
            backend.mode = 'live'
            backend._last_status_state = 'ready'
            backend.pollLiveChanges = lambda: []
            clock = [100.0]

            @live_query
            def read(backend):
                clock[0] += 2.1  # Owner's session list crosses the former 2s cutoff.
                backend._check_limits()
                return True

            with patch('weflow_backend.backend.time.monotonic', side_effect=lambda: clock[0]):
                self.assertTrue(read(backend))
                self.assertIsNone(backend._deadline)
                backend.begin_request('rpc')
                self.assertTrue(read(backend))
                clock[0] += 30
                self.assertEqual(backend._progress(), 1)
                with self.assertRaises(ToolError) as expired:
                    backend._check_limits()
                self.assertEqual(expired.exception.code, 'LIVE_READ_TIMEOUT')
                backend.end_request()
                backend.begin_request('explicit', 1000)
                with self.assertRaises(ToolError):
                    read(backend)
                backend.end_request()
                backend.begin_request('cancel')
                backend.request_cancel('cancel')
                with self.assertRaises(ToolError) as cancelled:
                    backend._check_limits()
                self.assertEqual(cancelled.exception.code, 'CANCELLED')
                backend.end_request()
                backend.mode = 'snapshot'
                backend.begin_request('snapshot')
                self.assertIsNone(backend._deadline)
                backend.end_request()
            backend.close()
