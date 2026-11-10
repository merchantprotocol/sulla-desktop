// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
export const up = `
  CREATE TABLE IF NOT EXISTS conversation_bindings (
    id BIGSERIAL PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('thread_reply','dm_person','inbox')),
    channel_type TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    thread_key TEXT,
    sender_id TEXT,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('chat','job')),
    thread_id TEXT,
    job_id TEXT,
    task_index INTEGER,
    agent_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((target_kind='chat' AND thread_id IS NOT NULL AND job_id IS NULL) OR (target_kind='job' AND job_id IS NOT NULL AND thread_id IS NULL)),
    CHECK ((kind='thread_reply' AND thread_key IS NOT NULL) OR (kind <> 'thread_reply' AND thread_key IS NULL))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS conversation_bindings_thread_unique ON conversation_bindings(channel_type,workspace_id,conversation_id,thread_key) WHERE kind='thread_reply';
  CREATE UNIQUE INDEX IF NOT EXISTS conversation_bindings_dm_unique ON conversation_bindings(channel_type,workspace_id,sender_id) WHERE kind='dm_person';
  CREATE UNIQUE INDEX IF NOT EXISTS conversation_bindings_inbox_unique ON conversation_bindings(channel_type,workspace_id) WHERE kind='inbox';
  CREATE TABLE IF NOT EXISTS inbound_receipts (
    channel_type TEXT NOT NULL,
    event_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','complete')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(channel_type,event_id)
  );
`;
export const down = `DROP TABLE IF EXISTS inbound_receipts; DROP TABLE IF EXISTS conversation_bindings;`;
