#!/usr/bin/env python3

from __future__ import annotations

import copy
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
import importlib.util
import json
import sys
import threading
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
REPO_ROOT = SCRIPT_DIR.parent
SPEC = importlib.util.spec_from_file_location("self_heal", SCRIPT_DIR / "self_heal.py")
assert SPEC and SPEC.loader
self_heal = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = self_heal
SPEC.loader.exec_module(self_heal)
from marketplace_readiness import PROTOCOLS


@contextmanager
def hosted_monitor_fixture(reader_ready=True, readiness_status=200, revision='a' * 40, ahead_cursor=None):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            if self.path == '/health':
                self.send_response(200)
                self.send_header('x-agent-bounties-revision', revision)
                self.send_header('x-agent-bounties-protocol', 'agent-bounties/v1')
                self.end_headers()
                self.wfile.write(b'ok')
            elif self.path == '/readiness/marketplace':
                self.send_response(readiness_status)
                self.end_headers()
                body = {
                    'schema': 'agent-bounties/marketplace-readiness-v1',
                    'checked_at': datetime.now(timezone.utc).isoformat(),
                    'ready': reader_ready, 'safe_block': 1000, 'latest_block': 1010,
                    'readers': [
                        {'protocol': protocol, 'ready': reader_ready, 'blocker': None,
                         'heartbeat_age_seconds': 1 if reader_ready else 91,
                         'cursor_block': 999, 'lag_blocks': 1}
                        for protocol in sorted(PROTOCOLS)
                    ],
                }
                if ahead_cursor is not None:
                    body['readers'][0].update(cursor_block=ahead_cursor, lag_blocks=0)
                self.wfile.write(json.dumps(body).encode())
            else:
                self.send_response(404)
                self.end_headers()

        def log_message(self, *args):
            pass

    with HTTPServer(('127.0.0.1', 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield 'http://127.0.0.1:' + str(server.server_port), requests
        finally:
            server.shutdown()
            thread.join()


class SelfHealingContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.policy = self_heal.load_json(REPO_ROOT / "ops/self-healing-policy.json")
        cls.fixtures = REPO_ROOT / "ops/fixtures/recovery-cases.json"

    def test_policy_and_recovery_bench_pass(self) -> None:
        self_heal.validate_policy(self.policy)
        report = self_heal.run_bench(self.policy, self.fixtures)

        self.assertTrue(report["gate"])
        self.assertEqual(report["failed"], 0)
        self.assertGreaterEqual(report["cases"], 12)
        self.assertEqual(report["score"], 1.0)

    def test_prohibited_action_cannot_be_allowlisted(self) -> None:
        policy = copy.deepcopy(self.policy)
        policy["prohibited_automatic_actions"].append("retry_probe")

        with self.assertRaisesRegex(self_heal.ContractError, "both automatic and prohibited"):
            self_heal.validate_policy(policy)

    def test_revision_comparison_ignores_hex_case_but_detects_real_skew(self) -> None:
        fixture = self_heal.load_json(self.fixtures)
        for api_revision, mcp_revision, expected, mismatch in (
            ("a" * 40, "a" * 40, "A" * 40, False),
            ("A" * 40, "a" * 40, "a" * 40, False),
            ("a" * 40, "b" * 40, "A" * 40, True),
            ("b" * 40, "b" * 40, "A" * 40, True),
        ):
            with self.subTest(api=api_revision, mcp=mcp_revision, expected=expected):
                snapshot = self_heal.deep_merge(fixture["base_snapshot"], {
                    "expected_revision": expected,
                    "components": {
                        "api": {"revision": api_revision},
                        "mcp": {"revision": mcp_revision},
                    },
                })
                plan = self_heal.evaluate(self.policy, snapshot)
                self.assertEqual("API/MCP deployed revision skew" in plan["reasons"], mismatch)

    def test_automatic_action_risk_cannot_exceed_r2(self) -> None:
        policy = copy.deepcopy(self.policy)
        policy["automatic_actions"]["retry_probe"]["risk_class"] = "R3"

        with self.assertRaisesRegex(self_heal.ContractError, "must be R0, R1, or R2"):
            self_heal.validate_policy(policy)

    def test_integrity_failure_emits_no_automatic_action(self) -> None:
        fixture = self_heal.load_json(self.fixtures)
        snapshot = self_heal.deep_merge(
            fixture["base_snapshot"],
            {"invariants": {"contract_code_hashes_match": False}},
        )

        plan = self_heal.evaluate(self.policy, snapshot)

        self.assertEqual(plan["decision"], "contained")
        self.assertEqual(plan["automatic_actions"], [])
        self.assertIn(
            "platform:freeze_value_movement",
            {action["action_id"] for action in plan["manual_actions"]},
        )

    def test_remote_plain_http_probe_is_rejected(self) -> None:
        with self.assertRaisesRegex(self_heal.ContractError, "require HTTPS"):
            self_heal.normalize_base_url("http://agent-bounties.example.com")

        self.assertEqual(
            self_heal.normalize_base_url("http://127.0.0.1:8080"),
            "http://127.0.0.1:8080",
        )

    def test_snapshot_rejects_negative_failure_count(self) -> None:
        fixture = self_heal.load_json(self.fixtures)
        snapshot = self_heal.deep_merge(
            fixture["base_snapshot"],
            {"components": {"api": {"consecutive_failures": -1}}},
        )

        with self.assertRaisesRegex(self_heal.ContractError, "non-negative integer"):
            self_heal.validate_snapshot(snapshot)

    def test_green_health_and_stale_or_unavailable_reader_require_manual_investigation(self):
        for status in (200, 503, 404):
            with self.subTest(status=status), hosted_monitor_fixture(False, status) as (url, requests):
                snapshot = self_heal.build_public_snapshot(
                    self.policy, url, url, 'a' * 40, 'a' * 40,
                )
            self.assertEqual(requests.count('/health'), 2)
            self.assertEqual(requests.count('/readiness/marketplace'), 1)
            self.assertEqual(snapshot['components']['api']['state'], 'healthy')
            self.assertEqual(snapshot['components']['mcp']['state'], 'healthy')
            self.assertFalse(snapshot['components']['indexer']['restartable'])
            self.assertTrue(all(value is None for value in snapshot['invariants'].values()))
            plan = self_heal.evaluate(self.policy, snapshot)
            self.assertEqual(plan['decision'], 'escalation_required')
            self.assertEqual(plan['automatic_actions'], [])
            self.assertEqual(
                {action['action_id'] for action in plan['manual_actions']},
                {'indexer:investigate_indexer_integrity'},
            )
            # Staleness must not weaken an independently reported integrity failure.
            snapshot['invariants']['canonical_event_integrity'] = False
            contained = self_heal.evaluate(self.policy, snapshot)
            self.assertEqual(contained['decision'], 'contained')
            self.assertEqual(contained['automatic_actions'], [])

    def test_ready_readers_do_not_hide_actual_release_skew(self):
        for revision in ('a' * 40, 'b' * 40):
            with hosted_monitor_fixture(revision=revision) as (url, _):
                snapshot = self_heal.build_public_snapshot(self.policy, url, url, 'a' * 40, 'a' * 40)
            plan = self_heal.evaluate(self.policy, snapshot)
            self.assertEqual(plan['automatic_actions'], [])
            self.assertEqual(plan['decision'], 'healthy' if revision == 'a' * 40 else 'contained')
            if revision != 'a' * 40:
                self.assertIn('release:block_rollout', {a['action_id'] for a in plan['manual_actions']})

    def test_impossible_cursor_requires_investigation_without_restart(self):
        with hosted_monitor_fixture(ahead_cursor=2000) as (url, _):
            snapshot = self_heal.build_public_snapshot(self.policy, url, url, 'a' * 40, 'a' * 40)
        plan = self_heal.evaluate(self.policy, snapshot)
        self.assertEqual(plan['decision'], 'escalation_required')
        self.assertEqual(plan['automatic_actions'], [])
        self.assertEqual({a['action_id'] for a in plan['manual_actions']}, {'indexer:investigate_indexer_integrity'})

    def test_readiness_activation_waits_for_deployed_revision_confirmation(self):
        with hosted_monitor_fixture(readiness_status=404) as (url, requests):
            snapshot = self_heal.build_public_snapshot(self.policy, url, url, 'a' * 40)
        self.assertNotIn('/readiness/marketplace', requests)
        self.assertNotIn('indexer', snapshot['components'])
        self.assertFalse(snapshot['probe_evidence']['marketplace_readiness_enabled'])
        self.assertIn('NOT monitored', snapshot['coverage_note'])
        with self.assertRaises(self_heal.ContractError):
            self_heal.build_public_snapshot(self.policy, 'https://example.invalid',
                                            'https://example.invalid', 'a' * 40, 'b' * 40)


if __name__ == "__main__":
    unittest.main()
