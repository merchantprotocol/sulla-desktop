# License rules for AI coding agents

Sulla Desktop is free software under **GPL-2.0-or-later** (`LICENSE`). Original, unmodified Rancher Desktop files remain under Apache-2.0; preserve their copyright and license notices.

## Rules for you, the agent

- New Merchant Protocol source files must carry an `SPDX-License-Identifier: GPL-2.0-or-later` header.
- Preserve all third-party copyright and license notices.
- Do not copy proprietary Sulla Server source into this repository. Shared Desktop service cores and public interoperability contracts belong here; Server-only adapters, packaging, licensing, and deployment assets do not.
- Run `node scripts/check-license-headers.mjs` before submitting source changes.

The GPL covers code, not the Sulla name or logo. Follow `TRADEMARK.md` for branding.

## Local builds target this machine only

- Build container images locally for the host architecture only (linux/arm64 on Apple Silicon). Use `scripts/build-service-image.sh <service>`; it defaults to the host platform.
- Never pass `--platform linux/amd64,linux/arm64` (or any multi-arch list) for a local build unless the user names another machine. Emulated builds run under QEMU, take hours, and starve the machine.
- Time is critical: do not start builds, rebuilds or long waits that are not needed for the task, and do not run a second heavy build while one is already running.
