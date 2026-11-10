# Cloud vault bundle fingerprint contract

Desktop treats a bundle as stale only when its effective password/KDF wrap,
wrapped user key, public/private key pair, or recovery wrap differs from the
last verified Cloud bundle. Fingerprints compare those semantic fields, not
JavaScript object insertion order or PostgreSQL JSONB serialization order.
Database account fields are normalized to the same bundle envelope shape before
fingerprinting, then serialized with RFC 8785 canonical JSON.

A successful pull may update `bundle_sha` when the Cloud bundle generation is
not older and its normalized wrap equals the local account wrap. It must not
advance the fingerprint for a mismatched wrap: that difference can represent a
real password/KDF or key change and Cloud must continue enforcing its
current-password `authHash` requirement for rewraps. This fingerprint is
bookkeeping only; it neither authenticates a user nor weakens Cloud's password
gate.
