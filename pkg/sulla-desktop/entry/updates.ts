// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Entry point for the Updates window.
 */
import { initiateWindowContext } from '@pkg/sulla';

import { createApp } from 'vue';

import './agent-tailwind.css';

import Updates from '../pages/Updates.vue';
await initiateWindowContext();

const app = createApp(Updates);

app.mount('#app');
