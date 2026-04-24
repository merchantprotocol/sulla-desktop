# Sulla Mobile

The iOS/Android companion app. **Primary use case: AI iPhone receptionist for service businesses.** Customers call your business number, an AI agent answers, takes the call, transcribes, extracts a lead, and pushes it to your phone in real time.

Codebase: `/Users/jonathonbyrdziak/Sites/sulla/sulla-mobile` (Expo / React Native, v1.0.0, iOS build 19).

## What it actually does

### The receptionist
Customers dial your provisioned **Twilio number**. **ElevenLabs Conversational AI** answers using your business profile (greeting, hours, services, knowledge base). The conversation is transcribed live and analyzed post-call to extract lead intent, urgency, and contact info.

### The five tabs (bottom nav)

1. **Contacts (Inbox)** — Leads extracted from each call. Sorted by urgency. Filter by status. Tap for full call detail with transcript + AI summary + extracted fields (intent, address, service type, estimated value, callback method).

2. **Messages** — SMS messages and voicemail transcripts. Unread badge.

3. **Sulla** (center button) — **Push-to-Talk (PTT) chat with the AI.** Long-hold the Sulla button → speak → released. Transcript routes through the **Cloudflare Workers relay** (`wss://sulla-workers.jonathon-44b.workers.dev/relay/{room_id}`) to a paired Sulla Desktop, which processes the request and streams the answer back. Hands-free conversation with your desktop AI from anywhere.

4. **Recents** — Call history. Active calls show a green "LIVE NOW" badge with real-time transcript streaming via WebSocket to `/calls/bridge/{callId}`. Usage stats: minutes this month, average duration, cost breakdown.

5. **Settings** — Account, business profile, knowledge base, phone number management, subscription, devices.

### Live call takeover
While a call is in progress (visible in Recents):
- Mobile user sees the transcript stream in real time
- Tap **"Take Over Call"** → POST `/calls/{callId}/transfer` → warm transfer to your personal phone number → AI hands off and you're on the line

### Knowledge base (teaches the AI)
Six categories: **Services, Service Area, Business Info, FAQ, Policies, Team.** WYSIWYG markdown editor. Changes sync to the server and update the AI's prompt in real time. The next caller hears an AI that knows the new info.

### Lead extraction
Post-call, the system runs xAI Grok against the transcript to extract:
- Qualified-lead flag
- Caller intent / urgency
- Address, service type, description
- Estimated value
- Preferred callback method

Drops into the Inbox.

## Pairing with Desktop

There's no QR code yet (planned Phase 2). Today: **sign in on both Desktop and Mobile with the same account.** The server assigns the same `contractor_id` to both, and they sync via `/sync/{contractor_id}`.

Pairing enables:
- Live call data shared across both devices
- Inbox / messages / knowledge base in sync
- Mobile PTT → Desktop AI via WebSocket relay (the killer cross-device feature)

## Auth model

Three options, any can authenticate to the same account:

1. **Phone OTP** (primary) — POST `/auth/otp/send` → SMS code → `/auth/otp/verify` → returns `accessToken` (15-min) + `refreshToken` (30-day), stored in `expo-secure-store` (iOS Secure Enclave)
2. **Apple Sign-In** (App Store requirement)
3. **Email + password** (fallback)

## Subscription model

Apple IAP only. Two tiers (separate from Sulla Cloud pricing):

| Plan | Price | Included |
|------|-------|----------|
| Starter | $49.99/mo | 100 receptionist minutes |
| Pro | $99.99/mo | 250 receptionist minutes |

Plus credit packs (50 / 100 / 250 min) — requires an active subscription to purchase.

## Backend

- **API:** `https://sulla-workers.jonathon-44b.workers.dev` (Cloudflare Workers, D1 database, R2 blob storage, Durable Objects for the relay)
- **Twilio** — phone provisioning, call routing, SMS
- **ElevenLabs** — Conversational AI (the receptionist voice + understanding)
- **xAI Grok** — website scraping (auto-populate business info), post-call lead extraction
- **Apple** — Sign-In, IAP, push (APNs)

## Architecture quick reference

- **Routing:** Expo Router (file-based, `/app/`)
- **State:** SQLite (`expo-sqlite`) offline-first + sync queue against `/sync` endpoint
- **Real-time:** WebSocket per active call (`/calls/bridge/{callId}`); persistent `DesktopRelaySession` for PTT
- **Push:** APNs via expo-notifications

## Build & distribution

**Manual builds — no CI for mobile** (per user feedback memory). Steps:
1. `just build` (in `/Users/jonathonbyrdziak/Sites/sulla/sulla-mobile/`) — clean rebuild: nuke ios/, npm install, `expo prebuild --platform ios`, `pod install`, opens Xcode
2. Archive in Xcode
3. Upload to App Store Connect for TestFlight or review

**Currently:** TestFlight available, App Store submission imminent. Android codebase exists but not yet on Google Play.

## What works today vs what's planned

### Shipped
- Phone OTP / Apple Sign-In / email auth
- Real-time call monitoring + transcript streaming
- Call takeover (warm transfer to personal phone)
- Inbox with lead extraction, urgency sort, read/dismiss state
- Messages (SMS + voicemail transcripts)
- Recents with usage stats (minutes, cost)
- Push-to-Talk → Desktop relay
- Knowledge Base (6 categories, WYSIWYG editor, syncs)
- Twilio number provisioning (area code search, buy, configure)
- Apple IAP subscriptions + credit packs
- Devices view (all signed-in devices, online status)
- Account deletion (App Store requirement)
- Push notifications (new leads, test results)

### Planned
- QR code pairing (Phase 2)
- Android on Google Play
- Call recording playback in UI (infra ready)
- Multi-language AI

### Limitations
- BlackHole / system audio capture broken on macOS 15 (this is a Desktop limitation, but affects mobile↔desktop voice features)
- Midwest timezone hardcoded in some business hour templates
- Recordings stored on R2 but mobile can't download/share for compliance reasons

## When the user asks about Sulla Mobile

- **"What does Sulla Mobile do?"** → AI iPhone receptionist + companion to Desktop. Lead with the receptionist value, not the chat features.
- **"How do I pair my phone?"** → Sign in on both with the same account. No QR yet.
- **"Show me my last call"** → No agent tool wraps the mobile API today. Tell them to open the Recents tab on their phone.
- **"How much does it cost?"** → $49.99 Starter (100 min) or $99.99 Pro (250 min). Don't conflate with Sulla Cloud's $99/mo Enterprise Gateway — different products.
- **"Where do I download it?"** → TestFlight (currently). App Store submission imminent.
- **"Can I record a call?"** → Recording happens automatically on the backend. UI playback is planned, not yet shipped.

## What the agent can NOT do for Sulla Mobile

- No tool to query mobile call history from Desktop chat
- No tool to send a notification to the paired phone (`notify_user` is desktop-only)
- No tool to manage the Twilio number from Desktop chat
- No tool to update the knowledge base from Desktop chat
- No file transfer between Desktop and Mobile

If the user wants any of the above, point them to the mobile app or flag it for Jonathon.

## Reference

- App entry: `/Users/jonathonbyrdziak/Sites/sulla/sulla-mobile/app/`
- Live call context: `src/context/LiveCallContext.tsx`
- WebSocket service: `src/services/WebSocketService.ts`
- Auth: `src/services/AuthService.ts`
- Desktop relay: `src/services/desktop-relay.ts`
- Sync: `src/context/SyncContext.tsx`
- Config: `src/constants/Config.ts`
- Build commands: `/Users/jonathonbyrdziak/Sites/sulla/sulla-mobile/justfile`
