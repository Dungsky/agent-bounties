import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('required_postgres', ROOT / 'scripts/run-required-postgres-test.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def result(stdout='', code=0):
    return subprocess.CompletedProcess([], code, stdout=stdout, stderr='')


class RequiredPostgresTests(unittest.TestCase):
    def run_case(self, responses, **kwargs):
        with patch.object(runner.subprocess, 'run', side_effect=responses) as calls, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            code = runner.run_required('api', 'tests::selected', **kwargs)
        return code, calls

    def test_absent_selector_fails_before_execution_even_with_cargo_success(self):
        code, calls = self.run_case([result('0 tests, 0 benchmarks\n')], exact=True)
        self.assertEqual(code, 1)
        self.assertEqual(calls.call_count, 1)

    def test_real_selection_and_nonzero_result_pass(self):
        code, calls = self.run_case([result('tests::selected: test\n'), result('test result: ok. 1 passed; 0 failed; 0 ignored;\n')], exact=True, test_threads=1)
        self.assertEqual(code, 0)
        self.assertIn('--exact', calls.call_args_list[0].args[0])
        self.assertIn('--ignored', calls.call_args_list[0].args[0])
        self.assertIn('--list', calls.call_args_list[0].args[0])
        self.assertNotIn('--list', calls.call_args_list[1].args[0])
        self.assertEqual(calls.call_args_list[1].args[0][-2:], ['--test-threads', '1'])

    def test_zero_executed_tests_cannot_pass_after_a_valid_list(self):
        code, _ = self.run_case([result('tests::selected: test\n'), result('test result: ok. 0 passed; 0 failed; 1 ignored;\n')])
        self.assertEqual(code, 1)

    def test_each_selected_test_must_run(self):
        code, _ = self.run_case([result('first: test\nsecond: test\n'), result('test result: ok. 1 passed; 0 failed; 1 ignored;\n')])
        self.assertEqual(code, 1)

    def test_compile_failure_and_test_failure_propagate(self):
        for responses, expected in [([result(code=101)], 101), ([result('tests::selected: test\n'), result(code=101)], 101)]:
            code, _ = self.run_case(responses)
            self.assertEqual(code, expected)

    def test_unrecognized_success_output_is_not_evidence(self):
        code, _ = self.run_case([result('tests::selected: test\n'), result('all good\n')])
        self.assertEqual(code, 1)

    def test_postgres_entrypoints_use_guard_and_current_selectors(self):
        for name in ['.github/workflows/ci.yml', 'scripts/check-postgres.sh', 'scripts/check-postgres.ps1']:
            text = (ROOT / name).read_text()
            self.assertNotRegex(text, r'cargo test[^\n]*--ignored')
            self.assertNotIn('bounty_status_reads_base_events_from_postgres_after_cross_process_indexing', text)
            self.assertIn('tests::bounty_status_reads_scoped_postgres_after_cross_process_funding --exact', text)
            self.assertIn('tests::mcp_bounty_status_reads_scoped_postgres_after_cross_process_funding --exact', text)
            self.assertIn('scripts/run-required-postgres-test.py', text)


if __name__ == '__main__':
    unittest.main()
