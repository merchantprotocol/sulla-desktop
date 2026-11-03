# Memory sync v1 plaintext and cryptographic format

Memory sync is end-to-end encrypted. Sulla Cloud stores only opaque record envelopes, tombstones, generations, and a MAC'd head. It never receives the memory key or plaintext.

## Keys and envelopes

Each account has one random 32-byte memory key `M`, shared by every signed-in device. The first device generates it; later devices restore it. Cloud stores the wrapped value in `memory_sync_key_slots`, never `M` or the vault `userKey`. `PUT /memory-sync/v1/key-slot` is create-only: on a first-writer race the loser receives `409 key_slot_exists` with the winner's `wrappedKey` and must discard its proposed key and unwrap the winner. There is no overwrite or rotation operation in v1.

`wrappedKey` is standard padded base64 of `nonce || ciphertext || tag`: a fresh 12-byte nonce followed by AES-256-GCM output for the raw 32 bytes of `M` (the 16-byte tag is appended by AES-GCM). The wrapping key is the account's 32-byte zero-knowledge vault `userKey`. AAD is UTF-8 `SVmemkey001|<cloud-user-id>`. The resulting decoded blob is exactly 60 bytes. Unwrapping with another account's `userKey`, another user id, or modified bytes must fail authentication. Desktop requests wrap/unwrap from the local vault container through the Desktop-authenticated `/v1/memory-sync/wrap-key` and `/v1/memory-sync/unwrap-key` endpoints; Desktop main and Cloud never receive `userKey`. Mobile must perform the identical operation inside its signed-in vault boundary. If that boundary is unavailable, clients wait for the vault and neither generate a device-only key nor upload plaintext.

The head MAC key is HKDF-SHA-256 (`ikm=M`, empty salt, UTF-8 info `SVmem001`, 32 bytes).

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
