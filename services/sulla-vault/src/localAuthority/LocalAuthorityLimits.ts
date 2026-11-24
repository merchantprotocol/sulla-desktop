// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Limits, TTLs and identifier patterns of the local authority (moved verbatim from localAuthority.ts, E9).

export const CHALLENGE_TTL_MS = 30_000;
export const CACHE_UPDATE_TTL_MS = 60_000;
export const CHALLENGE_RATE_WINDOW_MS = 60_000;
export const CHALLENGE_RATE_LIMIT = 10;
export const APPROVAL_TTL_MS = 2 * 60_000;
export const CLERK_APPROVAL_TTL_MS = 10 * 60_000;
export const HUMAN_SESSION_TTL_MS = 15 * 60_000;
export const MAX_RESPONSE_BYTES = 1_048_576;
export const MAX_FILES_SYNC_UPLOAD_BYTES = 6 * 1024 * 1024;
export const MAX_STREAM_BYTES = 25 * 1024 * 1024;
// Git pack transfers for a full fetch routinely exceed the API stream cap.
export const MAX_GIT_STREAM_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_CREDENTIAL_BYTES = 64 * 1024;
export const LEGACY_PREFIX = '$VAULT$';
export const CREDENTIAL_PROPERTY_PATTERN = /(?:^|_)(?:token|key|secret|password|credential)$/i;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const BROKER_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
export const CHATGPT_AUTH_CLAIM = 'https://api.openai.com/auth';
export const CHATGPT_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
