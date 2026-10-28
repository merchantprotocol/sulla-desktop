---
slug: sulla-mobile
kind: system
name: Sulla Mobile
parent: sulla
aliases: [Sulla Mobile, mobile companion, phone, PTT, mobile relay]
---

## Overview
Sulla Mobile is the signed-in companion that connects to Desktop or Cloud through the relay. Its documented surface includes Chat, Files, push-to-talk or hands-free voice, Passwords/AutoFill, and Settings. Desktop handles paired requests through its relay client and can report mobile device reachability.

## Facts
- Desktop can query paired mobile devices with `sulla mobile/list_devices '{"device_type":"mobile","online_only":true}'` when that tool is available in the live catalog.
- Desktop's relay client uses the paired Cloud identity and routes mobile work to the local agent; relay status is visible in the Cloud account card.
- Desktop has no telephony, leads, contacts, receptionist, or voicemail tools; do not infer those product surfaces from Mobile.
- Pairing identity and relay credentials are vault-controlled; never print them in a response.
