// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { tmpdir } from 'node:os';

/**
 * utils/paths.ts computes its platform paths once, as a module-load-time
 * side effect, from XDG_DATA_HOME/XDG_CONFIG_HOME/XDG_CACHE_HOME. A spec that
 * reaches the real tool catalog (GraphRegistry → ../tools/manifests) pulls in
 * utils/logging.ts, which mkdirSync's paths.logs at import time too, and
 * SullaLogger.ts/sullaPaths.ts, which mkdirSync's $SULLA_HOME_DIR/logs on
 * first use — outside a real user's home directory that fails with EACCES in
 * CI/sandboxes.
 *
 * Import this file first, before any import that might reach that chain: ESM
 * evaluates each import's full module graph in declaration order before
 * moving to the next, so these env vars land before utils/paths.ts first runs.
 */
process.env.XDG_DATA_HOME ??= tmpdir();
process.env.XDG_CONFIG_HOME ??= tmpdir();
process.env.XDG_CACHE_HOME ??= tmpdir();
process.env.SULLA_HOME_DIR ??= tmpdir();
