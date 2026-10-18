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
