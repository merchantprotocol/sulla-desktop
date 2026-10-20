# Coherent backup and restore

`sulla-files backup` creates a versioned snapshot containing PostgreSQL rows,
exact migration/schema evidence, and encrypted chunks. It never exports the
Files master key or plaintext collection keys. Incomplete upload intents and
generated previews are intentionally excluded; only chunks committed to the
database inventory are published.

Restore validates every archive path, object digest, schema fingerprint, row
count, foreign key, chunk reference, recovery bundle, and Vault principal in an
isolated disposable PostgreSQL database before touching the empty destination.
Ciphertext is staged on the destination filesystem. A database publication
marker and fsynced workspace journal make an interrupted or ambiguous commit
resumable on the next restore invocation; uncertain recovery workspaces are not
deleted.

The PostgreSQL role in `SULLA_FILES_DATABASE_URL` must have `CREATEDB` so the
isolated validation database can be created and dropped. It must currently be
`SUPERUSER` because restore uses `session_replication_role` while loading a
cycle-containing Files graph, then validates every foreign key itself. Restore
checks both attributes before staging and fails without mutating the target if
either is absent. The service image does not require `pg_dump`, `pg_restore`,
or `psql`; backup and restore use the PostgreSQL protocol through `pg`.

The Files service must remain stopped during restore. The destination database
and chunk root must be empty. A successful fresh-device restore still requires
Vault-authorized device recovery to rewrap each restored collection bundle
under the replacement device master before Files starts.

## Personal incremental backups

Phase 1 personal backups use a content-addressed object layout. Database rows,
schema evidence, and only ciphertext referenced by the Files `chunks` inventory
are immutable `objects/sha256/<prefix>/<digest>` objects; subsequent snapshots
upload only missing objects. Each snapshot is a signed manifest. Creation is
followed by manifest/object verification and an isolated PostgreSQL restore
proof. Retention defaults to 24 hourly, 30 daily, and 12 weekly snapshots, and
pruning is allowed only when a newer snapshot has both verification timestamps.

Local destinations are paths inside Lima (including external volumes exposed to
the VM). NAS destinations go through `VmNasMountHelper`: the privileged VM-side
helper obtains SMB/NFS credentials directly from Sulla Vault, mounts with
`nosuid,nodev,noexec`, returns only a mount point, and unmounts after the run.
Credentials never enter an agent shell, log, or manifest. S3 adapters reject
non-HTTPS endpoints and obtain credentials by Vault id. The production NAS and
S3 adapters remain composition points; the Files service fails closed when an
adapter is unavailable. The Mac home must never be mounted as a destination.

Account recovery escrow is deliberately separate from destination encryption.
`AccountEscrowCloudClient` uploads a versioned XChaCha20-Poly1305 envelope whose
wrapping key is derived client-side with HKDF-SHA256 from authenticated Sulla
account credential key material. Cloud stores ciphertext only. It must expose
authenticated, principal-bound PUT and GET operations for one opaque envelope:
`PUT /v1/files/account-escrow/:principalId` and
`GET /v1/files/account-escrow/:principalId`. New-device recovery signs in,
fetches the envelope, derives the same account key locally, verifies its digest,
and unwraps the collection recovery bundles. Neither endpoint may accept or
return credential key material.
