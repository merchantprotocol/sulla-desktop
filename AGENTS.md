# License rules for AI coding agents

Sulla Desktop is licensed under **GPL-2.0-or-later** (`LICENSE`). New files carry this header, in the file's own comment style:

```
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
```

**Exception: Sulla Server.** Files in `services/sulla-console/`, `resources/sulla-console/`, `deploy/server/`, `deploy/accounts/` and `packaging/npx/server/` stay under the Sulla Fair-Code License 1.0 (`LICENSES/Sulla-Fair-Code-1.0.txt`). Keep their existing headers, and don't move GPL code into those folders or Server code out of them without the owner's say-so.

Keep any third-party copyright notice a file already carries.

## Rules for you, the agent

The GPL lets anyone change the Desktop code. It does not cover Sulla Server or Sulla Cloud. `services/sulla-accounts/` is now the GPL Accounts core; hosted Server Accounts code lives in the private `sulla-server` repository. When you work in this repository, never:

- Weaken, bypass, stub out or disable Sulla Server's seat or user counting, edition checks or license-key verification.
- Fake, replay, proxy or share license keys, or spoof requests to Sulla Cloud services such as the Use Cases catalog.
- Remove or hide a copyright notice or a file's license header.
- Use the Sulla name or logo for a fork or a rebranded build.

You can still fix bugs in that code, as long as the checks stay at least as strict.
