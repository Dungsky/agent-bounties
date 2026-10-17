#!/usr/bin/env python3
"""Bounded read-only marketplace probe. Never authorizes a restart or a payment."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import urllib.error
import urllib.request

PROTOCOLS = {
    'agent-bounties/autonomous-v1',
    'agent-bounties/open-competition-v1',
    'agent-bounties/open-competition-v2-beta3',
}


def enabled_for_release(expected_revision, verified_revision):
    """Activate only after an operator records the verified endpoint release."""
    if not verified_revision:
        return False
    if (not isinstance(expected_revision, str)
            or not isinstance(verified_revision, str)
            or not re.fullmatch(r'[0-9a-fA-F]{40}', expected_revision)
            or not re.fullmatch(r'[0-9a-fA-F]{40}', verified_revision)
            or expected_revision.lower() != verified_revision.lower()):
        raise ValueError('marketplace readiness verified revision must match the exact expected release')
    return True


def inspect(payload, now=None):
    now = now or datetime.now(timezone.utc)
    failure = {'state': 'unavailable', 'restartable': False,
               'blocker': 'marketplace_readiness_invalid', 'readers': []}
    if not isinstance(payload, dict) or payload.get('schema') != 'agent-bounties/marketplace-readiness-v1':
        return failure
    try:
        checked = datetime.fromisoformat(payload['checked_at'].replace('Z', '+00:00'))
        if not 0 <= (now - checked).total_seconds() <= 90:
            return failure
        readers = payload['readers']
        if not isinstance(readers, list) or len(readers) != len(PROTOCOLS):
            return failure
        if {r['protocol'] for r in readers} != PROTOCOLS:
            return failure
        safe, latest = payload['safe_block'], payload['latest_block']
        if type(safe) is not int or type(latest) is not int or not 0 <= safe <= latest:
            return failure
        checks = []
        for r in readers:
            age, cursor, lag = (r.get(k) for k in ('heartbeat_age_seconds', 'cursor_block', 'lag_blocks'))
            healthy = (r.get('ready') is True and r.get('blocker') is None
                       and type(age) is int and 0 <= age <= 90
                       and type(cursor) is int and 0 <= cursor <= latest
                       and type(lag) is int and 0 <= lag <= 20
                       and lag == max(0, safe - cursor))
            checks.append({'protocol': r['protocol'], 'ready': healthy,
                           'heartbeat_age_seconds': age, 'cursor_block': cursor, 'lag_blocks': lag})
        healthy = payload.get('ready') is True and all(r['ready'] for r in checks)
        return {'state': 'healthy' if healthy else 'stale', 'restartable': False,
                'blocker': None if healthy else 'marketplace_reader_not_ready', 'readers': checks}
    except (KeyError, TypeError, ValueError, AttributeError, OverflowError):
        return failure


def observe(base_url, timeout_seconds=15):
    request = urllib.request.Request(base_url.rstrip('/') + '/readiness/marketplace',
                                     headers={'User-Agent': 'AgentBounties-MarketplaceMonitor/1'})
    try:
        try:
            response = urllib.request.urlopen(request, timeout=timeout_seconds)
        except urllib.error.HTTPError as error:
            if error.code != 503:
                error.close()
                raise
            response = error
        with response:
            status = response.status
            raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError('oversized response')
        result = inspect(json.loads(raw))
        if status != 200 and result['state'] == 'healthy':
            raise ValueError('readiness HTTP status contradicts the body')
        return result
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return {'state': 'unavailable', 'restartable': False,
                'blocker': 'marketplace_probe_unavailable', 'readers': []}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--api-base-url', required=True)
    parser.add_argument('--expected-revision')
    parser.add_argument('--verified-revision')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args(argv)
    try:
        enabled = enabled_for_release(args.expected_revision, args.verified_revision)
    except ValueError as error:
        parser.error(str(error))
    result = observe(args.api_base_url) if enabled else {
        'state': 'unknown', 'restartable': False,
        'blocker': 'marketplace_readiness_not_activated', 'readers': [],
    }
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result, indent=2))
    return 0 if not enabled or result['state'] == 'healthy' else 1


if __name__ == '__main__':
    raise SystemExit(main())
