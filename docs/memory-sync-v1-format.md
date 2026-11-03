# Memory sync v1 plaintext and cryptographic format

Memory sync is end-to-end encrypted. Sulla Cloud stores only opaque record envelopes, tombstones, generations, and a MAC'd head. It never receives the memory key or plaintext.

## Keys and envelopes

Each account has one random 32-byte memory key `M`. Desktop persists `M` only wrapped by the vault `userKey`, using the same escrow boundary as the Files sync root. The head MAC key is HKDF-SHA-256 (`ikm=M`, empty salt, UTF-8 info `SVmem001`, 32 bytes).

Records use AES-256-GCM with a fresh 12-byte nonce. The 16-byte authentication tag is appended to ciphertext. `nonce` and `ciphertext` are standard padded base64. AAD is UTF-8 JSON with no whitespace:

```json
["SVmem001","cloud-user-id","observations:01J...",3]
```

Plaintext is UTF-8 JSON (maximum encrypted payload 16 KiB):

```json
{"format":1,"table":"observations","id":"01J...","value":{"id":"01J...","content":"..."},"sourceDeviceId":"desktop-id"}
```

Allowed tables are `observations`, `identity_observations`, `subject_memory.items`, `subject_memory.subjects`, and `subject_memory.overviews`. Record ids are stable `<table>:<primary-key>` strings. Overviews use `<subject>:<ts>` for their composite key. A deletion has no envelope and sets `deleted:true`; its generation is still incremented.

## State and head

`stateHash` is lowercase SHA-256 hex of compact JSON containing every current record sorted by record id: `[[id,generation,deleted],...]`. The head MAC is base64 HMAC-SHA-256 over compact JSON `[seq,stateHash,deviceId]` using the derived MAC key.

Clients verify the head MAC and reject a sequence lower than their last verified sequence. A null head is accepted only immediately after that same device completed Delete Cloud copy, or after explicit owner confirmation.

Foreign records that enable `always_on` or add `do`/`dont` policy are stored pending and remain inactive until a human confirms them. Agents cannot confirm them.
