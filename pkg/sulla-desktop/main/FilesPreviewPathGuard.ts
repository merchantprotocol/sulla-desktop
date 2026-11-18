// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import path from 'node:path';

/** Decodes a URL path once and confines every resource to the HTML file's folder. */
export class FilesPreviewPathGuard {
  resolve(rootFolder:string, encodedPath:string):string | null {
    let decoded:string;
    try { decoded = decodeURIComponent(encodedPath) } catch { return null }
    if (!decoded || decoded.includes('\0') || decoded.includes('\\') || decoded.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(decoded)) return null;
    // '' is the collection root: every relative path inside the collection is allowed.
    const root = rootFolder ? path.posix.normalize(rootFolder) : '';
    const joined = path.posix.normalize(path.posix.join(root || '.', decoded));
    if (path.posix.isAbsolute(joined)) return null;
    if (!root) return joined === '..' || joined.startsWith('../') ? null : joined;
    // Confine to the page's folder subtree: "../sibling/x" escapes it and must be refused.
    return joined === root || joined.startsWith(`${ root }/`) ? joined : null;
  }
}
