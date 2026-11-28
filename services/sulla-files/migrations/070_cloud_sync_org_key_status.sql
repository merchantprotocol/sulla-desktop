-- SPDX-License-Identifier: GPL-2.0-or-later
-- Org roots are supplied by Desktop's volatile org keyring, never Vault escrow.
ALTER TABLE files_cloud_sync DROP CONSTRAINT IF EXISTS files_cloud_sync_status_check;
ALTER TABLE files_cloud_sync ADD CONSTRAINT files_cloud_sync_status_check
  CHECK(status IN ('off','idle','syncing','error','needs-vault','needs-org-key'));
