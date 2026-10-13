# Bankr native first-use checks — October 13, 2026

The [Bankr guide](https://agentbounties.app/install/bankr/) now describes a tested free terminal route: connect the public MCP server, inspect one opportunity, and reopen the saved assessment. This is an internal maintainer test, not a new user, endorsement or external activation.

## Observed behavior

- The owner completed Bankr sign-in and terms acceptance. In Connections → Add MCP, Streamable HTTP with blank header fields connected `https://mcp.agentbounties.app/r/bankr/mcp` and discovered 30 tools. No AgentBounties API key, OAuth grant, wallet signature or funding was needed.
- The native mode stayed **Fast**. Its free-message counter moved from **0/5 to 4/5** across three first-action prompt trials and one saved-session continuation. Max, subscription, paid API and credit purchase were not used. [Bankr’s access documentation](https://docs.bankr.bot/agent/access/) distinguishes these routes.
- The final first-action answer and saved-session continuation passed **28 field comparisons** against a separate live production source read: identifier/title, reward/bond and units, external-spend amount/scope, eligibility, verification/evidence requirements, source timestamps, deadline/kind and source URL.
- The original assessment survived reload. The continuation preserved its original `generated_at`; the final starter-prompt result also survived another reload with identical JSON. Its separate clickable source URL matched the receipt.
- The final answer retained unknown gas amount/payer, funding-deadline meaning, contributor eligibility, conditional bond refund and third-party funding uncertainty. A proposed read-only next step was returned without authorizing financial work.

The observed opportunity was `canonical:base-mainnet:0xbf99f1c2c690c8bcd45e341006bf7b7dd6c41cdc`. The final starter result reported `generated_at=2026-10-13T02:30:36.296050022+00:00`, while the earlier resumed assessment retained `2026-10-13T02:21:53.409104393+00:00`. Both preserved source update time `2026-10-12T22:05:55+00:00`. These are dated observations, not a promise of current availability or eligibility.

## Corrections and limits

The initial compact JSON was not fenced, and Bankr included JSON punctuation in its clickable source URL. It also inferred human identity from a contributor role and overstated bond timing. A later iteration still labeled unestimated gas nonzero. The final tested prompt requests fenced JSON, a separate source link, fact/interpretation separation and explicit uncertainty about gas and its payer. Those corrections are reflected in the final answer; the earlier limitations are not hidden.

Bankr did not expose raw MCP arguments/results or a per-call trace in this chat. The prompts request one feed call with `limit: 1`, and the continuation reports an empty tools list; exact backend call counts and zero-tool execution are not independently attested. The separate production source read verifies shared field values, not Bankr’s raw transport or exact `generated_at`. Bankr’s activity panel was empty and its gas-free transaction counter stayed 10/10; no financial action was requested or observed.

This check does not verify Bankr’s paid Agent API, optional skill installation, mobile UI, bounty claiming, posting, signing, payment or settlement. Future usage remains subject to the account’s current allowance. Render hosting usage is covered by the project owner’s separate standing authorization; its attributable cost was not measured. No new paid plan or purchase was made.

For earlier scoped results, see the [Cline and Linear receipt](https://agentbounties.app/install/client-acceptance-20261012.md). AgentBounties contact: **np@agentbounties.app**.
