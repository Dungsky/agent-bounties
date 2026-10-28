import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import refresh_site_metrics as metrics


class Response(io.BytesIO):
    status = 200
    def __init__(self, data, links=""):
        super().__init__(json.dumps(data).encode())
        self.headers = {"Link": links}


class Tests(unittest.TestCase):
    def test_pagination_keeps_all_records_and_read_only_requests(self):
        requests = []
        responses = iter([Response([{"id": 1}], '<'+metrics.PREFIX+'issues?page=2>; rel="next"'), Response([{"id": 2}])])
        class Opener:
            def open(self, request, timeout):
                requests.append(request)
                return next(responses)
        rows = metrics.Reader("fixture-token", Opener()).records("NSPG13/agent-bounties", "issues")
        self.assertEqual(rows, [{"id": 1}, {"id": 2}])
        self.assertTrue(all(req.get_method() == "GET" for req in requests))
        self.assertTrue(all(req.get_header("Authorization") == "Bearer fixture-token" for req in requests))

    def test_foreign_pagination_cannot_receive_credentials(self):
        class Opener:
            calls = 0
            def open(self, request, timeout):
                self.calls += 1
                return Response([], '<https://attacker.invalid/steal>; rel="next"')
        opener = Opener()
        with self.assertRaises(ValueError):
            metrics.Reader("fixture-token", opener).records("NSPG13/agent-bounties", "issues")
        self.assertEqual(opener.calls, 1)

    def test_github_numeric_repository_pagination_is_scoped(self):
        requests = []
        next_url = metrics.PAGINATION_PREFIX + "issues?state=all&per_page=100&after=cursor&page=2"
        responses = iter([Response([{"id": 1}], '<'+next_url+'>; rel="next"'), Response([{"id": 2}])])
        class Opener:
            def open(self, request, timeout):
                requests.append(request.full_url)
                return next(responses)
        reader = metrics.Reader("fixture-token", Opener())
        self.assertEqual(reader.records("NSPG13/agent-bounties", "issues"), [{"id": 1}, {"id": 2}])
        self.assertEqual(requests, [metrics.PREFIX + "issues", next_url])
        for url in ("https://api.github.com/repositories/1/issues", "https://api.github.com/repositories/12930306960/issues"):
            with self.assertRaises(ValueError):
                reader.page(url)
        self.assertEqual(len(requests), 2)

    def test_failed_collection_preserves_previous_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            path.write_text('{"generated_at":"original"}')
            with patch.object(metrics.audit, "collect_snapshot", side_effect=ValueError("failed")):
                with self.assertRaises(ValueError):
                    metrics.refresh(path, "fixture-token")
            self.assertEqual(path.read_text(), '{"generated_at":"original"}')

    def test_cli_can_prepare_a_private_candidate_without_touching_release_source(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'candidate.json'
            with patch('sys.argv', ['refresh_site_metrics.py', '--output', str(output)]), \
                 patch.dict(metrics.os.environ, {'GITHUB_METRICS_TOKEN': 'fixture-token'}), \
                 patch.object(metrics, 'refresh') as refresh:
                metrics.main()
                refresh.assert_called_once_with(output, 'fixture-token')

    def test_concurrent_collector_does_not_replace_or_start_another_scan(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            path.write_text('previous')
            with metrics.collection_lock(path):
                with patch.object(metrics.audit, 'collect_snapshot') as collect:
                    with self.assertRaises(BlockingIOError):
                        metrics.refresh(path, 'fixture-token')
                    collect.assert_not_called()
            self.assertEqual(path.read_text(), 'previous')

    def test_invalid_generated_aggregate_does_not_replace_last_success(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            path.write_text('previous')
            with patch.object(metrics.audit, 'collect_snapshot', return_value={}):
                with self.assertRaises(ValueError):
                    metrics.refresh(path, 'fixture-token')
            self.assertEqual(path.read_text(), 'previous')

    def test_success_writes_aggregate_without_raw_identities(self):
        fixture = json.loads((metrics.ROOT / "scripts/fixtures/github_participation_metrics.json").read_text())
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            with patch.object(metrics.audit, "collect_snapshot", return_value=fixture):
                metrics.refresh(path, "fixture-token")
            result = json.loads(path.read_text())
            self.assertFalse(result["coverage"]["raw_identifiers_included"])
            self.assertEqual(result["coverage"]["status"], "ready")
            self.assertNotIn("fixture-token", path.read_text())
            self.assertNotIn('"user"', path.read_text())


if __name__ == "__main__":
    unittest.main()
