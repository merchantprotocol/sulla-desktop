// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * This is the entry point for the First Run window.
 * It mounts FirstRun.vue directly — no AgentRouter, no StartupOverlay,
 * no browser tabs, no presence tracker.
 */
import { initiateWindowContext } from '@pkg/sulla';

import { createApp } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';

import './agent-tailwind.css';

import FirstRun from '../pages/FirstRun.vue';

await initiateWindowContext();

const router = createRouter({
  history: createWebHashHistory(),
  routes:  [
    { path: '/', redirect: '/FirstRun' },
    { path: '/FirstRun', component: FirstRun, name: 'FirstRun' },
  ],
});

const app = createApp(FirstRun);

app.use(router);

app.mount('#app');
