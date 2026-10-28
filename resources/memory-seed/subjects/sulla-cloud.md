---
slug: sulla-cloud
kind: system
name: Sulla Cloud
parent: sulla
aliases: [Sulla Cloud, Cloud relay, cloud account, paired cloud]
---

## Overview
Sulla Cloud is the account and relay service used by Desktop and Mobile. Desktop stores the signed-in Cloud session through the encrypted vault, connects to a Cloudflare Worker WebSocket relay, and can exchange work with paired devices. Cloud account sign-in and relay connectivity are separate from local Desktop execution. Desktop code supports relay, device pairing, and opted-in sync paths; it does not justify pricing or undocumented quotas.

## Facts
- Desktop Cloud auth is implemented in `pkg/sulla-desktop/main/sullaCloudAuth.ts` and stores the session under integration ID `sulla-cloud` through the vault.
- `pkg/sulla-desktop/main/desktopRelay.ts` connects Desktop to the Cloud relay and carries paired mobile chat/work requests.
- The Cloud card is `pkg/sulla-desktop/components/account/SullaCloudCard.vue`; it exposes sign-in, sign-out, account status, and relay status.
- Desktop supports phone OTP, email login/register, and Apple sign-in flows through the Cloud card and auth service.
- The Use Cases tab can show the Cloud card; open it with `sulla ui/open_tab '{"mode":"use-cases"}'`. Settings use `{"mode":"settings"}`.
- Cloud sign-in does not by itself prove that every local data category is uploaded; sync is a separately controlled path in Desktop.

## Rules
- DON'T: invent Cloud pricing, quotas, retention, SLA, or tier behavior. Why: current Desktop source does not establish those claims.
- DON'T: expose Cloud JWTs, relay credentials, or vault values. Why: credentials stay in vault custody.
