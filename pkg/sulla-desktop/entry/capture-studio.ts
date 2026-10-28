// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * This is the entry point for the Capture Studio window.
 */

import Cookies from 'cookie-universal';
import { createApp } from 'vue';

import usePlugins from './plugins';
import store from './store';
import CaptureStudio from '../pages/CaptureStudio.vue';

import { initiateWindowContext } from '@pkg/sulla';
await initiateWindowContext();

(store as any).$cookies = Cookies();

const app = createApp(CaptureStudio);

app.use(store);
await usePlugins(app, store);

app.mount('#app');
