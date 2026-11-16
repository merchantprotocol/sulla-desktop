// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Size, time and pattern bounds shared by every relay session (unchanged from relays.ts). */
export const SESSION_TTL_MS = 30 * 60_000;
export const MAX_QUEUE_EVENTS = 512;
export const MAX_EVENT_BYTES = 512 * 1024;
export const MAX_COMMAND_BYTES = 64 * 1024;
export const MAX_BOOTSTRAP_BYTES = 64 * 1024;
export const BOOTSTRAP_TIMEOUT_MS = 10_000;
export const RECONNECT_MAX_MS = 30_000;
export const SENSITIVE_KEY = /(?:^|_)(?:token|authorization|cookie|password|secret|session_key|session_id|resume_gateway_url|response_url)(?:$|_)/i;
export const GATEWAY_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_AUDIO_CHUNK_BYTES = 64 * 1024;
export const MAX_AUDIO_COMMAND_BYTES = 90 * 1024;
export const MAX_GATEWAY_BUFFERED_BYTES = 256 * 1024;
// Cloudflare caps WebSocket messages at 1 MiB; events carry the frame as a
// JSON string, so allow escaping headroom on the event bound.
export const MAX_SULLA_CLOUD_FRAME_BYTES = 1024 * 1024;
export const MAX_SULLA_CLOUD_EVENT_BYTES = 3 * 1024 * 1024;
export const MAX_SULLA_CLOUD_BUFFERED_BYTES = 8 * 1024 * 1024;
export const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
