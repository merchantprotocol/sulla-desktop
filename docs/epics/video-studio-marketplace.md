# Video Studio Marketplace integration

## Goal
Make the Sulla Video Studio Use Case discoverable and purchasable as a $297 one-time listing. This repo owns the Sulla Desktop marketplace experience only; website and Workers have their own repo-scoped epic branches because a GitHub PR cannot span repositories.

## Required client behavior
- Render listing price from the server's `price_cents` and `currency`; never send or trust client price values.
- For paid listings without an entitlement, show a purchase action that calls the Worker checkout endpoint and follows its returned URL.
- After return from checkout, refresh the listing/entitlements; enable download/install only when the Worker reports ownership. Do not treat a checkout-return query string as proof of payment.
- Keep existing free listing behavior. The server remains the authority and gates paid download/install with HTTP 402.

## Safety / release
- Checkout testing is staging/test-mode only. No live Stripe product/price, live secret, payment, or deployment action in this epic. Jonathon's tap is required before any live charging setup.
- No event email or public promotion is part of this epic.
- Build/QA in the VM only. Never install or restart Sulla Desktop on Jonathon's Mac.
