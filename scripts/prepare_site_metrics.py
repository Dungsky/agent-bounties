#!/usr/bin/env python3
"""Validate a reviewed local aggregate for a build; never collect GitHub activity.

The tracked site/generated artifact is the durable release input. A daily
collector can prepare a replacement for review; compilation never fetches it.
"""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
from datetime import datetime, timezone

import github_audience_audit as audit

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = 'agent-bounties/github-participation-v1'
POLICY_SCHEMA = 'agent-bounties/public-metrics-policy-v1'
MAX_BYTES = 2 * 1024 * 1024


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate aggregate or policy field')
        result[key] = value
    return result


def policy_digest(path):
    policy = json.loads(path.read_text(), object_pairs_hook=_pairs)
    if policy.get('schema_version') != POLICY_SCHEMA:
        raise ValueError('Unsupported public metrics policy')
    logins = policy.get('maintainer_github_logins')
    if not isinstance(logins, list) or not logins or any(not isinstance(x, str) or not x.strip() for x in logins):
        raise ValueError('Malformed public maintainer exclusion policy')
    return hashlib.sha256(json.dumps(policy, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def unavailable():
    # No observation occurred: do not turn build time into a collection time.
    return {'schema_version': SCHEMA, 'source': 'github_public_activity',
            'generated_at': None, 'namespace': 'github', 'periods': {},
            'coverage': {'status': 'unavailable', 'reason': 'no_reviewed_aggregate',
                         'raw_identifiers_included': False}}


def _timestamp(value):
    if not isinstance(value, str) or not value.endswith('Z'):
        raise ValueError('Expected UTC observation timestamp')
    result = audit.parse_utc_timestamp(value)
    if result is None:
        raise ValueError('Invalid observation timestamp')
    return result


def _shape(value, reference, key=''):
    """Closed aggregate schema: no arbitrary keys, identifiers or free text."""
    if isinstance(reference, dict):
        if not isinstance(value, dict) or set(value) != set(reference):
            raise ValueError('Unexpected aggregate fields')
        for name, expected in reference.items():
            _shape(value[name], expected, name)
    elif isinstance(reference, list):
        if not isinstance(value, list) or len(value) > 10_000:
            raise ValueError('Invalid aggregate list')
        if key == 'roles':
            if len(value) != len(reference):
                raise ValueError('Missing aggregate roles')
            for item, expected in zip(value, reference):
                _shape(item, expected)
        elif key == 'daily':
            for item in value:
                _shape(item, {'day': '2000-01-01', 'active_identities': 0, 'qualifying_actions': 0})
            days = [item['day'] for item in value]
            if days != sorted(set(days)):
                raise ValueError('Duplicate or unordered aggregate days')
        elif value != reference:
            raise ValueError('Unreviewed historical aggregate')
    elif isinstance(reference, bool):
        if value is not reference:
            raise ValueError('Invalid aggregate boolean')
    elif isinstance(reference, int):
        if type(value) is not int or not 0 <= value <= 2**53 - 1:
            raise ValueError('Invalid aggregate count')
    elif key.endswith('_at'):
        _timestamp(value)
    elif key == 'day':
        if not isinstance(value, str) or len(value) != 10:
            raise ValueError('Invalid aggregate day')
        datetime.strptime(value, '%Y-%m-%d')
    elif value != reference:
        raise ValueError('Unreviewed aggregate text or metadata')


def validate(value, policy_path, now=None):
    digest = policy_digest(policy_path)  # Invalid policy always stops the build.
    if value == unavailable():
        return 'unavailable'
    if not isinstance(value, dict):
        raise ValueError('Expected an aggregate object')
    observed = _timestamp(value.get('generated_at'))
    if observed > (now or datetime.now(timezone.utc)):
        raise ValueError('Aggregate observation is in the future')
    reference = audit.build_public_participation_metrics(
        {'fetched_at': value['generated_at']}, 'NSPG13')
    reference['coverage']['policy_sha256'] = digest
    _shape(value, reference)
    if value['coverage']['missing_timestamp_records'] != 0:
        raise ValueError('Incomplete aggregate cannot be a last-success artifact')
    # Enforce windows against the exact observed time; a fresh build cannot
    # re-label old rolling data as current or invent a different baseline.
    for period, window in value['periods'].items():
        for name in ('started_at', 'ended_at', 'previous_started_at', 'previous_ended_at'):
            if window[name] != reference['periods'][period][name]:
                raise ValueError('Aggregate observation window mismatch')
        for row in window['daily']:
            if not window['started_at'][:10] <= row['day'] <= window['ended_at'][:10]:
                raise ValueError('Daily point outside observation window')
    first_month = value['first_month']
    for name in ('started_at', 'ended_at'):
        if first_month[name] != reference['first_month'][name]:
            raise ValueError('First-month observation window mismatch')
    if any(not first_month['started_at'][:10] <= row['day'] <= first_month['ended_at'][:10]
           for row in first_month['daily']):
        raise ValueError('First-month daily point outside observation window')
    if (value['weekly']['latest_active_identities'] != value['periods']['7d']['active_identities']
            or value['weekly']['previous_active_identities'] != value['periods']['7d']['previous_active_identities']):
        raise ValueError('Weekly summary disagrees with its observation window')
    for name in ('launch_at', 'first_month_started_at', 'first_month_ended_at'):
        if value[name] != reference[name]:
            raise ValueError('Unreviewed aggregate baseline')
    return 'reused_reviewed_aggregate'


def prepare(path, policy_path):
    if path.exists():
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_BYTES:
            raise ValueError('Invalid local aggregate input')
        raw = path.read_bytes()
        value = json.loads(raw, object_pairs_hook=_pairs)
    else:
        value = unavailable()
        raw = (json.dumps(value, indent=2) + '\n').encode()
    status = validate(value, policy_path)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    return {'participation_metrics': status,
            'participation_generated_at': value['generated_at'],
            'participation_sha256': hashlib.sha256(raw).hexdigest()}


def main():
    print(json.dumps(prepare(ROOT / 'site/generated/github-participation.json',
                            ROOT / 'crates/api/fixtures/public-metrics-policy.json')))


if __name__ == '__main__':
    main()
