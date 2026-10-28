---
slug: sulla-install-from-marketplace
label: Install from the Sulla Marketplace
trigger_when: When you need to search, inspect, download, overwrite, or manage a marketplace artifact.
trigger_actions: [search marketplace, install marketplace artifact, download use case]
trigger_phrases: [marketplace, catalog, install add-on, download use case]
scope: [sulla-marketplace]
---

**Do:**
1. Search with `sulla marketplace/search '{"query":"<terms>","kind":"<kind>","limit":25}'`.
2. Inspect with `sulla marketplace/info '{"kind":"<kind>","slug":"<slug>"}'`.
3. Download with `sulla marketplace/download '{"kind":"<kind>","slug":"<slug>","overwrite":false}'`.
4. Validate the installed artifact and verify its status before using it.
5. Manage extension processes with `sulla extensions/list_installed_extensions`, `start_extension`, `stop_extension`, or `uninstall_extension`; never delete data without explicit approval.

**Don't:** claim a catalog listing is trusted or live without verification.
