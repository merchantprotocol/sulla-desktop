---
slug: sulla-check-host-capabilities
label: Check unsupported host-control requests honestly
trigger_when: When the human asks Sulla to control Chrome tabs, inspect macOS Accessibility permissions, or control a smart TV.
trigger_actions: [control Chrome tabs, inspect Accessibility permissions, control smart TV, check unsupported capability]
trigger_phrases: [control my Chrome tabs, set up my Chrome, which apps have Accessibility permission, control my smart TV, can Sulla do this]
scope: [sulla-tools, sulla-vm]
---

**When:** Verify the live catalog before declaring a capability unavailable.

**Do:**
1. Search the catalog: `sulla meta/browse_tools '{"query":"<requested capability>"}'`.
2. If a matching tool exists, use its exact manifest and safe approval gates.
3. Otherwise explain the specific boundary: Sulla's browser tools control its built-in browser, not the human's Chrome tabs; there is no catalog tool to read macOS Accessibility permission state; smart-TV control is not shipped.
4. Offer the honest route: the human can use Chrome/TV controls or connect a documented integration. Do not claim `exechost`, AppleScript, or a generic shell can bypass these boundaries.

**Check:** Include the catalog search result and the narrow limitation, not a blanket claim about all host control.

**Cleanup:** No changes are needed for a capability check.

**Traps:** An old subject or doc may be stale. Search first; never invent a tool or silently drive an unrelated app.
