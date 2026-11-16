# Legacy local-vault crypto goldens (M3 S7a)

`legacy-local-vault.json` is a frozen, synthetic Desktop vault written by **today's** code
(`LocalVaultAuthority` + `@sulla/vault-crypto`, base commit recorded in `generatedFrom.baseCommit`).
S7 moves this crypto onto `@sulla/domain`. The owner's rule is that old items, recovery codes and backups
must still open byte-for-byte, nothing gets re-encrypted, and the local `users` key row never changes on read.
These goldens are what that rule is tested against.

Everything in it is synthetic: fixed fake passwords (`secrets`), `@example.com` names, test card numbers.
No real user data.

## What it holds

| Key | Contents | Producer today |
| --- | --- | --- |
| `states.initial` | `users` row, 4 `items` rows (login rev 2, note, card, login with Bitwarden attachment metadata), `local_vault_recovery` row | first `unlockHumanSession` (creates the vault), `saveHumanItem`, `configureHumanRecovery` |
| `states.afterPasswordChange` | the same vault after `changeHumanPassword(password -> changedPassword)`: new `users` wrap/verifier/kdf plus one `local_vault_wrap_history` row (`password_change`) | `changeHumanPassword` |
| `states.legacyFlatKdf` | `initial` with `users.kdf` reshaped to the old flat `{salt, parameters}` form older builds stored. The key bytes are unchanged. | older Desktop builds (current code can't write it) |
| `backup` | `HumanBackupEnvelope` exported from `initial` with `secrets.backupPassword` | `exportHumanBackup` |
| `plaintexts` | the exact UTF-8 JSON text inside each item ciphertext | `saveHumanItem` (`JSON.stringify(item)`) |
| `userKeySha256` | sha256 of the 32-byte user key; every wrap in every state opens to it | |
| `*.userKeyMaterialSha256` | sha256 of the `users` key-material columns as Postgres returns them (canonical jsonb text) | |

Rows are stored as Postgres holds them: `bytea` as `{"$bytea": "<base64>"}`, `jsonb` as JSON and
timestamps as ISO text. `LegacyCryptoFixtureStore.seed` inserts them back byte-for-byte.

## Tests that use it

- `pkg/sulla-desktop/agent/tests/Characterization/Vault/LegacyCryptoGolden.spec.ts` runs the real
  `LocalVaultAuthority` against a real Postgres (`SULLA_TEST_DATABASE_URL` in a throwaway schema, or an
  in-process PGlite). It covers unlock, wrong password, list and reveal (exact plaintext), the `users`
  row staying byte-identical after reading, recovery, backup restore and password change.
- `pkg/sulla-desktop/agent/tests/Characterization/Vault/LegacyCryptoDomainParity.spec.ts` opens the
  same goldens with the `@sulla/domain` classes S7 will use. It's skipped unless
  `SULLA_DOMAIN_CANDIDATE_DIST` points at an extracted candidate build's `dist/index.js`, because this
  PR doesn't vendor a candidate.

```bash
yarn test:agent pkg/sulla-desktop/agent/tests/Characterization/Vault/LegacyCryptoGolden.spec.ts
SULLA_DOMAIN_CANDIDATE_DIST=/path/to/extracted/package/dist/index.js \
  yarn test:agent pkg/sulla-desktop/agent/tests/Characterization/Vault/LegacyCryptoDomainParity.spec.ts
```

## Regenerating (normally never)

Regenerating replaces every salt, nonce and key, so the new file would no longer prove anything about
vaults that already exist. Only regenerate to **add** a format, keep the old goldens in a separate file,
and explain it in the PR:

```bash
SULLA_LEGACY_CRYPTO_REGENERATE=1 yarn test:agent pkg/sulla-desktop/agent/tests/Characterization/Vault/LegacyCryptoFixtureGenerator.spec.ts
```
