# Files authority and key custody

This contract defines the Files authority boundary for desktop and server deployments. Implementation and deployment must be checked separately; the presence of this document does not establish that an installed application has been rebuilt.

## Ownership

The Files service owns collection keys, encrypted storage, file metadata and versions, access checks, sharing, indexing, migration, recovery decisions, and its ready/locked state. Desktop, chat, agents and other integrations call its authenticated API. Desktop and server interfaces share Files UI code and API response mappings.

Native adapters may show file dialogs, capture media, watch explicitly configured host folders and open authorized downloads in native applications. They must not implement a second encrypted store, unwrap collection keys, or decide how to recover a failed Files startup. General development tools are separate from this managed file store.

## File Manager tree and agent mount

The File Manager namespace is the path authority. The Files FUSE adapter exposes
that same namespace at `/mnt/sulla-files`: the default Files collection maps to
the mount root, while existing non-default collections retain an additive,
stable `collections.explorer_path` mapping. The mapping does not rewrite file,
version, share, history, or native-source rows. A path such as
`Clients/Acme/contract.pdf` in File Manager is therefore the same path at
`/mnt/sulla-files/Clients/Acme/contract.pdf`; agents must not add a collection
directory of their own.

The mount supports reads, writes, empty-file creation, `mkdir`, file and folder
rename/move (including authorized cross-collection moves), `unlink`, and empty
`rmdir`. Mutations call the authenticated Files service. File/folder moves use
the durable operation coordinator, tracked-host mutations keep native custody,
and deletes enter Files history/Trash rather than bypassing it. Directory reads
refresh from Files with zero attribute/entry cache timeout, so File Manager and
mount changes converge on the next lookup.

Paths are canonical relative POSIX paths. Absolute paths, empty components,
`.`/`..`, backslashes, protected wallet/vault names, symlink traversal, and raw
host paths are rejected. The Files bearer token remains mandatory between the
FUSE adapter and service. Crypto-wallet data is never admitted to the tree.

## Desktop bootstrap

The native bootstrap helper runs in an isolated process before the ordinary Desktop module graph loads. It unwraps OS-protected Files material and sends it directly to the authenticated Files service. The Desktop parent receives status only. The Files master and bootstrap identity are distinct from Vault secrets.

The handoff must authenticate both ends, bind the destination and caller, expire quickly, reject replay, and encrypt the key payload. Certificate verification must remain enabled with the provisioned Files identity. A local API token alone is not sufficient protection for transporting a plaintext master key.

Files decides whether an existing master is usable, whether an empty store may be initialized, or whether complete authorized recovery is available. Missing OS material with existing encrypted data must never trigger an unconditional replacement key. Initialization failures must remain distinguishable from verifier rejection; a failed database query or ownership migration is not a reason to replace a master key.

Lock invalidates outstanding bootstrap work and clears live keys. A late asynchronous startup completion must not make a locked service ready again.

## Collection envelopes and migration

Files generates collection data and deduplication keys and persists authenticated envelopes. The master protects those envelopes. Vault may authenticate a principal and hold authorized recovery envelopes, while Files owns their use in file lifecycle operations.

Existing content ciphertext and working collection keys must survive migration. Where a supported historical scheme derived collection keys from a signing secret, migration wraps those same keys without changing their value. Unknown or inconsistent historical state must remain preserved and produce a bounded error. Recovery requires a complete, context-verified key set before committing replacement envelopes. If the canonical OS master is missing and only historical legacy archives remain, automatic bootstrap refuses fresh-key creation. Preserve the archives and restore the original protected master or use an explicitly supported recovery procedure; do not delete key state to make startup pass.

Desktop principal adoption is limited to legacy desktop-user collections. Other collection owners, access grants and recovery bundles remain unchanged. Share-link owner changes are limited to the collections actually adopted.

Server deployments use the same Files envelope keyring and file-management core. Their master provisioning mechanism may differ from the native OS helper, but must not turn authentication signing credentials into new content-encryption keys.

## Verification and operation

Use synthetic collections and isolated databases to verify envelope preservation, principal isolation, invalid key rejection, replay and expiry, lock/startup races, restart persistence, and migration rollback. Use nonsecret status for live diagnosis. Never print key material, transport credentials, decrypted file contents, or live wallet data.

Rebuild both the Files service and Desktop when their bootstrap contract changes. Preserve the previous deployment and encrypted state until the new pair has passed acceptance. Record the exact source and image revisions; a merged change alone does not prove that the running application uses it.
