// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * This is the entry point for the Agent window.
 */
// hoping this is the absolute earliest we can run in the renderer context
import { startWindowContextHydration } from '@pkg/sulla';
import '@pkg/composables/useBrowserTabs'; // register transfer IPC before renderer startup

import { createApp } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';

import './agent-tailwind.css';

import AgentRouter from '../pages/AgentRouter.vue';
import { lazyScreen } from '../pages/agent/lazyScreen';

import store from './store';

import { AgentStateClient } from '@pkg/services/agentState/AgentStateClient';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const windowBootStartedAt = Date.now();
console.info(`[WindowBoot] renderer entry started at ${ windowBootStartedAt }`);

// BrowserTab is rendered persistently in AgentRouter (outside keep-alive)
// so iframes are never removed from the DOM.  This stub just lets the
// router match /Browser/:id for route.path / route.params without
// rendering a duplicate component through router-view.
const BrowserTabStub = { name: 'BrowserTabStub', render: () => null };
// Settings, vault-backed services and extensions are not prerequisites for
// painting the agent shell. Hydrate them after mounting so a cold backend can
// never leave a newly-created window blank.
startWindowContextHydration();
// Bridge is now owned by main-process TabRegistry + GuestBridge; there is
// no renderer-side bridge to initialise.

const router = createRouter({
  history: createWebHashHistory(),
  routes:  [
    // Route screens are lazy so their code is only fetched when a route is visited.
    { path: '/Calendar', component: lazyScreen(() => import('../pages/AgentCalendar.vue'), 'AgentCalendar'), name: 'AgentCalendar' },
    { path: '/Integrations', component: lazyScreen(() => import('../pages/AgentIntegrations.vue'), 'AgentIntegrations'), name: 'AgentIntegrations' },
    { path: '/Integrations/:id', component: lazyScreen(() => import('../pages/AgentIntegrationDetail.vue'), 'AgentIntegrationDetail'), name: 'AgentIntegrationDetail' },
    { path: '/Browser/:id', component: BrowserTabStub, name: 'BrowserTab' },

    { path: '/Extension/:name/:path*', component: lazyScreen(() => import('../pages/ExtensionView.vue'), 'ExtensionView'), name: 'ExtensionView' },
  ],
});

const app = createApp(AgentRouter);

// Live Agents (Studio) and the chat sub-agent drawer inject this client; this
// window hosts both, so it must provide it (entry/index.ts does the same).
const agentStateClient = new AgentStateClient(ipcRenderer as any, window as any);
app.provide(AGENT_STATE_CLIENT_KEY, agentStateClient);
agentStateClient.start().catch(() => undefined);
window.addEventListener('beforeunload', () => agentStateClient.stop(), { once: true });

app.use(router);
// The Preferences and Docker tabs read settings, containers and snapshots from the Vuex store.
app.use(store);

app.mount('#app');
console.info(`[WindowBoot] renderer mounted after ${ Date.now() - windowBootStartedAt }ms`);
requestAnimationFrame(() => requestAnimationFrame(() => {
  console.info(`[WindowBoot] first content frame after ${ Date.now() - windowBootStartedAt }ms`);
}));
