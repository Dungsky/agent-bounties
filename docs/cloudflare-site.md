# Cloudflare website operations

Pages builds `main` with `bash scripts/build-static-site.sh` and publishes `site`.
The build verifies wallet assets and origin, prepares licensed fonts and schemas,
validates the reviewed local participation aggregate, and runs site tests. It
makes no GitHub activity collection calls and needs no GitHub metrics token.
The manifest at [site-build.json](https://agentizable.ai/.well-known/site-build.json)
records the source revision, aggregate hash, original observation time and
whether the aggregate was reused or unavailable. A new build never refreshes
an old observation timestamp.

The durable input is the versioned `site/generated/github-participation.json`
in the reviewed release source. The current checked-in aggregate was recovered from the verified website
release c232675, observed October 28 at 21:21:12 UTC. Its collector and exclusion
policy match the reviewed source; only the policy digest was added. Counts and
observation windows are unchanged. When no trusted aggregate is supplied, the
build uses unavailable with no counts and no invented observation time. A fresh checkout therefore makes no assumption
about a previous deployment's files. Malformed input, raw fields, unreviewed
metadata, wrong schema or changed exclusion policy stop validation; they do not
silently become unavailable.

The existing explicit collector, `python3 scripts/refresh_site_metrics.py`, can
prepare a replacement using a public-repository read-only `GITHUB_METRICS_TOKEN`.
It validates aggregate-only output and binds it to the current exclusion policy,
locks concurrent collectors and atomically replaces the file only on success.
Raw records and the token remain in memory. Use `--output` to write a candidate under the existing private operations
directory, then review and publish only that aggregate with its original
observation windows in the release source. Do not commit
private raw collection records. A failed attempt preserves the last success and
must be reported separately; this patch does not establish a daily publisher or
an incremental collection cache.

Public build variables remain the existing Coinbase and WalletConnect project
IDs, analytics measurement ID, `NODE_VERSION=22`, `PYTHON_VERSION=3.12` and
`SKIP_DEPENDENCY_INSTALL=true`. Metrics describe a daily snapshot and show its
actual age. The existing two-hour delay threshold is unchanged; delayed data
cannot supply a current complete account headline. Canonical payment metrics
remain independent of optional GitHub participation coverage.

The existing free Worker requests a Pages rebuild at 12:17 UTC. Rebuilding no
longer collects GitHub activity. Its schedule is unchanged here; remove that
duplicate rebuild only after the owner's daily artifact publication path is
verified. The legacy GitHub Pages workflow is retained as manual validation only, with
its deployment job disabled in source. Its live disabled setting must remain
disabled; no paid duplicate push or daily builds are needed. Neither schedule is proof of fresh metrics.
The Worker hook stays restricted to this project and production branch; it has
no signing credentials or general Cloudflare API token. A hook success is not a
completed deployment: inspect Pages status and the live manifest's source,
aggregate hash and observation time. New source pushes still deploy normally.

## Existing 3 p.m. task: trusted aggregate publication

No new schedule or storage provider is required. Extend the existing daily task
only after this change is reviewed:

1. After GitHub review, inspect that day's report watermark. Reuse a successful
   same-cycle collection; do not scan again for every deployment or retry.
2. On trusted reviewed source, use the existing read-only collector with the
   existing authenticated local GitHub credential and `--output` pointing to
   `metrics-aggregate-candidate.json` in that day's private operations directory.
   Pass the token privately through the environment, never in logs or a command
   argument. The competitor collector is a different tool and supplies no
   GitHub participation artifact.
3. Validate the candidate with `prepare_site_metrics.prepare(candidate,
   policy_path)`. Record collection time, exact source/policy and aggregate hash
   in the daily evidence. On failure keep the last success, record failed source
   coverage and do not advance its successful watermark. Never label old data
   fresh or infer that an unavailable collector means zero participation.
4. Copy only the validated aggregate into `site/generated/github-participation.json`
   on a reviewed release branch. Inspect the aggregate-only diff, run preparation,
   audience/dashboard and site tests, and use the existing reviewed merge process.
   Publication is a source change under existing release authority, not authority
   granted by a scheduled collection. Preserve no-publication holds when present.
5. Verify Cloudflare's resulting deployment and compare live manifest/aggregate
   hashes and observation time to the candidate before recording publication as
   verified. Keep the old source artifact until that succeeds. Once one real
   daily publication cycle is verified, retire the redundant Cloudflare daily
   rebuild through its separately reviewed configuration change.

This path is prepared; an automated daily publisher has not been established.
The current full-history collector remains bounded by its existing per-endpoint
limits and may still exhaust GitHub rate limits. Incremental caching and a
shared cycle request budget remain separate work; failed collection must not
block application compilation or be retried in a tight loop.

Keep the previous host available until both production domains serve the exact
source, wallet configuration, notification handler and manifest over valid TLS.
Then disable the old Pages deployment schedule to avoid competing publishers.
API/MCP hosting, mail records, account origins, budgets and signing keys are
separate from this website cutover and remain unchanged.

The public homepage canary also checks the existing account-level Web Analytics
edge injection on `agentizable.ai`. The reviewed exact script is recorded in
`ops/cloudflare/site-canary-edge.json`, including its URL, integrity, public site
identifier, settings and attributes. The account excludes EU visitors, so zero
or one exact beacon is allowed, only as the final direct child of the body. This
is separate from Pages-project analytics and does not enable tracking or change
provider settings. All original asset order/bytes and script attributes/content
remain checked; other, duplicate or changed scripts fail. Re-review the profile
when the provider changes its script. The immutable Pages URL check remains a
separate build check and does not replace the custom-domain check.
