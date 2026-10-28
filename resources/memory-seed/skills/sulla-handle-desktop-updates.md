---
slug: sulla-handle-desktop-updates
label: Handle Sulla Desktop updates and restarts
trigger_when: When the human asks about checking, downloading, installing, or troubleshooting a Sulla Desktop update or restart.
trigger_actions: [check for updates, explain update status, install an update, restart Desktop]
trigger_phrases: [update Sulla, check for updates, install update, restart Sulla Desktop, new version]
scope: [sulla-desktop]
---

**When:** Work with the app's user-controlled update flow.

**Do:**
1. Verify live state before naming the installed or available version.
2. Direct the human to **Check for Updates…** or the Updates window. There is no agent update category.
3. Preserve and push active agent work before any restart.
4. Wait for the human's tap before installation, quit, or restart.
5. After relaunch, verify the running version and affected services.

**Don't:**
- Don't call an invented `update/*` tool.
- Don't force `quitAndInstall`, quit, or restart while work is active.
- Don't infer update availability from a source document or tray badge alone.
