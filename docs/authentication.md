# Publishing immutable bounty terms

Both direct terms publication and child preparation require a website account
with a verified link to the exact creator wallet, or a current wallet session
for that wallet and network. A connected address, keeper key or operator token
is not creator authority. Unsupported embedded/counterfactual wallet login must
stop before publication; a deployed ERC-1271 wallet requires a proof the server
can verify. The browser keeps the account-cookie path and offers an explicit
ownership-only login for supported unlinked external wallets. That login does
not link an account or authorize funding.

Send one `Idempotency-Key` (1–200 printable characters). Save it with the complete
request, including nonce and deadlines, before sending. Retry that exact pair;
do not generate a new nonce or deadline after a lost reply. The original key
returns the original publication even after its cutoff. New publications share
the three-per-principal daily allowance; exact retries do not consume it again.

A new key for existing terms returns `409 publication_already_exists` and a
canonical `next_action_url`. Read that exact terms hash and compare the creator,
complete expected document and all five commitment hashes before using it. A
readback is not permission to sign or fund. The website stops after this conflict and directs the owner to the original
posting in their account. A second click cannot bypass recovery or cause a new
funding request. SDKs
expose `get_verified_autonomous_bounty_terms` /
`getVerifiedAutonomousBountyTerms` for explicit readback; they do not automatically
retry, create a replacement, sign or fund. Keep the original request on
`publication_idempotency_conflict`, `publication_limit_reached` or unavailable
responses. Do not loop on authentication or provider failures.

Python publication now requires the keyword `idempotency_key`; TypeScript
requires a third `idempotencyKey` argument. Obtain a wallet session separately or
use the supported website-account credential path. For example:

```python
client.publish_autonomous_bounty_terms(creator, document, idempotency_key=saved_key)
# Only when explicitly reviewing an existing canonical record:
record = client.get_verified_autonomous_bounty_terms(expected_hash, creator, document)
```

Activation tools require `TERMS_CREATOR_SESSION_TOKEN`, a short-lived session for
the exact contract/creator wallet and chain. They check it before deployment or
activation actions and send it only to a canonical API origin (or explicit local
test origin), with redirects disabled. They derive a stable key from the exact
publication payload; an existing-record conflict stops activation after checking
its content. A keeper's spending authority cannot substitute for this session.
Never paste the token into chat, logs, command arguments or a committed file.

The CLI's portable creation plan includes a `registration` artifact with the
publication method, path and exact request. That artifact is content to review,
not authentication. Before sending it, save a stable key beside it and supply
`Idempotency-Key` plus verified creator authority for the artifact's network.
Do not add either credential or key to `terms_publication_request.document`:
that would alter the committed content and hashes. Stop and reconcile any
existing publication or pending creation before approving wallet calls. The
portable planner itself does not publish, sign or fund anything.

Readback checks follow the server’s documented optional-field serialization:
missing `source_url`/`discovery_source` fields become null; null image, eligibility and coordination
objects are omitted; present eligibility/coordination objects receive their
defaults, and eligibility wallet lists are normalized, sorted and deduplicated.
The exact saved POST body and key are unchanged. Unknown substantive fields are
not silently discarded by the client, and every resulting commitment is checked.
