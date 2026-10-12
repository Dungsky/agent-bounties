# Native client checks — October 12, 2026

Maintainer acceptance checks for the [Cline](./cline/) and [Linear](./linear/)
setup guides. These are internal tests, not independent users, endorsements or
evidence of acquisition. Contact: np@agentbounties.app.

## What completed

| Client | First action | Continuation | Evidence checks |
| --- | --- | --- | --- |
| Cline CLI 3.0.70 | One manually approved `get_bounty_feed` call with `limit: 1` against the public production MCP endpoint | Reopened the saved session in a separate CLI process; pasted the resume prompt into its interactive input | 54 passed: 24 comparisons against the saved structured tool result, plus 30 process, continuation and caveat checks |
| Linear native Agent | Connected 30 tools; reconnected after the server update; visible activity showed the public feed read and returned an assessment | Reloaded the saved conversation and resumed it with no visible new tool activity | 30 passed: comparisons of the two JSON receipts read from the native conversation UI |

Both retained the opportunity ID and title, reward and bond units, external-spend
scope, unknown gas, eligibility limits, verification method, evidence fields,
source timestamps and deadline meaning. The returned deadline was a
`funding_deadline`; neither workflow treated it as a submission deadline.
No bounty was claimed, signed, funded or submitted.

## Limits and recovery

- Cline omitted 7,797 characters from its model-facing tool result. Its answer
  correctly reported partial evidence. The persisted structured result allowed
  the maintainer to check grounding, but that does not make the model's view
  complete. Inspect missing terms before considering an action involving funds.
- Cline's `--id` reopened the interactive session but ignored a positional
  prompt. Paste the continuation prompt into that session and press Enter.
- Linear's inspected UI did not expose the raw MCP arguments and result. Its
  checks support visible behavior and receipt consistency, not a transport
  trace. The cause of earlier Linear errors was not isolated; success followed
  the server release and reconnect.
- The public events URL returned with the task does not guarantee full task
  terms. A reported external-spend value of zero does not erase eligibility,
  gas uncertainty or a task's third-party funding requirement.
- Saved-session continuation does not refresh availability or prove that a
  task is suitable for the current user. Extension/IDE behavior, Linear coding
  Sessions and Loops, task completion and payment were outside these checks.

## Capacity and server evidence

Cline used an existing ChatGPT subscription through `openai-codex`, with included
capacity and no API-key fallback, credit purchase or reset. Other users must
check their own provider capacity. Linear's workspace remained on Free with one
user, $0.00 remaining and no invoices before and after the two turns. Linear
[documents its separate coding Session and Loop credit requirements](https://linear.app/docs/ai-credits).

The [MCP schema repair](https://github.com/NSPG13/agent-bounties/pull/1636)
keeps the model-facing V2 mutation descriptor compact and exposes exact
operation arguments through the read-only schema inspector. Production API
and MCP reported revision `dc7a08180c0c94ca3b38b8f8da3a4c2c6fe0e03a`.
Sixteen production schema checks passed, including equality between all ten
operation schemas and the advanced HTTP catalog; the production smoke check
also passed. Existing payment and readiness controls were unchanged.

These two clients produced **zero independent activations and zero independent
returns**. The checked setup is a reproducible starting point, not a guarantee
that every client version, account or task will behave identically.
