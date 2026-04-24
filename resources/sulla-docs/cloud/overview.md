# Sulla Cloud

The agent should be able to explain Sulla Cloud accurately without inventing features. Pilot phase: first paying customer targeted June 15, 2026. Treat anything not in this doc as "I don't know — let me check."

## Two products, one ecosystem

| Product | Price | Where it runs | API keys | Audience |
|---------|-------|---------------|---------|----------|
| **Sulla Desktop** | Free, open-source | User's machine (Lima VM on macOS/Linux) | User brings own | Anyone — privacy-focused, self-hosters, builders |
| **Sulla Cloud** | Paid (see tiers below) | Sulla's managed infrastructure | Included | Users who don't want to self-host |

**Desktop is the product. Cloud is the convenience tier.** Desktop is never crippled to push users to Cloud — every feature ships to both.

## What Cloud actually offers (today)

**Managed compute** — agent execution runs on Sulla's servers, not the user's machine. Useful when the laptop is closed.

**Hosted models** — Claude access on Sulla's Anthropic key. No BYOK required. (BYOK-vs-managed details for Cloud customers are not yet documented; do not promise specifics.)

**Cloud relay** — WebSocket relay on Cloudflare Workers (`wss://sulla-workers.jonathon-44b.workers.dev`). Powers:
- Mobile↔Desktop pairing — Sulla Mobile sends work requests to a paired Cloud instance
- Continuity when the user's laptop is offline — messages route through the relay to the cloud-hosted agent
- Room-based architecture (room = user_id; HS256 JWT auth)

**Multi-device sync** — routines, vault credentials, and state can sync across paired devices through the cloud relay (Desktop v1.3.x+).

**Secretary mode** — local meeting transcription + auto-extracted action items is **shipped today** (`Cmd+Shift+S` to start; see `desktop/secretary-mode.md`). The Cloud-routed Phase 2 — handling incoming conversations regardless of whether the user's machine is on — is the aspirational extension. The wiring (gateway sessions + desktop relay to Cloudflare Workers) is in place.

**Threat-proxy URL filtering** — Quad9/URLhaus/SafeBrowsing/VT scanning. Available in both Desktop and Cloud, but bundled as a value driver in Enterprise Gateway.

## Pricing tiers (current targets)

| Tier | Price | Audience | Status |
|------|-------|---------|--------|
| Premium Support | $19/mo | Desktop users wanting enhanced support | Aspirational, not yet marketed |
| Enterprise Gateway | $99/mo | Small businesses (2–50 employees) wanting bundled AI + network security with no IT department | Pilot |

**Do not invent pricing beyond these tiers.** If asked about team seats, usage caps, SLA, retention, or per-user limits — say it's not yet documented and offer to check with Jonathon.

## Mobile pairing — phases

- **Phase 1 (current):** manual pairing — copy mobile user_id into Language Model Settings
- **Phase 2 (planned):** QR-code pairing

Pairing lets Sulla Mobile send work to a paired Cloud (or Desktop) instance. The agent executes there and returns results to the mobile device.

## When to bring up Cloud in conversation

**Recommend Cloud when:**
- "I want Sulla running when my laptop is closed"
- "I want my phone and laptop in sync"
- "I don't want to manage API keys"
- Team / business / multi-user use cases

**Stay on Desktop when:**
- First-time user exploring Sulla
- Privacy / data-sovereignty is the primary concern
- User already has Anthropic/OpenAI keys
- Cost-sensitive (Desktop is free)

## What the agent does NOT have

- No tool to provision a Cloud account
- No tool to upgrade tier from inside the app (sign-in / sign-out exists via SullaCloudCard UI in settings, but billing/tier change is out-of-band)
- No live billing or usage telemetry tools

If a user wants to sign up, point them to the SullaCloudCard in settings (sign-in flow exists) and let Jonathon handle the rest.

## Hard "do nots"

- Never invent quotas, retention windows, or SLA commitments
- Never claim Desktop is feature-limited vs Cloud — it isn't
- Never expose the user's Cloud JWT or relay credentials in chat output
- Never promise a feature ships by a date unless that date is in `~/sulla/identity/business/goals.md`

## Reference

- Business model summary: `~/.claude/projects/-Users-jonathonbyrdziak-Sites/memory/project_sulla_business_model.md`
- Relay architecture: `~/.claude/projects/-Users-jonathonbyrdziak-Sites/memory/project_sulla_relay_architecture.md`
- Desktop vs Cloud: `~/Sites/sulla/docs/desktop-vs-cloud.md` (if present)
- Identity / goals: `~/sulla/identity/business/identity.md`, `~/sulla/identity/business/goals.md`
