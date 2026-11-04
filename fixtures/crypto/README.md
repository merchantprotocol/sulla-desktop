# Cryptographic known-answer fixtures

- `files-sync-v1-kat.json` → proves deterministic Sulla Files sync v1 subkey derivation, chunk encryption, manifest encryption, and head authentication; old path: `services/sulla-files/src/cloudSync/__fixtures__/files-sync-v1-kat.json`.
- `files-sync-namespace-v2-kat.json` → proves valid and rejected encrypted namespace v2 manifests, including stable IDs, metadata updates, tombstones, and restores; old path: `services/sulla-files/src/cloudSync/__fixtures__/files-sync-namespace-v2-kat.json`.
- `vault-sync-v3-kat.json` → proves byte-compatible Desktop/browser Passwords sync v3 bundles, records, and browser envelope handling; old path: `services/sulla-vault/src/browserEnvelope/vault-sync-v3-kat.json`.
- `account-auth-v1.json` → proves account-auth v1 Argon2 key derivation/authentication and vault bundle v2 recovery values; old path: `tests/fixtures/account-auth-v1.json`.
