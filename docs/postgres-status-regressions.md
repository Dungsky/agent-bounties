# PostgreSQL status regressions

Run ignored database tests against a disposable PostgreSQL database with
`AGENT_BOUNTIES_TEST_DATABASE_URL` set. Use the guarded runner so a missing or
renamed selector cannot pass silently:

```sh
python3 scripts/run-required-postgres-test.py -p api tests::bounty_status_reads_scoped_postgres_after_cross_process_funding --exact
python3 scripts/run-required-postgres-test.py -p mcp-server tests::mcp_bounty_status_reads_scoped_postgres_after_cross_process_funding --exact
```

The runner first lists the actual compiled tests, then requires that every
selected test executes successfully. An empty selection, an ignored-only run, a
compile error or a test failure fails the gate. CI and both local PostgreSQL
scripts use the same runner. Do not remove the guard to accommodate a rename;
update the selector and attach its nonzero result.

These two tests check the current API and direct MCP HTTP bounty-status handlers.
They start with unfunded records, keep the reader's memory stale, and run a
separate OS process that writes two synthetic funding records through the
application's current PostgreSQL persistence path. The original reader must see
fresh funding for the selected bounty, exclude the other bounty, reject a
missing ID, and retain the same result through a newly created reader. Funding
must not be represented as settlement. The test output includes the independent
writer's process ID.

The earlier API test name referred to retired Base escrow event ingestion and a
removed response field. This replacement does not restore those interfaces or
claim to test blockchain ingestion, live funding, signer authority or payouts.
It uses the simulated payment rail in a local fixture; it never contacts a chain
or payment/model provider. The direct MCP status adapter is distinct from the
remote ChatGPT MCP catalog, which does not expose this status tool.
