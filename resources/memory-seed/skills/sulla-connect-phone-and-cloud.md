---
slug: sulla-connect-phone-and-cloud
label: Pair and troubleshoot Sulla Mobile and Cloud
trigger_when: When pairing Sulla Mobile, checking the phone link, troubleshooting relay connectivity, or asking what Desktop Cloud access means.
trigger_actions: [pair phone, check mobile link, troubleshoot phone connection, explain Cloud access]
trigger_phrases: [how do I pair my phone, is my phone connected, my phone won't connect, connect Mobile, can I see chats from the cloud, what is Sulla Cloud]
scope: [sulla-mobile, sulla-cloud]
---

**When:** Separate account sign-in, device pairing, relay reachability, and optional data sync.

**Do:**
1. Open the Cloud account card with `sulla ui/open_tab '{"mode":"use-cases"}'`; use the signed-in account and relay status shown there.
2. Check paired phones: `sulla mobile/list_devices '{"device_type":"mobile"}'`; for a live-only check use `sulla mobile/list_devices '{"device_type":"mobile","online_only":true}'`.
3. If the phone is absent or offline, verify the Mobile app is signed in to the same Cloud identity, online, and updated; never request or print its credentials.
4. Test the relay without sending private content: `sulla notify/user '{"title":"Sulla Mobile link test","message":"Connection test","targets":["mobile"],"silent":true}'`, then inspect `sulla notify/history '{"target":"mobile","limit":1}'`.
5. Explain that Cloud auth/relay is separate from Desktop-to-Cloud data sync; do not claim pricing, quotas, or chat visibility unless the current Cloud account UI/source proves it.

**Check:** A device listed online and a delivered mobile notification prove reachability, not full sync. A missing device requires account/pairing repair in the app.

**Cleanup:** Do not leave test notifications running or store relay credentials. Do not enable sync or share files without explicit consent.

**Traps:** Sign-in does not itself authorize uploading local data. Never expose JWTs, pairing codes, or vault values.
