// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { CloudOriginResolver } from './cloudOrigin';

// One resolver per process. It reads SULLA_CLOUD_ORIGIN once and logs the override state at startup.
const cloudOrigin = new CloudOriginResolver(process.env.SULLA_CLOUD_ORIGIN, console);
cloudOrigin.announce();

/** Sulla Cloud API origin used by every desktop → cloud call in main/cloud. Production unless SULLA_CLOUD_ORIGIN is a valid override. */
export const CLOUD_API_BASE = cloudOrigin.httpOrigin;

/** Sulla Cloud relay WebSocket origin (wss in production, derived from CLOUD_API_BASE). */
export const CLOUD_RELAY_BASE = cloudOrigin.relayOrigin;
