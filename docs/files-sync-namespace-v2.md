# Files sync namespace v2

This is the shared client contract for Goal N. It is additive to the byte-exact v1 crypto envelopes. The
existing `files-sync-v1-kat.json` is copied unchanged (SHA-256
`30664cfd01c996a999c6fce0bae79481794292d23d0255ce25f20df4e33e752c`). Namespace plaintext exists only
inside the authenticated `sulla-files-sync-manifest` ciphertext. Names, MIME values and parent IDs are never
transport fields, logs, indexes or Worker-readable columns.

## Opened manifest

Clients MUST emit the exact v2 object accepted by `validateNamespaceManifest` and proven by
`files-sync-namespace-v2-kat.json`. `itemId` equals the outer commit `fileId` forever. `parentFolderId` is an
encrypted UUID or `null` for the collection root; paths are derived client-side and are not identities.
Folders have `size:0`, `sha256:null`, `mime:null`, and `chunks:[]`, preserving the v1/Goal-M folder form.
For live files, the plaintext byte lengths in `chunks` sum exactly to `size`. A create has
`parentVersionId:null`; every successor operation (`content`, `metadata`, `delete`, or `restore`) names its
authenticated predecessor.

This contract is deliberately additive. Existing v1 and Goal-M manifests remain readable and visible through
their current adapters; clients MUST select validation by the decrypted manifest version. They MUST NOT run the
strict v2 validator over legacy plaintext or hide an item merely because it is not v2. Blanket v2 enforcement is
only safe after that client ships an explicit, authenticated legacy-to-v2 adapter and migration path.

Rename and move create `operation:"metadata"` versions and reuse the current chunk IDs without an upload.
Delete appends a zero-payload `operation:"delete"` tombstone; it does not erase history. Restore appends a
fresh version on the same item, CASes against the current `baseVersionId`, names the immutable source in
`restoredFromVersionId`, and may reuse that source's chunk IDs without uploading plaintext. The outer signed
commit independently binds `fileId`, `baseVersionId`, `deleted`, and ordered `chunkIds`.

The Worker validates envelopes, signatures, chunk presence, global head CAS and per-item `baseVersionId` CAS.
It cannot decrypt or validate names, parents, kinds, descendants, or tree cycles. Every projection MUST run
the shared plaintext validator after authenticated decryption and before displaying or committing an item.

## Recursive delete

Recursive delete uses optional signed commit `batch` metadata:

`{batchId,type:"recursive-delete",rootItemId,index,final}`

Each commit remains atomic, is limited to 256 distinct item versions, and is already covered by the writer's
body signature. Index starts at zero and advances by one; the Worker durably records the last committed index,
so a client can query batch status and resume after interruption. Every version in such a batch MUST be a
tombstone. `final:true` only says the signed enumeration finished; it is not server proof of tree completeness.

Because topology is encrypted, the initiating client enumerates a verified local snapshot. A child concurrently
created or moved under the folder after that snapshot is not implicitly deleted. After the final batch, the
client pulls changes, decrypts the subtree again, and starts another batch for any live descendants until its
verified projection is stable. Offline clients converge from retained tombstone versions and must not resurrect
them. No endpoint deletes user bytes or versions as part of namespace deletion.

## Resume notes

- **Done:** shared v2 plaintext schema/validator, additive KAT, signed bounded recursive-batch transport,
  per-item CAS semantics and retained tombstone/restore contract.
- **Next:** Goal N client PRs copy the fixture and helper semantics, seal/open v2 manifests, project the tree,
  and implement stable-snapshot recursive enumeration. Goal M branches remain untouched.
- **Job:** `agent-job-1793743672013-34`.
