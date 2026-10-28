---
slug: sulla-manage-extensions
label: Install and manage Sulla extensions
trigger_when: When a user wants to find, install, start, stop, update, or inspect an extension.
trigger_actions: [find extension, install extension, start recipe, stop recipe]
trigger_phrases: [install extension, marketplace, recipe, is it running]
scope: [sulla-marketplace]
---

**Do:**
1. Find candidates with `sulla extensions/list_extension_catalog '{"query":"<term>"}'`.
2. Inspect installed items with `sulla extensions/list_installed_extensions '{}'` and status with `sulla extensions/get_extension_status '{"id":"<id>"}'`.
3. Install with `sulla extensions/install_extension '{"id":"<catalog-id>"}'`.
4. Start or stop with `sulla extensions/start_extension '{"id":"<id>"}'` or `sulla extensions/stop_extension '{"id":"<id>","confirm":true}'`.
5. Keep data on uninstall unless the human explicitly confirms destructive deletion.

**Don't:**
- guess an extension id or claim a service is running without a status result.
