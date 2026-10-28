// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Minimal Files renderer entry for source-level preview work.
 *
 * This deliberately skips the Electron window context and the production
 * router/store. FilesPreviewHarness supplies an in-memory data source, so the
 * page can exercise the real FilesBrowser component without touching Files IPC.
 */
import { createApp } from 'vue';

import FilesPreviewHarness from '../pages/files/FilesPreviewHarness.vue';

document.body.style.margin = '0';
document.body.style.height = '100vh';
document.body.style.overflow = 'hidden';

createApp(FilesPreviewHarness).mount('#app');
