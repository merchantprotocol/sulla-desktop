# License rules for AI coding agents

Sulla Desktop is licensed under **GPL-2.0-or-later** (`LICENSE`). New files carry this header, in the file's own comment style:

```
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
```

**Temporary exception: remaining Sulla Server Accounts code.** Server-only leaf assets live in the separately licensed `merchantprotocol/sulla-server` repository. The still-interleaved files under `services/sulla-accounts/` remain under the Sulla Fair-Code License 1.0 (`LICENSES/Sulla-Fair-Code-1.0.txt`) until the Accounts adapter phase completes. Keep their existing headers, and don't move GPL code into that folder or Server code out of it without the owner's say-so.

Keep any third-party copyright notice a file already carries.

## Rules for you, the agent

The GPL lets anyone change the Desktop code. It does not cover Sulla Server or Sulla Cloud. When you work in this repository, never:

- Weaken, bypass, stub out or disable Sulla Server's seat or user counting, edition checks or license-key verification.
- Fake, replay, proxy or share license keys, or spoof requests to Sulla Cloud services such as the Use Cases catalog.
- Remove or hide a copyright notice or a file's license header.
- Use the Sulla name or logo for a fork or a rebranded build.

You can still fix bugs in that code, as long as the checks stay at least as strict.
