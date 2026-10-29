"""Offline regressions for the bounded full-history review transport."""
import json
import io
import os
import runpy
import tempfile
import unittest
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import github_audience_audit as audit
import refresh_site_metrics as metrics
from test_refresh_site_metrics import Response


def pull(number=1):
    return {"number": number, "node_id": f"PR_{number}",
            "updated_at": "2026-08-10T00:00:00Z"}


def review(identity=1, login="alice", kind="User"):
    return {"id": f"PRR_{identity}", "fullDatabaseId": str(identity),
            "submittedAt": "2026-08-10T00:00:00Z",
            "author": None if login is None else {"login": login, "__typename": kind}}


def node(number=1, rows=None, *, total=None, more=False, cursor=None):
    rows = [review()] if rows is None else rows
    return {"id": f"PR_{number}", "__typename": "PullRequest", "number": number,
            "repository": {"nameWithOwner": metrics.REPOSITORY},
            "reviews": {"totalCount": len(rows) if total is None else total,
                        "nodes": rows,
                        "pageInfo": {"hasNextPage": more,
                                     "endCursor": cursor if cursor is not None else ("end" if rows else None)}}}


def envelope(*nodes):
    return {"data": {"nodes": list(nodes)}}


class Opener:
    def __init__(self, answer):
        self.answer = answer
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        return self.answer(request)


class ReviewBatches(unittest.TestCase):
    def test_41_pulls_use_three_fixed_read_only_queries(self):
        def respond(request):
            self.assertEqual(request.full_url, metrics.GRAPHQL_URL)
            self.assertEqual(request.get_method(), "POST")
            self.assertEqual(request.get_header("Authorization"), "Bearer fixture-token")
            payload = json.loads(request.data)
            self.assertEqual(payload["query"], metrics.REVIEWS_QUERY)
            self.assertNotIn("mutation", payload["query"].lower())
            self.assertIsNone(payload["variables"]["after"])
            self.assertLessEqual(len(payload["variables"]["ids"]), 20)
            return Response(envelope(*(node(int(item[3:]), []) for item in payload["variables"]["ids"])))
        opener = Opener(respond)
        self.assertEqual(metrics.Reader("fixture-token", opener).reviews(metrics.REPOSITORY, [pull(n) for n in range(1, 42)]), [])
        self.assertEqual(len(opener.requests), 3)

    def test_graphql_and_rest_produce_identical_public_metrics(self):
        rows = [review(1), review(2, "worker[bot]"), review(3, "automation", "Bot"),
                review(4, None), review(5, "NSPG13"), review(6, "helper"),
                review(7, "alice"), review(8, "migrated", "Mannequin")]
        # Extra remote content is not copied into normalized metrics inputs.
        rows[0]["body"] = "private fixture review body"
        opener = Opener(lambda _: Response(envelope(node(rows=rows))))
        actual = metrics.Reader("fixture-token", opener).reviews(metrics.REPOSITORY, [pull()])
        expected = [{"id": int(row["fullDatabaseId"]), "submitted_at": row["submittedAt"],
                     "user": None if row["author"] is None else {"login": row["author"]["login"], "type": row["author"]["__typename"]},
                     "pull_number": 1} for row in rows]
        self.assertEqual(actual, expected)
        before = audit.build_public_participation_metrics({"fetched_at": "2026-08-12T20:22:19Z", "reviews": expected}, "NSPG13", excluded_logins={"helper"})
        after = audit.build_public_participation_metrics({"fetched_at": "2026-08-12T20:22:19Z", "reviews": actual}, "NSPG13", excluded_logins={"helper"})
        self.assertEqual(after, before)
        self.assertEqual(after["periods"]["lifetime"]["qualifying_actions"], 3)
        self.assertEqual(after["coverage"]["excluded_records"], 5)
        self.assertNotIn("private fixture", json.dumps(actual))
        self.assertNotIn("alice", json.dumps(after))

    def test_overflow_follows_exact_cursor_and_keeps_all_reviews(self):
        replies = iter([envelope(node(rows=[review(i) for i in range(1, 101)], total=105, more=True, cursor="next-100")),
                        envelope(node(rows=[review(i) for i in range(101, 106)], total=105))])
        opener = Opener(lambda _: Response(next(replies)))
        rows = metrics.Reader("fixture-token", opener).reviews(metrics.REPOSITORY, [pull()])
        self.assertEqual([row["id"] for row in rows], list(range(1, 106)))
        self.assertEqual(json.loads(opener.requests[1][0].data)["variables"], {"ids": ["PR_1"], "after": "next-100"})

    def test_missing_mismatched_partial_or_malformed_data_never_means_zero(self):
        cases = [
            {"errors": [{"message": "fixture secret"}], **envelope(node())},
            {"data": None}, {"errors": {}, **envelope(node())}, envelope(), envelope(None), envelope({}),
        ]
        for field, value in [("id", "PR_999"), ("number", True), ("number", 2),
                             ("__typename", "Issue"), ("repository", {"nameWithOwner": "other/private"}),
                             ("reviews", None)]:
            changed = node(); changed[field] = value; cases.append(envelope(changed))
        for field, value in [("totalCount", "1"), ("totalCount", -1), ("totalCount", 2),
                             ("totalCount", 0), ("nodes", [None]), ("pageInfo", {}),
                             ("pageInfo", {"hasNextPage": "false", "endCursor": "end"}),
                             ("pageInfo", {"hasNextPage": False, "endCursor": None})]:
            changed = node(); changed["reviews"][field] = value; cases.append(envelope(changed))
        cases.append(envelope(node(rows=[], more=True)))
        for response in cases:
            with self.subTest(response=response):
                opener = Opener(lambda _: Response(response))
                with self.assertRaises(metrics.CollectionUnavailable):
                    metrics.Reader("fixture-token", opener).reviews(metrics.REPOSITORY, [pull()])
                self.assertEqual(len(opener.requests), 1)

    def test_duplicate_nodes_and_incomplete_batch_are_rejected(self):
        for response in [envelope(node()), envelope(node(), node())]:
            with self.subTest(response=response):
                with self.assertRaises(metrics.CollectionUnavailable):
                    metrics.Reader("fixture-token", Opener(lambda _: Response(response))).reviews(metrics.REPOSITORY, [pull(1), pull(2)])

    def test_incomplete_id_timestamp_author_and_duplicate_reviews_are_rejected(self):
        cases = []
        for field, value in [("id", None), ("fullDatabaseId", None), ("fullDatabaseId", True),
                             ("fullDatabaseId", 0), ("fullDatabaseId", "1.2"),
                             ("fullDatabaseId", str(2**63)), ("submittedAt", "not a date"),
                             ("author", {}), ("author", {"login": "alice"})]:
            changed = review(); changed[field] = value; cases.append([changed])
        for field in ["submittedAt", "author"]:
            changed = review(); del changed[field]; cases.append([changed])
        cases.append([review(), review()])
        duplicate_node_id = review(2); duplicate_node_id["id"] = review()["id"]
        cases.append([review(), duplicate_node_id])
        for rows in cases:
            with self.subTest(rows=rows):
                with self.assertRaises(metrics.CollectionUnavailable):
                    metrics.Reader("fixture-token", Opener(lambda _: Response(envelope(node(rows=rows))))).reviews(metrics.REPOSITORY, [pull()])

    def test_cursor_cycle_changed_counts_and_duplicate_overflow_stop(self):
        first = envelope(node(rows=[review()], total=3, more=True, cursor="next"))
        seconds = [envelope(node(rows=[review(2)], total=3, more=True, cursor="next")),
                   envelope(node(rows=[review(2)], total=2)),
                   envelope(node(rows=[review()], total=3))]
        for second in seconds:
            replies = iter([first, second])
            opener = Opener(lambda _: Response(next(replies)))
            with self.assertRaises(metrics.CollectionUnavailable):
                metrics.Reader("fixture-token", opener).reviews(metrics.REPOSITORY, [pull()])
            self.assertEqual(len(opener.requests), 2)

    def test_invalid_pull_list_stops_before_any_wire_request(self):
        opener = Opener(lambda _: self.fail("invalid IDs must never leave process"))
        for pulls in [[{}], [pull(), pull()], [{**pull(), "number": True}],
                      [{**pull(), "node_id": "\nmutation"}], [{**pull(), "node_id": None}]]:
            with self.assertRaises(metrics.CollectionUnavailable):
                metrics.Reader("fixture-token", opener).reviews(metrics.REPOSITORY, pulls)
        self.assertEqual(opener.requests, [])

    def test_access_failure_is_explicit_and_has_no_fallback(self):
        def respond(request):
            raise urllib.error.HTTPError(request.full_url, 403, "fixture secret", {}, None)
        opener = Opener(respond)
        with self.assertRaises(metrics.CollectionUnavailable) as caught:
            metrics.Reader("fixture-token", opener).reviews(metrics.REPOSITORY, [pull()])
        self.assertEqual(caught.exception.code, "access_unavailable")
        self.assertNotIn("fixture secret", str(caught.exception))
        self.assertEqual(len(opener.requests), 1)


class CycleBudget(unittest.TestCase):
    def test_rest_and_graphql_share_budget_across_readers(self):
        budget = metrics.RequestBudget(max_requests=2)
        opener = Opener(lambda request: Response(envelope(node(rows=[]))) if request.full_url == metrics.GRAPHQL_URL else Response([]))
        one, two = metrics.Reader("token", opener, budget=budget), metrics.Reader("token", opener, budget=budget)
        one.page(metrics.PREFIX + "issues")
        two.reviews(metrics.REPOSITORY, [pull()])
        with self.assertRaises(metrics.CollectionUnavailable) as caught:
            one.page(metrics.PREFIX + "issues")
        self.assertEqual(caught.exception.code, "request_budget_exhausted")
        self.assertEqual((budget.requests_started, len(opener.requests)), (2, 2))

    def test_concurrent_admission_never_exceeds_cycle_budget(self):
        budget = metrics.RequestBudget(max_requests=3)
        opener = Opener(lambda _: Response([]))
        reader = metrics.Reader("token", opener, budget=budget)
        def attempt(_):
            try:
                reader.page(metrics.PREFIX + "issues")
                return True
            except metrics.CollectionUnavailable:
                return False
        with ThreadPoolExecutor(max_workers=8) as executor:
            passed = list(executor.map(attempt, range(40)))
        self.assertEqual(sum(passed), 3)
        self.assertEqual((len(opener.requests), budget.requests_started), (3, 3))

    def test_deadline_bounds_request_timeout_and_rejects_late_response(self):
        now = [0]
        budget = metrics.RequestBudget(max_seconds=2, clock=lambda: now[0])
        def respond(_):
            now[0] = 3
            return Response([])
        opener = Opener(respond)
        reader = metrics.Reader("token", opener, budget=budget)
        with self.assertRaises(metrics.CollectionUnavailable) as caught:
            reader.page(metrics.PREFIX + "issues")
        self.assertEqual(caught.exception.code, "time_budget_exhausted")
        self.assertEqual(opener.requests[0][1], 2)
        with self.assertRaises(metrics.CollectionUnavailable):
            reader.reviews(metrics.REPOSITORY, [pull()])
        self.assertEqual(len(opener.requests), 1)


class QuotaBoundaries(unittest.TestCase):
    def response(self, request, quota):
        response = Response(envelope(node(rows=[]))) if request.full_url == metrics.GRAPHQL_URL else Response([])
        response.headers["X-RateLimit-Remaining"] = quota
        return response

    def test_low_or_malformed_quota_blocks_both_transports_and_further_calls(self):
        for graphql in [False, True]:
            for value in ["499", "0", "bad", "-1", "500.0", "", "500\n", True]:
                with self.subTest(graphql=graphql, value=value):
                    opener = Opener(lambda request: self.response(request, value))
                    reader = metrics.Reader("token", opener)
                    with self.assertRaises(metrics.CollectionUnavailable) as caught:
                        if graphql:
                            reader.reviews(metrics.REPOSITORY, [pull()])
                        else:
                            reader.page(metrics.PREFIX + "issues")
                    self.assertEqual(caught.exception.code, "quota_floor_reached" if value in ["499", "0"] else "malformed_quota")
                    with self.assertRaises(metrics.CollectionUnavailable):
                        reader.page(metrics.PREFIX + "issues")
                    self.assertEqual(len(opener.requests), 1)

    def test_exact_floor_allows_complete_response_but_no_next_same_pool_request(self):
        for graphql in [False, True]:
            opener = Opener(lambda request: self.response(request, "500"))
            reader = metrics.Reader("token", opener)
            call = (lambda: reader.reviews(metrics.REPOSITORY, [pull()])) if graphql else (lambda: reader.page(metrics.PREFIX + "issues"))
            call()
            with self.assertRaises(metrics.CollectionUnavailable):
                call()
            self.assertEqual(len(opener.requests), 1)

    def test_known_last_quota_unit_is_not_reused_by_concurrent_requests(self):
        opener = Opener(lambda request: self.response(request, "501"))
        reader = metrics.Reader("token", opener)
        reader.page(metrics.PREFIX + "issues")
        def attempt(_):
            try:
                reader.page(metrics.PREFIX + "issues")
                return True
            except metrics.CollectionUnavailable:
                return False
        with ThreadPoolExecutor(max_workers=8) as executor:
            self.assertEqual(sum(executor.map(attempt, range(20))), 1)
        self.assertEqual(len(opener.requests), 2)

    def test_sufficient_quota_keeps_rest_and_graphql_pools_distinct(self):
        opener = Opener(lambda request: self.response(request, "501"))
        reader = metrics.Reader("token", opener)
        reader.page(metrics.PREFIX + "issues")
        reader.reviews(metrics.REPOSITORY, [pull()])
        self.assertEqual(reader.budget.quota_remaining, {"core": 501, "graphql": 501})
        self.assertEqual(len(opener.requests), 2)


class ActualCollection(unittest.TestCase):
    def opener(self, review_response):
        def respond(request):
            if request.full_url == metrics.GRAPHQL_URL:
                return Response(review_response)
            self.assertEqual(request.get_method(), "GET")
            suffix = request.full_url.removeprefix(metrics.PREFIX)
            if suffix == "pulls?state=all&per_page=100":
                return Response([pull()])
            self.assertIn(suffix, ["issues?state=all&per_page=100", "issues/comments?per_page=100", "pulls/comments?per_page=100"])
            return Response([])
        return Opener(respond)

    def test_real_flow_reflects_review_edits_and_deletions_without_raw_cache(self):
        original = audit.gh_api
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "aggregate.json"
            for rows, expected in [([review()], 1), ([review(login="automation", kind="Bot")], 0), ([], 0)]:
                opener = self.opener(envelope(node(rows=rows)))
                with patch.object(metrics.urllib.request, "build_opener", return_value=opener), \
                     patch.object(audit, "utc_now", return_value="2026-08-12T20:22:19Z"):
                    metrics.refresh(output, "fixture-token")
                value = json.loads(output.read_text())
                self.assertEqual(value["periods"]["lifetime"]["qualifying_actions"], expected)
                self.assertEqual(value["coverage"]["status"], "ready")
                self.assertEqual(len(opener.requests), 5)
                self.assertNotIn("alice", output.read_text())
                self.assertNotIn("fixture-token", output.read_text())
            self.assertEqual(sorted(p.name for p in Path(folder).iterdir()), ["aggregate.json", "aggregate.lock"])
        self.assertIs(audit.gh_api, original)

    def test_actual_partial_graphql_keeps_last_aggregate_and_never_falls_back(self):
        opener = self.opener({"data": {"nodes": [None]}, "errors": [{"message": "not available"}]})
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "aggregate.json"
            output.write_text("previous authentic aggregate")
            with patch.object(metrics.urllib.request, "build_opener", return_value=opener):
                with self.assertRaises(metrics.CollectionUnavailable):
                    metrics.refresh(output, "fixture-token")
            self.assertEqual(output.read_text(), "previous authentic aggregate")
            self.assertEqual(len(opener.requests), 5)
            self.assertEqual(sum(req.full_url == metrics.GRAPHQL_URL for req, _ in opener.requests), 1)

    def test_actual_whole_cycle_budget_preserves_output_before_reviews(self):
        opener = self.opener(envelope(node()))
        budget = metrics.RequestBudget(max_requests=4)
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "aggregate.json"
            output.write_text("previous")
            with patch.object(metrics.urllib.request, "build_opener", return_value=opener):
                with self.assertRaises(metrics.CollectionUnavailable):
                    metrics.refresh(output, "fixture-token", budget=budget)
            self.assertEqual(output.read_text(), "previous")
            self.assertEqual(len(opener.requests), 4)
            self.assertTrue(all(req.full_url != metrics.GRAPHQL_URL for req, _ in opener.requests))


    def test_cli_reports_access_failure_without_remote_details_or_credentials(self):
        def denied(request):
            raise urllib.error.HTTPError(request.full_url, 403, "private upstream detail", {}, None)
        opener, output = Opener(denied), io.StringIO()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "candidate.json"
            path.write_text("previous")
            with patch("sys.argv", [metrics.__file__, "--output", str(path)]), \
                 patch.dict(os.environ, {"GITHUB_METRICS_TOKEN": "fixture-token"}), \
                 patch.object(metrics.urllib.request, "build_opener", return_value=opener), \
                 patch("sys.stderr", output):
                with self.assertRaises(SystemExit) as caught:
                    runpy.run_path(metrics.__file__, run_name="__main__")
            self.assertEqual(caught.exception.code, 1)
            self.assertIn("access_unavailable", output.getvalue())
            self.assertNotIn("private upstream", output.getvalue())
            self.assertNotIn("fixture-token", output.getvalue())
            self.assertEqual(path.read_text(), "previous")


if __name__ == "__main__":
    unittest.main()
