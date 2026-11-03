// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
export const up=`
CREATE TABLE IF NOT EXISTS memory_sync_v1_records(id text PRIMARY KEY,generation bigint NOT NULL,deleted boolean NOT NULL DEFAULT false,content_hash text,source_device_id text,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS memory_sync_v1_pending(id text PRIMARY KEY,generation bigint NOT NULL,record jsonb NOT NULL,source_device_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());`;
export const down=`DROP TABLE IF EXISTS memory_sync_v1_pending;DROP TABLE IF EXISTS memory_sync_v1_records;`;
