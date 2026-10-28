# Card payment website release

The order page, customer review and refund display are separate from live card
payment activation. Publishing these files does not enable Stripe, treasury
funding or refund execution.

Keep `data-card-payment-enabled="false"` on the posting page until the approved
live payment launch checks pass. The controller hides the entry and makes no
quote or sign-in request while the flag is absent or inactive. Server permissions
and payment gates remain authoritative even if someone changes their own DOM.

Activation requires a separate reviewed website release alongside verified live
server configuration, funding capacity and the approved payment rehearsal. Do
not change the flag merely because the website files or backend build are live.

Recovered-bounty refunds show the original solver reward and verification
charges only. Fees and the review deposit are separate. Only a verified Stripe
refund status may say the card refund was sent; it does not prove bank credit.
Historical bounty funding and its later recovery remain visible separately.

After publication, verify `account.html` and both managed-service JavaScript
assets have the expected bytes and content types. A homepage fallback with HTTP
200 is not a successful asset deployment. Run the managed-service browser,
card-entry, solver-v2, site and navigation checks before publication.
