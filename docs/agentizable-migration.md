# Agentizable domain migration

Agentizable is the product name. Its canonical website is `https://agentizable.ai`,
with API at `https://api.agentizable.ai` and MCP at `https://mcp.agentizable.ai/mcp`.
The production cutover completed on October 28, 2026. The original rollout
sequence below is retained as a runbook; its steps are not outstanding work.

## Verified cutover status — October 28, 2026

- Public rebrand [PR #1691](https://github.com/NSPG13/agent-bounties/pull/1691)
  and cache/canary follow-up
  [PR #1696](https://github.com/NSPG13/agent-bounties/pull/1696) are merged.
  The verified website release is `a585ab0ae11d55d5098dbff36bc8203c40da1c12`.
- Cloudflare DNS, Pages and TLS serve the new website. The final website
  canary passed for all 23 homepage assets, and a real Google sign-in returned
  successfully to the new domain.
- API and MCP serve the new domains at the separately gated runtime revision
  `77bfa2136cd1ad9a538a001995842b6a55602548`. Both old API/MCP hosts remain
  available directly for existing integrations.
- Old website GET/HEAD requests redirect with HTTP 301 to the equivalent
  `https://agentizable.ai` path and query. Old POST requests are not redirected.
  The new www hostname also redirects to the new apex.
- Provider origins/callbacks, sender-domain authentication, analytics,
  monitoring and Search Console migration were updated. Glama uses the new
  name and endpoint. MCP Market and MCP.so still require vendor-managed edits;
  external caches may update independently.

These checks establish the rebrand and login cutover, not a paid transaction.
The separate funding-setup probe still encounters a preexisting upstream RPC
rate-limit failure; no wallet signature or payment was used to verify branding.
Recheck live revisions and health before any later release or incident action.

## Deployment topology and original rollout sequence

The public website is served by Cloudflare Pages (`agent-bounties.pages.dev`).
The GitHub Pages configuration is retained but is not the live DNS target.
The production API and MCP use a separate runtime release branch, with Render
auto-deploy disabled.
Changing the public repository alone does not release the runtime.

1. Add `agentizable.ai` to the existing Cloudflare account. Preserve any real mail
   records. Obtain the assigned nameservers and change them at the registrar;
   wait for Cloudflare to report the zone active. This delegation is complete;
   the former Namecheap parking nameservers are no longer the active setup.
2. Attach `agentizable.ai` and `www.agentizable.ai` to the existing Cloudflare
   Pages project. Point the apex and www CNAMEs to `agent-bounties.pages.dev`.
   Use DNS-only CNAMEs for `api` and `mcp` pointing to their existing Render
   service targets. Obtain and verify HTTPS certificates before switching links.
3. Add the new API and MCP custom domains in Render while retaining both old
   aliases. The Blueprint and deployment controller retain the old domains.
4. Register the new API callback URLs with enabled OAuth providers (Google,
   Microsoft, GitHub, Amazon). Add the new web origin in Coinbase CDP,
   WalletConnect, MoonPay and other configured browser-provider allowlists.
   Keep old registrations through the migration window. GitHub OAuth apps may
   require a separate app or coordinated callback switch; verify its configured
   app type before changing the callback. Configure any new email sender domain
   separately; existing working contact mailboxes remain published meanwhile.
5. Validate and release both source trees through the existing release gates.
   Change nonsecret API, MCP and website base URLs to the new origins; retain
   both exact website origins in SITE_AUTH_ALLOWED_ORIGINS and any enabled
   onramp origin allowlists. Update OAuth redirect environment values only after
   provider registration. Preserve all signing keys, payment flags and data.
6. Verify the new homepage, deep links, static assets, sitemap, discovery JSON,
   llms.txt, API health/OpenAPI, MCP initialize/tools, preflight CORS and a real
   sign-in round trip. Verify wallet/provider journeys without sending funds.
   Existing site cookies and browser storage cannot move across registrable
   domains; users may need to sign in again. MCP clients need to reconnect and
   authorize against the new issuer/resource origin.
7. Once new journeys pass, redirect old website GET/HEAD requests at the
   Cloudflare edge to the equivalent new path and query. Redirect www to the
   new apex. Keep old API/MCP hosts serving requests directly; do not redirect
   authenticated POST, webhook or OAuth traffic to another origin.
8. Update repository deployment variables, monitor URLs, provider branding,
   Stripe public business website and webhook registrations, installed MCP
   clients, directory listings, analytics stream URL and Search Console. Active
   monitoring automations also need their names and live URLs updated only when
   the cutover is verified.
   Change webhook endpoints with provider-supported overlap and replay
   protection. Keep the old domain renewed and old API/MCP aliases until
   observed traffic and provider registrations confirm they can be retired.

## Compatibility boundaries

The rebrand changes visible product copy, canonical links, defaults, discovery
metadata and deployment configuration. It does not rewrite on-chain contracts,
EIP-712 signing domains, schema/protocol versions, database keys, historical
payment evidence, immutable benchmark bundles or published package names.
The discovery schema URI remains its existing identifier; its name field accepts
both Agentizable and the previous display name for cached manifests.
Reviewed MCP descriptor digests are regenerated for the changed descriptive copy;
tool names, annotations and authorization behavior retain their existing contract.
Existing GitHub repository/package/skill identifiers are retained as functioning
compatibility addresses until their own coordinated rename. A repository rename
also requires release-controller allowlists, CI repository predicates, registry
bindings and connector registrations to be migrated together.

## Contributor impact and local verification

The open pull-request queue was inspected before editing. Public PR #1676
explicitly asserts the former origins and needs its canonical-origin expectations
updated while preserving documented legacy aliases. Existing work on wallet,
OAuth, website and discovery surfaces may need a textual rebase. Concurrent
card-payment repairs remain separate; merge the rebrand into the eventual release
base without discarding those changes.
For future changes that affect contributors, publish the contributor notice
through an authorized maintainer channel before rollout.

Run `bash scripts/preflight.sh core`, `python scripts/check-site.py`,
`python scripts/check-render-blueprint.py`, the discovery/portable-skill checks,
focused runtime/auth tests and `git diff --check`. These establish source
readiness; successful DNS, TLS and provider journeys establish live readiness.

## Rollback

Before cutover, keep current domains and current deployed source in service.
If a new-domain journey fails, stop the switch and retain the old origin/config.
After cutover, restore the previous website release and base-URL/callback
configuration with matching provider registrations; retain both DNS aliases.
Do not roll back financial event readers to an incompatible runtime, alter
historical evidence, delete certificates or remove old domain ownership.
