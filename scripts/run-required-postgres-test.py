#!/usr/bin/env python3
"""Run required ignored Rust/PostgreSQL tests; missing selectors are failures.

The list pass checks the actual compiled test inventory. The execution pass also
requires successful, nonzero test results, because Cargo returns success for an
empty selection. This does not start a database or alter its connection settings.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys


def run_required(package: str, selector: str, *, exact: bool = False,
                 test_threads: int | None = None, cargo: str = "cargo") -> int:
    prefix = [cargo, "test", "-p", package, selector, "--", "--ignored"]
    if exact:
        prefix.append("--exact")
    listed = subprocess.run([*prefix, "--list", "--format", "terse"], text=True, capture_output=True)
    print(listed.stdout, end="")
    print(listed.stderr, end="", file=sys.stderr)
    if listed.returncode:
        return listed.returncode
    selected = re.findall(r"^(.+): test$", listed.stdout, re.MULTILINE)
    if not selected:
        print(f"Required PostgreSQL test selector matched zero tests: {package} {selector}", file=sys.stderr)
        return 1
    command = [*prefix, "--nocapture"]
    if test_threads is not None:
        command.extend(["--test-threads", str(test_threads)])
    result = subprocess.run(command, text=True, capture_output=True)
    print(result.stdout, end="")
    print(result.stderr, end="", file=sys.stderr)
    if result.returncode:
        return result.returncode
    passed = sum(int(n) for n in re.findall(r"^test result: ok\. (\d+) passed;", result.stdout, re.MULTILINE))
    if passed < len(selected):
        print(f"Required PostgreSQL tests did not all execute: selected={len(selected)} passed={passed}", file=sys.stderr)
        return 1
    print(f"required_postgres_test package={package} selected={len(selected)} passed={passed}")
    return 0


def cargo_executable() -> str:
    # Python cannot inherit check-postgres.sh's cargo() shell fallback.
    # An explicit override must remain authoritative, even if it is invalid.
    override = os.environ.get("CARGO")
    if override is not None:
        return override
    return shutil.which("cargo") or shutil.which("cargo.exe") or "cargo"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-p", "--package", required=True)
    parser.add_argument("selector")
    parser.add_argument("--exact", action="store_true")
    parser.add_argument("--test-threads", type=int)
    args = parser.parse_args()
    if args.test_threads is not None and args.test_threads < 1:
        parser.error("--test-threads must be positive")
    return run_required(args.package, args.selector, exact=args.exact,
                        test_threads=args.test_threads, cargo=cargo_executable())


if __name__ == "__main__":
    raise SystemExit(main())
