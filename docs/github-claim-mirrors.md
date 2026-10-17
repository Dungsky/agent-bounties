# Reviewed GitHub claim mirrors

Some funded bounties have no GitHub source URL in their immutable terms. The
publisher can later create a GitHub issue for discovery. Its title, body, labels
and comments cannot authorize a contract lookup.

For those cases, `ops/github-claim-mirrors.json` is a reviewed, versioned registry
in the same trusted checkout as the claim responder. It binds GitHub's numeric
repository and issue IDs, repository name and issue number to one Base mainnet
autonomous-v1 contract and its exact terms hash. It also pins the factory,
creation transaction and original publication evidence. There is no environment
variable, issue-body marker or API write that adds a binding at runtime.

Before adding an entry, a maintainer must preserve the original successful
publication result, verify its artifact hash and trusted workflow source, and
match the issue's immutable GitHub identity. Independently verify the contract,
factory and terms hash from canonical creation and current chain evidence.
Review and release registry edits like payment-routing code. A changed issue
title or a current body containing a contract address is insufficient evidence.

At request time, the responder checks the GitHub event's IDs and issue URL,
the canonical feed's original terms and creation event, and the earning feed.
Wrong IDs, changed hashes, a different network, conflicting target contracts,
missing records or a held verification path cannot produce a claim handoff.
Ambiguous records for an unrelated issue are excluded from recommendations and
do not decide the requested issue's result. Existing exact funded source-URL
lookups keep their previous checks.

The registry does not edit funded terms, reveal private records, reserve work,
sign a transaction or prove payment. The API and contract still enforce current
claim eligibility. A handoff is a request to continue the normal verified flow;
only a confirmed `BountyClaimed` owns the round.

Validate changes with `python3 scripts/test_reconcile_github_bounty_labels.py -v`
and the applicable release gates. The inventory workflow runs that suite for
registry and claim-responder changes. For a read-only rehearsal, capture fresh
public full and earning feeds, pass them through the fixture reader with the
real GitHub event IDs, and use no solver wallet. Assert that the transport and
native claim-handoff functions are never called. Do not submit a claim or pay a
bond simply to test this registry.
