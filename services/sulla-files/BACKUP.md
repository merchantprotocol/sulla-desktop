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

Local destinations are single subfolder names under the persistent Sulla VM disk
`/mnt/sulla-backups`, propagated read/write into Files at
`/var/lib/sulla-files-backups` with `rslave`. This protects against accidental
changes, **not loss of the computer or VM disk**. No Mac host folder is mounted.
Each destination has its own object namespace so pruning cannot affect another
destination that points at the same disk, share, or bucket.

Desktop mounts NAS shares inside Sulla VM at `/mnt/sulla-backups/nas-<id>` using
`mount -t cifs` or `mount -t nfs` with `nosuid,nodev,noexec`. Enter an
`smb://server/share` or `nfs://server/export` URL. NFS exports must permit the
Files UID/GID to write; SMB maps ownership to that UID/GID. Mounts are reused
between runs and unmounted before a destination is removed. Removal deletes
configuration/history only, never objects or manifests on the destination.
Files checks that a real NAS mount propagated before writing; it does not
silently write into an unmounted directory.

Create a personal Vault item and enter its UUID as the credential ID. The item
must contain string fields/custom fields `backup_kind` (`nas` or `s3`) and
`backup_target` (the exact configured share URL or HTTPS endpoint). This binding
is required before a backup-specific service identity can receive credentials.
SMB uses username/password and optional domain; its root-only `0600` credentials
file is transferred through stdin inside Sulla VM and deleted immediately after
mount. It is never put in command arguments or logs. NFS needs no credential
item. S3 uses `accessKeyId`, `secretAccessKey`, and optional `sessionToken`.
Set the S3 signing region when it is not `us-east-1`. The Files service resolves S3 credentials through its pinned, authenticated
Vault authority connection and uses `@aws-sdk/client-s3`; HTTPS is mandatory.
Credentials are held only for the operation, never in destination configuration,
run errors, or manifests.

In desktop mode the personal scheduler first ticks three minutes after boot,
then hourly while Files is unlocked. Manual runs return HTTP 202 and a run ID;
Preferences polls while a run is running. Every run creates an hourly snapshot.
The first successful run of each UTC day and ISO week also publishes independently
signed daily/weekly manifests of the same restore-verified bytes. A PostgreSQL
advisory lock prevents concurrent runs/removal for the same destination.
Retention uses 24 hourly, 30 daily, and 12 weekly snapshots. A newer snapshot
must pass both manifest and isolated-restore verification before pruning starts.
Prune tombstones and an object-GC queue make interrupted cleanup retryable;
objects are deleted only when no retained manifest references them. Desktop
polls for failure transitions and sends one notification until a destination
successfully recovers. Transport error details are not persisted because they
may contain credentials.

`AccountEscrowCloudClient` remains an **inactive interface** for a future Cloud
service. No boot, scheduler, run, or UI path invokes account escrow. Its proposed
endpoints are not available and Phase 1 does not claim Cloud key recovery.
