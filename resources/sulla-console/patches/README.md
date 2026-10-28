<!--
  Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
  Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.
-->

# Server patches on Sulla Cloud's frontend

`scripts/sync-cloud-console.mjs` applies these to www-sulladesktop at the commit pinned in
`../cloud-vendor.json`, in file-name order, then copies the result into `../public/` and builds the
vault origin into `services/sulla-vault/browser-dist/`. Paths are www-sulladesktop paths
(`cloud/index.html`, `js/cloud/shell/shell.js`), so a patch can also be applied in that repo
directly. They started from the approved mockup's diff (2026-10-24).

| Patch | What it changes |
|---|---|
| `01-brand` | "Sulla Server" instead of "Sulla Cloud" on Home, Devices, Agents, Workflows, Editor, Organizations |
| `02-no-billing` | Organization settings: no Plan & billing or Servers & licenses; Usage & limits shows the server's token caps |
| `03-server-settings-nav` | Shell: the Server administration settings nav (server admins only), server brand and host, invite-only sign-in card; no style attributes on the vault origin |
| `04-org-files-label` | Files: "Files" (the organization's), served by this server; no Cloud encrypted-backup button |
| `05-use-cases-license` | Use Cases: locked when the server license isn't active (`public/server/license.js`) |
| `06-vault-copy` | Passwords: organization-vault copy; the vault-origin build takes the console URL as a runtime placeholder |
| `07-account-sections` | Account settings: server sign-in methods, no Apple |
| `08-chat-hide-heartbeat` | Chat: server copy; the heartbeat control is hidden on server chats until the backend exists |
| `09-html-shells` | Every page loads `server/server-auth.js` instead of `js/sulla-auth.js`, self-hosted fonts, relative paths |
| `10-vault-server-setup` | Passwords on a server: first unlock enrolls the member (`/vaults/:id/enrollment` → MAC in the worker → `PUT ?op=create` or `?op=rewrap`); the console launcher opens the vault page when `status.setup` is set |
| `11-vault-shared-collections` | Passwords on a server: shared collections (`bundle?include=collections`, `records?scope=<collectionId>`) verified and decrypted in the worker, listed as folders, read-only for now |

Lines Cloud keeps editing (for example the one-line-per-function `organization-settings.js`) are
left byte-identical and overridden in a small block at the end of the file instead, so pin bumps
merge cleanly.

## Bump the pin

```bash
node scripts/sync-cloud-console.mjs --repo ../www-sulladesktop --ref origin/main --dry-run   # which patches still apply
node scripts/sync-cloud-console.mjs --repo ../www-sulladesktop --ref <sha>                    # re-vendor and re-pin
node scripts/sync-cloud-console.mjs --repo ../www-sulladesktop --check                       # what CI runs
```

New `cloud/*.html` pages upstream are vendored automatically unless listed under `exclude`.

## Change a patch

In a www-sulladesktop checkout at the pinned commit, apply the patches one at a time and commit
each, edit, then write each patch back as the diff between consecutive commits:

```bash
git checkout --detach <pin>
for p in <sulla-desktop>/resources/sulla-console/patches/*.patch; do git apply --index "$p" && git commit -qm "$(basename "$p")"; done
# edit, commit (or amend the right commit with rebase), then for patch N:
git diff --full-index <commit N-1> <commit N> > <sulla-desktop>/resources/sulla-console/patches/NN-topic.patch
```

Then run the sync script without `--check` to re-vendor and record the new hashes.
