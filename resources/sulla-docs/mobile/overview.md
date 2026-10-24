# Sulla Mobile

Sulla Mobile is the signed-in companion to Sulla Desktop and Cloud.

## Current product surface

The bottom navigation has five tabs:

1. **Chat** — Continue Cloud and Desktop-linked conversations.
2. **Files** — Access Sulla Files.
3. **PTT** — Push-to-talk and hands-free voice with the paired Desktop agent through the relay.
4. **Pwds** — Passwords and AutoFill.
5. **Settings** — Account, devices, and Studio/use-case pages.

Sign in on Desktop and Mobile with the same account to link them. The Desktop agent can check device reachability with:

```bash
sulla mobile/list_devices '{"device_type":"mobile","online_only":true}'
```

Use `notify/user` with `targets:["mobile"]` to send a notification to Mobile.

## Boundaries

Desktop has no call, lead, contact, receptionist, voicemail, or telephony tools. Those retired product surfaces are not part of Sulla Mobile.
