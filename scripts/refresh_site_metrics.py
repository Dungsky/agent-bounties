#!/usr/bin/env python3
"""Refresh public aggregates over read-only HTTPS, without gh or Actions.

Only the aggregate is written. Raw GitHub records and the read-only token stay
in memory. A failed collection never replaces the last successful snapshot.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys
import threading
import tempfile
import time
from contextlib import contextmanager
import urllib.error
import urllib.request

import github_audience_audit as audit
from prepare_site_metrics import policy_digest, validate

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "https://api.github.com/repos/NSPG13/agent-bounties/"
# GitHub's Link header uses this repository's stable numeric ID for pagination.
PAGINATION_PREFIX = "https://api.github.com/repositories/1293030696/"
REPOSITORY = "NSPG13/agent-bounties"
GRAPHQL_URL = "https://api.github.com/graphql"
REVIEW_BATCH_SIZE = 20
MAX_REVIEW_PAGES = 100
QUOTA_FLOOR = 500
# Fixed query only: identifiers/cursors are data, never interpolated GraphQL.
REVIEWS_QUERY = """query PublicMetricReviews($ids: [ID!]!, $after: String) {
  nodes(ids: $ids) {
    __typename
    ... on PullRequest {
      id number repository { nameWithOwner }
      reviews(first: 100, after: $after) {
        totalCount
        nodes { id fullDatabaseId submittedAt author { __typename login } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}"""


class CollectionUnavailable(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__("GitHub metrics unavailable: " + code)


class RequestBudget:
    """One admission budget for every REST/GraphQL request in a collection.

    Callers sharing a bounded operational cycle can pass the same budget to
    multiple readers. There are no retries, fallback scans or background work.
    """
    def __init__(self, max_requests=1200, max_seconds=210, *, clock=time.monotonic):
        if type(max_requests) is not int or not 1 <= max_requests <= 1200:
            raise ValueError("Invalid metrics request budget")
        if not isinstance(max_seconds, (int, float)) or isinstance(max_seconds, bool) or not 0 < max_seconds <= 210:
            raise ValueError("Invalid metrics time budget")
        self.max_requests = max_requests
        self.max_seconds = max_seconds
        self.clock = clock
        self.started = clock()
        self.requests_started = 0
        self.quota_remaining = {}
        self.unavailable_code = None
        self.lock = threading.Lock()

    def check_time(self):
        remaining = self.max_seconds - (self.clock() - self.started)
        if remaining <= 0:
            raise CollectionUnavailable("time_budget_exhausted")
        return remaining

    def observe_quota(self, resource, value):
        if value is None:
            return
        valid = isinstance(value, str) and re.fullmatch(r"[0-9]{1,10}", value.strip(" \t"))
        with self.lock:
            if not valid:
                self.unavailable_code = "malformed_quota"
                raise CollectionUnavailable(self.unavailable_code)
            remaining = int(value)
            self.quota_remaining[resource] = min(remaining, self.quota_remaining.get(resource, remaining))
            if remaining < QUOTA_FLOOR:
                self.unavailable_code = "quota_floor_reached"
                raise CollectionUnavailable(self.unavailable_code)

    def reserve(self, resource="core"):
        with self.lock:
            if self.unavailable_code:
                raise CollectionUnavailable(self.unavailable_code)
            if self.quota_remaining.get(resource, QUOTA_FLOOR + 1) <= QUOTA_FLOOR:
                self.unavailable_code = "quota_floor_reached"
                raise CollectionUnavailable(self.unavailable_code)
            remaining = self.check_time()
            if self.requests_started >= self.max_requests:
                raise CollectionUnavailable("request_budget_exhausted")
            self.requests_started += 1
            if resource in self.quota_remaining:
                # Reserve the minimum one unit before concurrent callers can
                # consume the same last allowance; response headers reconcile
                # any higher GraphQL cost conservatively.
                self.quota_remaining[resource] -= 1
            return min(30, remaining)


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("GitHub metrics redirects are not permitted")


class Reader:
    def __init__(self, token, opener=None, *, budget=None):
        self.token = token
        self.opener = opener or urllib.request.build_opener(NoRedirects())
        self.budget = budget if budget is not None else RequestBudget()

    def _request(self, url, *, accept=None, payload=None):
        request = urllib.request.Request(url, headers={
            "Accept": accept or "application/vnd.github+json",
            "Authorization": "Bearer " + self.token,
            "Content-Type": "application/json",
            "User-Agent": "Agentizable-PublicMetrics/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
        }, data=None if payload is None else json.dumps(payload).encode())
        resource = "graphql" if url == GRAPHQL_URL else "core"
        timeout = self.budget.reserve(resource)
        try:
            response = self.opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            error.close()
            if error.code in (401, 403):
                raise CollectionUnavailable("access_unavailable") from None
            if error.code == 429:
                raise CollectionUnavailable("rate_limited") from None
            raise CollectionUnavailable("http_unavailable") from None
        with response:
            if response.status != 200:
                raise CollectionUnavailable("http_unavailable")
            self.budget.observe_quota(resource, response.headers.get("X-RateLimit-Remaining"))
            data = response.read(16 * 1024 * 1024 + 1)
            if len(data) > 16 * 1024 * 1024:
                raise ValueError("GitHub metrics page exceeds limit")
            self.budget.check_time()
            return json.loads(data), response.headers.get("Link", "")

    def page(self, url, accept=None):
        if not url.startswith((PREFIX, PAGINATION_PREFIX)) or any(c in url for c in ("\r", "\n", "#", "\\")):
            raise ValueError("Unexpected GitHub metrics URL")
        return self._request(url, accept=accept)

    def _review_pages(self, expected, after=None):
        data, _ = self._request(GRAPHQL_URL, payload={
            "query": REVIEWS_QUERY, "variables": {"ids": list(expected), "after": after},
        })
        if not isinstance(data, dict):
            raise CollectionUnavailable("graphql_unavailable")
        if "errors" in data and (not isinstance(data["errors"], list) or data["errors"]):
            raise CollectionUnavailable("graphql_unavailable")
        envelope = data.get("data")
        nodes = envelope.get("nodes") if isinstance(envelope, dict) else None
        if not isinstance(nodes, list) or len(nodes) != len(expected):
            raise CollectionUnavailable("incomplete_review_nodes")
        result = {}
        for node in nodes:
            if not isinstance(node, dict):
                raise CollectionUnavailable("incomplete_review_nodes")
            node_id = node.get("id")
            repository = node.get("repository")
            if (not isinstance(node_id, str) or node_id not in expected or node_id in result
                or node.get("__typename") != "PullRequest"
                or type(node.get("number")) is not int or node["number"] != expected[node_id]
                or not isinstance(repository, dict) or repository.get("nameWithOwner") != REPOSITORY):
                raise CollectionUnavailable("review_identity_mismatch")
            connection = node.get("reviews")
            if not isinstance(connection, dict):
                raise CollectionUnavailable("incomplete_review_connection")
            result[node_id] = connection
        return result

    def reviews(self, repository, pulls):
        if repository != REPOSITORY:
            raise ValueError("Unexpected metrics repository")
        expected, numbers = {}, set()
        for pull in pulls:
            number, node_id = pull.get("number"), pull.get("node_id")
            if (type(number) is not int or number <= 0 or number in numbers
                or not _opaque_id(node_id) or node_id in expected):
                raise CollectionUnavailable("invalid_pull_identity")
            expected[node_id] = number
            numbers.add(number)
        result, seen_reviews = [], set()
        ids = list(expected)
        for offset in range(0, len(ids), REVIEW_BATCH_SIZE):
            batch = {node_id: expected[node_id] for node_id in ids[offset:offset + REVIEW_BATCH_SIZE]}
            first_pages = self._review_pages(batch)
            for node_id, number in batch.items():
                page, cursor, total, count, cursors = first_pages[node_id], None, None, 0, set()
                for page_index in range(MAX_REVIEW_PAGES):
                    rows, next_cursor, observed_total = _review_connection(page)
                    if total is not None and observed_total != total:
                        raise CollectionUnavailable("review_count_changed")
                    total = observed_total
                    for row in rows:
                        normalized, identity = _review_record(row, number)
                        if any(part in seen_reviews for part in identity):
                            raise CollectionUnavailable("duplicate_review")
                        seen_reviews.update(identity)
                        result.append(normalized)
                    count += len(rows)
                    if count > total:
                        raise CollectionUnavailable("review_count_mismatch")
                    if next_cursor is None:
                        if count != total:
                            raise CollectionUnavailable("incomplete_review_count")
                        break
                    if not rows or next_cursor in cursors or next_cursor == cursor or count >= total:
                        raise CollectionUnavailable("invalid_review_pagination")
                    if page_index + 1 >= MAX_REVIEW_PAGES:
                        raise CollectionUnavailable("review_page_limit")
                    cursors.add(next_cursor)
                    cursor = next_cursor
                    page = self._review_pages({node_id: number}, after=cursor)[node_id]
                else:
                    raise CollectionUnavailable("review_page_limit")
        return result

    def records(self, repository, suffix, *, accept=None):
        if repository != "NSPG13/agent-bounties":
            raise ValueError("Unexpected metrics repository")
        url = PREFIX + suffix.lstrip("/")
        records, visited = [], set()
        while url:
            if url in visited or len(visited) >= 1000:
                raise ValueError("GitHub metrics pagination did not terminate")
            visited.add(url)
            page, links = self.page(url, accept)
            if not isinstance(page, list) or any(not isinstance(row, dict) for row in page):
                raise ValueError("Malformed GitHub metrics page")
            records.extend(page)
            match = re.search(r'<([^>]+)>;\s*rel="next"', links)
            url = match.group(1) if match else None
        return records

    def traffic(self, repository):
        # This credential deliberately has no repository-administration access.
        # Private clone/visitor analytics remain explicitly unavailable.
        return {"status": "unavailable"}


def _opaque_id(value):
    return isinstance(value, str) and 0 < len(value) <= 512 and value.isascii() and not any(c.isspace() or ord(c) < 32 for c in value)


def _review_connection(connection):
    total, rows, info = connection.get("totalCount"), connection.get("nodes"), connection.get("pageInfo")
    if (type(total) is not int or not 0 <= total <= MAX_REVIEW_PAGES * 100
        or not isinstance(rows, list) or len(rows) > 100 or not isinstance(info, dict)
        or type(info.get("hasNextPage")) is not bool or "endCursor" not in info):
        raise CollectionUnavailable("malformed_review_connection")
    cursor = info.get("endCursor")
    if rows and not _opaque_id(cursor):
        raise CollectionUnavailable("invalid_review_cursor")
    if not rows and (cursor is not None or info["hasNextPage"]):
        raise CollectionUnavailable("invalid_review_cursor")
    return rows, cursor if info["hasNextPage"] else None, total


def _review_record(row, pull_number):
    if not isinstance(row, dict) or not _opaque_id(row.get("id")):
        raise CollectionUnavailable("malformed_review")
    raw_id = row.get("fullDatabaseId")
    if not (type(raw_id) is int or isinstance(raw_id, str) and re.fullmatch(r"[1-9][0-9]{0,18}", raw_id)):
        raise CollectionUnavailable("invalid_review_id")
    review_id = int(raw_id)
    if not 0 < review_id <= 2**63 - 1:
        raise CollectionUnavailable("invalid_review_id")
    if "submittedAt" not in row or "author" not in row:
        raise CollectionUnavailable("incomplete_review")
    submitted = row["submittedAt"]
    if submitted is not None and (not isinstance(submitted, str) or audit.parse_utc_timestamp(submitted) is None):
        raise CollectionUnavailable("invalid_review_timestamp")
    author = row["author"]
    user = None
    if author is not None:
        if (not isinstance(author, dict) or not isinstance(author.get("login"), str)
            or not author["login"].strip() or not isinstance(author.get("__typename"), str)
            or not author["__typename"]):
            raise CollectionUnavailable("malformed_review_author")
        user = {"login": author["login"], "type": author["__typename"]}
    return {"id": review_id, "user": user, "submitted_at": submitted,
            "pull_number": pull_number}, (review_id, row["id"])


@contextmanager
def collection_lock(destination):
    # Only the explicit collector uses this lock; website builds are offline.
    import fcntl
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def refresh(destination, token, *, budget=None):
    with collection_lock(destination):
        _refresh_locked(destination, token, budget=budget)


def _refresh_locked(destination, token, *, budget=None):
    reader = Reader(token, budget=budget)
    snapshot = audit.collect_snapshot(REPOSITORY, include_enrichment=False,
        activity_since=audit.PLATFORM_LAUNCH_AT, include_repository_traffic=False,
        api_reader=reader.records, pull_reviews_reader=reader.reviews)
    policy = audit.public_metrics_policy(ROOT / "crates/api/fixtures/public-metrics-policy.json")
    result = audit.build_public_participation_metrics(snapshot, "NSPG13",
        excluded_logins=set(policy["maintainer_github_logins"]))
    if result["coverage"]["status"] != "ready":
        raise ValueError("GitHub metrics collection is incomplete")
    policy_path = ROOT / "crates/api/fixtures/public-metrics-policy.json"
    result["coverage"]["policy_sha256"] = policy_digest(policy_path)
    validate(result, policy_path)
    reader.budget.check_time()
    destination.parent.mkdir(parents=True, exist_ok=True)
    pending = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=destination.parent,
                                         prefix='.metrics-', delete=False) as output:
            pending = Path(output.name)
            output.write(json.dumps(result, indent=2) + "\n")
            output.flush()
            os.fsync(output.fileno())
        pending.replace(destination)
    finally:
        if pending is not None:
            pending.unlink(missing_ok=True)
    print("public_metrics_refreshed=" + result["generated_at"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path,
                        default=ROOT / 'site/generated/github-participation.json',
                        help='Trusted local aggregate candidate; never raw records')
    args = parser.parse_args()
    token = os.environ.get("GITHUB_METRICS_TOKEN", "")
    if not token:
        raise ValueError("GITHUB_METRICS_TOKEN is not configured")
    refresh(args.output, token)


if __name__ == "__main__":
    try:
        main()
    except CollectionUnavailable as error:
        # Internal reason codes only; never remote messages or credentials.
        print("Public metrics refresh failed (" + error.code + "); previous snapshot retained.", file=sys.stderr)
        raise SystemExit(1)
    except Exception:
        # Do not print exception bodies, HTTP responses, raw records or headers.
        print("Public metrics refresh failed; previous snapshot retained.", file=sys.stderr)
        raise SystemExit(1)
