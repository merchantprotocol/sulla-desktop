---
slug: sulla-build-a-browser-extension
label: Build, test and package a browser extension
trigger_when: When someone asks you to turn a mockup into a Chrome-compatible extension, test an extension, package it, or prepare a browser store update.
trigger_actions: [build a browser extension, package an extension, test an extension, prepare a store listing]
trigger_phrases: [build a Chrome extension from this mockup, package the extension, update the store listing, build a browser extension, test the extension, Chrome Web Store]
scope: [tool-github, tool-browser]
---

**When:** Use this for a Chromium extension repository. Sulla's browser tools can test ordinary web pages, but there is no verified tool for loading an unpacked extension into the human's own Chrome profile or uploading a store package. Be explicit about that boundary.

**Do:**
1. Read the mockup, acceptance criteria, repository rules and current extension manifest. If the UI direction is not approved, prepare mockups first; do not silently turn one interpretation into product UI.
2. Implement through `sulla-ship-a-code-change`. Use Manifest V3 unless the target store or existing repository requires otherwise. Request only permissions directly needed by the accepted behavior; document why each host permission exists.
3. Keep secrets and remote executable code out of the extension. Put user-visible strings, icons, keyboard commands and privacy disclosures in the repository's established locations.
4. Run the repository's documented checks and package command. If none exists, create a deterministic archive from the build directory with `cd '<build-directory>' && zip -X -r '/mnt/worktrees/<repo>-<branch>/artifacts/<extension>-<version>.zip' .` after verifying the directory contains only distributable files.
5. Inspect the archive without installing it: `unzip -l '/mnt/worktrees/<repo>-<branch>/artifacts/<extension>-<version>.zip'`. Confirm `manifest.json` is at the archive root and that no source maps, `.env`, keys, test fixtures, dependency directories or unrelated artifacts are included.
6. Serve testable extension pages from the repository's documented local harness or a container, then inspect them with `sulla browser/tab '{"action":"upsert","url":"http://127.0.0.1:<port>/<page>.html"}'` and `sulla browser/screenshot '{}'`. This checks rendering, not Chrome extension APIs.
7. Prepare the store title, short and long descriptions, permission explanations, privacy-policy URL, version notes, screenshots and the archive checksum: `sha256sum '/mnt/worktrees/<repo>-<branch>/artifacts/<extension>-<version>.zip'`.
8. Tell the human exactly what remains: they must load the unpacked build in a test browser profile to verify extension-only APIs and must upload or publish through the store account. Uploading or publishing posts externally and always waits for explicit approval.
9. Commit source and safe listing text, but do not commit packaged archives unless the repository explicitly tracks release artifacts. Push the PR and clean the worktree through `sulla-ship-a-code-change`.

**Check:** The manifest parses, the archive layout is correct, requested permissions match features, ordinary pages render, the checksum is recorded, and extension-only behaviors are clearly marked as human-browser testing until verified.

**Don't:**
- Don't claim Sulla loaded the extension into Chrome or completed store review; no verified tool does that.
- Don't add broad permissions to make development easier.
- Don't upload, publish, or update a store listing without the human's explicit go-ahead.
