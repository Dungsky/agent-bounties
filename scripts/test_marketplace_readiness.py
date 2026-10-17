import copy
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
from marketplace_readiness import PROTOCOLS, enabled_for_release, inspect, main, observe


class MarketplaceReadinessTests(unittest.TestCase):
    def test_activation_requires_exact_verified_release_and_does_not_probe_early(self):
        self.assertFalse(enabled_for_release('a' * 40, None))
        self.assertTrue(enabled_for_release('a' * 40, 'A' * 40))
        for expected, verified in [('a' * 40, 'b' * 40), ('main', 'a' * 40),
                                   (None, 'a' * 40), ('a' * 40, 'a' * 8)]:
            with self.assertRaises(ValueError):
                enabled_for_release(expected, verified)
        with patch('marketplace_readiness.observe') as probe:
            self.assertEqual(main(['--api-base-url', 'https://example.invalid',
                                   '--expected-revision', 'a' * 40]), 0)
            probe.assert_not_called()

    def setUp(self):
        self.now = datetime.now(timezone.utc)
        self.payload = {'schema': 'agent-bounties/marketplace-readiness-v1', 'ready': True,
                        'checked_at': self.now.isoformat(), 'safe_block': 1000, 'latest_block': 1010,
                        'readers': [{'protocol': p, 'ready': True, 'blocker': None,
                                     'heartbeat_age_seconds': 1, 'cursor_block': 999, 'lag_blocks': 1}
                                    for p in sorted(PROTOCOLS)]}

    def test_all_readers_required_even_when_services_and_aggregate_are_green(self):
        self.assertEqual(inspect(self.payload, self.now)['state'], 'healthy')
        for position in range(3):
            for patch in [{'ready': False}, {'blocker': 'reader_failed'}, {'heartbeat_age_seconds': 91},
                          {'heartbeat_age_seconds': -1}, {'lag_blocks': 21}, {'cursor_block': 900},
                          {'heartbeat_age_seconds': True}, {'cursor_block': None}]:
                data = copy.deepcopy(self.payload); data['readers'][position].update(patch)
                self.assertNotEqual(inspect(data, self.now)['state'], 'healthy')

    def test_missing_duplicate_future_or_stale_data_fail_closed(self):
        for patch in [{'readers': self.payload['readers'][:2]},
                      {'readers': [self.payload['readers'][0]] * 3}, {'safe_block': None},
                      {'checked_at': (self.now - timedelta(seconds=91)).isoformat()},
                      {'checked_at': (self.now + timedelta(seconds=1)).isoformat()},
                      {'checked_at': 'invalid'}, {'schema': 'other'}, {'readers': [None]*3}]:
            data = dict(self.payload, **patch)
            self.assertEqual(inspect(data, self.now)['state'], 'unavailable')

    def test_cursor_upper_bound_respects_each_protocol_clock(self):
        for protocol in PROTOCOLS:
            for cursor, expected in [(1000, True), (1008, True), (2000, False)]:
                data = copy.deepcopy(self.payload)
                reader = next(r for r in data['readers'] if r['protocol'] == protocol)
                reader.update(cursor_block=cursor, lag_blocks=0)
                with self.subTest(protocol=protocol, cursor=cursor):
                    result = inspect(data, self.now)
                    self.assertEqual(result['state'] == 'healthy', expected)
                    self.assertFalse(result['restartable'])
        for latest in [None, True, -1, 999, '1010']:
            self.assertEqual(inspect(dict(self.payload, latest_block=latest), self.now)['state'], 'unavailable')
        missing = dict(self.payload); del missing['latest_block']
        self.assertEqual(inspect(missing, self.now)['state'], 'unavailable')
        # A different provider's recently sampled safe tag may lag even the
        # Beta3 reader's previous safe checkpoint. Latest remains the upper bound.
        data = copy.deepcopy(self.payload)
        data.update(safe_block=52706877, latest_block=52706963)
        for reader in data['readers']:
            reader.update(cursor_block=52706913, lag_blocks=0)
        self.assertEqual(inspect(data, self.now)['state'], 'healthy')

    def test_real_http_503_and_200_both_check_body(self):
        payload = self.payload
        response_status = [200]
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(response_status[0]); self.end_headers()
                self.wfile.write(json.dumps(payload).encode())
            def log_message(self, *args): pass
        with HTTPServer(('127.0.0.1', 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            try:
                url = 'http://127.0.0.1:' + str(server.server_port)
                self.assertEqual(observe(url)['state'], 'healthy')
                payload['ready'] = False
                response_status[0] = 503
                result = observe(url)
                self.assertEqual(result['state'], 'stale')
                self.assertFalse(result['restartable'])
                payload['ready'] = True
                self.assertEqual(observe(url)['state'], 'unavailable')
            finally: server.shutdown(); thread.join()


if __name__ == '__main__': unittest.main()
