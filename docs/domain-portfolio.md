# Domain portfolio

Agentizable uses `agentizable.ai` as its canonical website, with
`api.agentizable.ai` and `mcp.agentizable.ai` for runtime traffic.
See [the migration runbook](agentizable-migration.md) for ordering and live gates.
The new domain must be connected and verified before this prepared configuration
is promoted. The website is hosted on Cloudflare Pages, while API/MCP run on Render.

| Host | DNS destination | Purpose |
| --- | --- | --- |
| `agentizable.ai` | CNAME `agent-bounties.pages.dev` (Cloudflare zone) | Canonical website |
| `www.agentizable.ai` | CNAME `agent-bounties.pages.dev` | Redirect to canonical apex |
| `api.agentizable.ai` | CNAME `agent-bounties-api.onrender.com` (DNS only) | API |
| `mcp.agentizable.ai` | CNAME `agent-bounties-mcp.onrender.com` (DNS only) | MCP |
| `agentbounties.app` and `www.agentbounties.app` | Existing Cloudflare edge | Redirect after successful cutover |
| `api.agentbounties.app` and `mcp.agentbounties.app` | Existing Render services | Direct compatibility aliases |

Additional existing `agentbounties` portfolio domains and `bountyboard.global`
should retain their purpose-specific paths and migrate their final website target
to `agentizable.ai` only after it is healthy. Do not send state-changing API/MCP
requests through website redirects. Keep existing confidential and staging
hostnames intact until their separate authentication and certificate migration.

Update canonical tags, sitemaps, app/partner listings and optional consented GA4
stream configuration to the new website. Submit the new sitemap in Search Console
and use its domain-migration process after permanent redirects work. Preserve
path and query strings and verify TLS on both sides of every redirect.

Mailboxes on the old domain remain active until new-domain mail routing and sender
verification are complete. Preserve current MX, SPF, DKIM and DMARC records and
keep the old domain renewed throughout the migration window.
