# Sulla Vault: plan (2026-10-15)

Goal: one password vault, run by Sulla, that works the same in Desktop mode and Server mode, handles personal and organization access, and has its own browser extension so Jonathon can manage his passwords anywhere.

Clean-room rule: modeled on Bitwarden/Vaultwarden's published design (security whitepaper, org + collections model). We never copy Vaultwarden code (AGPL).

## What exists today (checked 2026-10-15)
- `VaultKeyService.ts` (772 lines): one 256-bit vault key (VMK) encrypts every `$VAULT$` value with AES-256-GCM. The master password (PBKDF2-SHA512, 210k iterations) wraps the VMK. A recovery key wraps it too. The OS keychain caches it.
- Credentials live in Postgres `integration_values`. Also present: `VaultBackupService`, autofill (`vault_autofill`), LLM access levels (`VaultLlmAccess`).
- Single user, Desktop only, no orgs, no sync, no extension.

## Target
`sulla-vault`, its own container, same image in both modes.
- **Desktop mode:** one user, runs in Desktop's Docker/k3s, unlocked with the master password. Works offline.
- **Server mode:** many users plus orgs. Desktops and extensions sync to it. RBAC.
- Two kinds of item (decided): **personal secrets** are end-to-end encrypted and never readable by the server or agents. **Agent credentials** are switched on per item or folder, and the tool catalog injects them server-side.
- Org sharing: org key wrapped to each member, shared **collections**, per-collection rights (view / use-by-agents / edit / manage). Audit log of every agent use.
- Own protocol (Proposal), because we ship our own extension. Bitwarden-app compatibility is not a goal.

## Phases
**1. Vault core (container) — first.**
- Shared crypto package (`@sulla/vault-crypto`): Argon2id key derivation, user key, item encryption, X25519 key wrapping. The same code runs in Desktop, the extension and tests.
- `sulla-vault` service: Postgres schema (users, devices, items, folders, orgs, collections, members, audit), REST API, Dockerfile, desktop/server mode switch.
- Importer: copies existing `integration_values` / `$VAULT$` credentials into the new vault. Originals are never deleted. Current LLM access levels become "agents can use".
- The old vault keeps running untouched until phase 2 switches over.

**2. Desktop switch-over.**
- The Desktop vault screens + tool catalog read from `sulla-vault`. Agent credential injection goes through it. Keychain unlock is kept.

**3. Server mode + organizations.**
- Accounts, join password, org/collections/roles, admin recovery (opt-in), audit log, Desktop ⇄ server sync.

**4. Browser extension ("Sulla Passwords").**
- Chrome first: unlock, autofill, save new logins, password generator, TOTP codes. It talks to Desktop's local vault or to the org server. Firefox/Safari and mobile autofill come later.

**5. Hardening.**
- Independent security review of the crypto + API before any org stores real company passwords in it.

## Risks
- Password managers are unforgiving: one crypto or sync bug means lost or leaked passwords. Mitigations: the importer never deletes originals, old and new vaults run side by side until verified, focused tests only where it matters (crypto round-trip, sharing, permissions — per Jonathon's test rule these qualify as security/data integrity), and the external review in phase 5.
- Extension store review (Chrome Web Store) takes time and requires privacy disclosures.
