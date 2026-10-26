-- Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
-- Licensed under the Sulla Fair-Code License. See LICENSE.
--
-- Cloud backup also sends each collection's folder name, sealed with the collection root
-- (the 'info' operation), so a new Desktop restores folders under their real names.
-- info_name_sha is the hash of the name last sent; a rename sends it again.
ALTER TABLE files_cloud_sync ADD COLUMN IF NOT EXISTS info_name_sha TEXT;
ALTER TABLE files_cloud_operations DROP CONSTRAINT IF EXISTS files_cloud_operations_op_check;
ALTER TABLE files_cloud_operations ADD CONSTRAINT files_cloud_operations_op_check
  CHECK(op IN ('create','escrow','upload-open','commit','delete','info'));
