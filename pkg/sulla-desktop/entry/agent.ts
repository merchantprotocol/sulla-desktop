// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * This is the entry point for the Agent window.
 */
// hoping this is the absolute earliest we can run in the renderer context
import { initiateWindowContext } from '@pkg/sulla';

import { createApp } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';

import './agent-tailwind.css';

import AgentCalendar from '../pages/AgentCalendar.vue';
import AgentIntegrationDetail from '../pages/AgentIntegrationDetail.vue';
import AgentIntegrations from '../pages/AgentIntegrations.vue';
import AgentRouter from '../pages/AgentRouter.vue';
import ExtensionView from '../pages/ExtensionView.vue';

import store from './store';

import { AgentStateClient } from '@pkg/services/agentState/AgentStateClient';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

// BrowserTab is rendered persistently in AgentRouter (outside keep-alive)
// so iframes are never removed from the DOM.  This stub just lets the
// router match /Browser/:id for route.path / route.params without
// rendering a duplicate component through router-view.
const BrowserTabStub = { name: 'BrowserTabStub', render: () => null };
await initiateWindowContext();
// Bridge is now owned by main-process TabRegistry + GuestBridge; there is
// no renderer-side bridge to initialise.

const router = createRouter({
  history: createWebHashHistory(),
  routes:  [
    { path: '/Calendar', component: AgentCalendar, name: 'AgentCalendar' },
    { path: '/Integrations', component: AgentIntegrations, name: 'AgentIntegrations' },
    { path: '/Integrations/:id', component: AgentIntegrationDetail, name: 'AgentIntegrationDetail' },
    { path: '/Browser/:id', component: BrowserTabStub, name: 'BrowserTab' },

    { path: '/Extension/:name/:path*', component: ExtensionView, name: 'ExtensionView' },
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
