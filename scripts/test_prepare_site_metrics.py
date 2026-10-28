import copy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import prepare_site_metrics as metrics

POLICY = metrics.ROOT / 'crates/api/fixtures/public-metrics-policy.json'


def aggregate():
    value = metrics.audit.build_public_participation_metrics(
        {'fetched_at': '2026-08-12T20:22:19Z'}, 'NSPG13')
    value['coverage']['policy_sha256'] = metrics.policy_digest(POLICY)
    return value


class Tests(unittest.TestCase):
    def test_two_build_preparations_make_no_activity_reads_and_preserve_exact_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'aggregate.json'
            raw = (json.dumps(aggregate(), indent=2) + '\n').encode()
            path.write_bytes(raw)
            with patch.object(metrics.audit, 'collect_snapshot', side_effect=AssertionError('network collection forbidden')):
                first = metrics.prepare(path, POLICY)
                second = metrics.prepare(path, POLICY)
            self.assertEqual(first, second)
            self.assertEqual(path.read_bytes(), raw)
            self.assertEqual(first['participation_generated_at'], '2026-08-12T20:22:19Z')
            self.assertEqual(first['participation_sha256'], hashlib.sha256(raw).hexdigest())
            self.assertEqual(first['participation_metrics'], 'reused_reviewed_aggregate')

    def test_missing_input_is_numeric_free_unavailable_without_a_fake_observation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'aggregate.json'
            result = metrics.prepare(path, POLICY)
            value = json.loads(path.read_text())
            self.assertEqual(value, metrics.unavailable())
            self.assertEqual(result['participation_metrics'], 'unavailable')
            self.assertIsNone(value['generated_at'])
            self.assertEqual(value['periods'], {})
            self.assertNotIn('weekly', value)
            self.assertNotIn('first_month', value)

    def test_corrupt_private_and_wrong_policy_artifacts_fail_instead_of_falling_back(self):
        original = aggregate()
        variants = []
        for key, value in [('login', 'private-person'), ('schema_version', 'wrong'), ('generated_at', '2099-01-01T00:00:00Z')]:
            item = copy.deepcopy(original); item[key] = value; variants.append(item)
        item = copy.deepcopy(original); item['coverage']['policy_sha256'] = '0' * 64; variants.append(item)
        item = copy.deepcopy(original); item['periods']['7d']['daily'][0]['comment_text'] = 'private'; variants.append(item)
        item = copy.deepcopy(original); item['definitions']['active_identity'] = 'private-comment'; variants.append(item)
        item = copy.deepcopy(original); item['periods']['7d']['active_identities'] = True; variants.append(item)
        item = copy.deepcopy(original); item['periods']['7d']['ended_at'] = '2026-08-13T20:22:19Z'; variants.append(item)
        item = copy.deepcopy(original); item['coverage']['status'] = 'partial'; variants.append(item)
        item = copy.deepcopy(original); item['first_month']['started_at'] = '2099-01-01T00:00:00Z'; variants.append(item)
        item = copy.deepcopy(original); item['first_month']['daily'][0]['day'] = '2099-01-01'; variants.append(item)
        item = copy.deepcopy(original); item['weekly']['latest_active_identities'] = 999999; variants.append(item)
        for item in variants:
            with self.subTest(item=item):
                with self.assertRaises(ValueError): metrics.validate(item, POLICY)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'aggregate.json'; path.write_text('{malformed')
            with self.assertRaises(ValueError): metrics.prepare(path, POLICY)
            self.assertEqual(path.read_text(), '{malformed')

    def test_invalid_policy_fails_even_when_metrics_are_unavailable(self):
        with tempfile.TemporaryDirectory() as directory:
            policy = Path(directory) / 'policy.json'
            for bad in ({}, {'schema_version': metrics.POLICY_SCHEMA, 'maintainer_github_logins': 'NSPG13'}):
                policy.write_text(json.dumps(bad))
                with self.assertRaises(ValueError): metrics.validate(metrics.unavailable(), policy)

    def test_future_data_and_duplicate_keys_are_rejected(self):
        with self.assertRaises(ValueError):
            metrics.validate(aggregate(), POLICY, now=datetime(2026, 8, 1, tzinfo=timezone.utc))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'aggregate.json'
            raw = json.dumps(aggregate()).replace('"namespace": "github"', '"namespace": "private-user", "namespace": "github"')
            path.write_text(raw)
            with self.assertRaises(ValueError): metrics.prepare(path, POLICY)

    def test_legacy_pages_is_manual_validation_only_without_collection(self):
        import yaml
        source = (metrics.ROOT / '.github/workflows/pages.yml').read_text()
        workflow = yaml.load(source, Loader=yaml.BaseLoader)
        self.assertEqual(set(workflow['on']), {'workflow_dispatch'})
        self.assertEqual(workflow['jobs']['deploy']['if'], '${{ false }}')
        deploy = workflow['jobs']['deploy']['steps']
        self.assertTrue(any('prepare_site_metrics.py' in step.get('run', '') for step in deploy))
        self.assertFalse(any('github_audience_audit.py' in step.get('run', '') for step in deploy))
        self.assertNotIn('GH_TOKEN', source)
        self.assertIn('check-site.py --require-wallet-bundle', source)

    def test_actual_build_uses_only_offline_preparation_and_keeps_required_gates(self):
        build = (metrics.ROOT / 'scripts/build-static-site.sh').read_text()
        self.assertIn('python3 scripts/prepare_site_metrics.py', build)
        self.assertNotIn('python3 scripts/refresh_site_metrics.py', build)
        self.assertNotIn('github_audience_audit.py --', build)
        self.assertNotIn('|| true', build)
        for gate in ['test_refresh_site_metrics.py', 'test_github_audience_audit.py',
                     'check-site.py --require-wallet-bundle', '--verify-origin https://agentizable.ai',
                     'npm run check --prefix tools/coinbase-embedded-wallet']:
            self.assertIn(gate, build)
        self.assertNotIn('refreshed from public GitHub activity during this build', build)


if __name__ == '__main__': unittest.main()
