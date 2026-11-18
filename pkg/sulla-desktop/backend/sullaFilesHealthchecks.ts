// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SULLA_FILES_GUEST_MOUNT_PATH } from './guestMountInfo';

/**
 * Docker healthchecks for Sulla Files and its FUSE adapter. Both run on every tick inside a VM
 * that may be saturated by the very load they are checking, so each must cost milliseconds.
 * No `$` appears in either string: compose would treat it as interpolation.
 */

/** Files image node probe, kept only for images built before the loopback health port (8793). */
const LEGACY_FILES_TLS_PROBE = 'node -e \'const fs=require("fs"),https=require("https");const r=https.get({hostname:"127.0.0.1",port:8792,path:"/healthz",ca:fs.readFileSync("/run/sulla-files-tls/tls.crt")},x=>{x.resume();process.exit(x.statusCode===200?0:1)});r.on("error",()=>process.exit(1));r.setTimeout(2500,()=>r.destroy())\'';

/** BusyBox wget to Files' loopback plain-HTTP /healthz; the Node probe runs only when that fails (old image, or a real fault). */
export const SULLA_FILES_HEALTHCHECK = `wget -q -T 3 -O /dev/null http://127.0.0.1:8793/healthz || ${ LEGACY_FILES_TLS_PROBE }`;

/** The FUSE mount is live and the adapter's event loop rewrote its status file in the last 2 minutes. */
// grep is intentionally presence-based: shared propagation may expose more
// than one identical FUSE layer, and any live layer plus a fresh heartbeat is healthy.
export const SULLA_FILES_FUSE_HEALTHCHECK = `grep -Fqs "sulla-files ${ SULLA_FILES_GUEST_MOUNT_PATH } fuse" /proc/self/mounts && find /tmp/sulla-files-fuse-status.json -mmin -2 2>/dev/null | grep -q .`;
