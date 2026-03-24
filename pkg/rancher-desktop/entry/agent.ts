/**
 * This is the entry point for the Agent window.
 */
// hoping this is the absolute earliest we can run in the renderer context
import { initiateWindowContext } from '@pkg/sulla';

import { createApp } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';

import './agent-tailwind.css';

import AgentRouter from '../pages/AgentRouter.vue';
import Agent from '../pages/Agent.vue';
import AgentCalendar from '../pages/AgentCalendar.vue';
import AgentIntegrations from '../pages/AgentIntegrations.vue';
import AgentIntegrationDetail from '../pages/AgentIntegrationDetail.vue';
import AgentExtensions from '../pages/AgentExtensions.vue';
import AgentAutomations from '../pages/AgentAutomations.vue';

// BrowserTab is rendered persistently in AgentRouter (outside keep-alive)
// so iframes are never removed from the DOM.  This stub just lets the
// router match /Browser/:id for route.path / route.params without
// rendering a duplicate component through router-view.
const BrowserTabStub = { name: 'BrowserTabStub', render: () => null };
import ExtensionView from '../pages/ExtensionView.vue';
await initiateWindowContext();

// Start the renderer-side bridge IPC so the main-process agent can
// interact with iframe browser tabs via WebSocket.
import { initHostBridgeIpc } from '@pkg/agent/scripts/injected/HostBridgeIpcRenderer';
initHostBridgeIpc();

const router = createRouter({
  history: createWebHashHistory(),
  routes:  [
    { path: '/', redirect: '/Chat' },
    { path: '/Chat', component: Agent, name: 'AgentChat' },
    { path: '/Calendar', component: AgentCalendar, name: 'AgentCalendar' },
    { path: '/Integrations', component: AgentIntegrations, name: 'AgentIntegrations' },
    { path: '/Integrations/:id', component: AgentIntegrationDetail, name: 'AgentIntegrationDetail' },
    { path: '/Extensions', component: AgentExtensions, name: 'AgentExtensions' },
    { path: '/Automations', component: AgentAutomations, name: 'AgentAutomations' },
    { path: '/Browser/:id', component: BrowserTabStub, name: 'BrowserTab' },

    { path: '/Extension/:name/:path*', component: ExtensionView, name: 'ExtensionView' },

    // Catch-all: redirect unknown routes to /Chat to prevent white screens
    { path: '/:pathMatch(.*)*', redirect: '/Chat' },
  ],
});

const app = createApp(AgentRouter);

app.use(router);

app.mount('#app');
