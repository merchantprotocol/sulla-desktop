/**
 * This is the entry point for the Agent window.
 */
// hoping this is the absolute earliest we can run in the renderer context
import { initiateWindowContext } from '@pkg/sulla';

import { createApp } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';

import './agent-tailwind.css';

import AgentCalendar from '../pages/AgentCalendar.vue';
import AgentExtensions from '../pages/AgentExtensions.vue';
import AgentIntegrationDetail from '../pages/AgentIntegrationDetail.vue';
import AgentIntegrations from '../pages/AgentIntegrations.vue';
import AgentRouter from '../pages/AgentRouter.vue';
import ExtensionView from '../pages/ExtensionView.vue';

// Start the renderer-side bridge IPC so the main-process agent can
// interact with iframe browser tabs via WebSocket.
import { initHostBridgeIpc } from '@pkg/agent/scripts/injected/HostBridgeIpcRenderer';
// BrowserTab is rendered persistently in AgentRouter (outside keep-alive)
// so iframes are never removed from the DOM.  This stub just lets the
// router match /Browser/:id for route.path / route.params without
// rendering a duplicate component through router-view.
const BrowserTabStub = { name: 'BrowserTabStub', render: () => null };
await initiateWindowContext();
initHostBridgeIpc();

const router = createRouter({
  history: createWebHashHistory(),
  routes:  [
    { path: '/Calendar', component: AgentCalendar, name: 'AgentCalendar' },
    { path: '/Integrations', component: AgentIntegrations, name: 'AgentIntegrations' },
    { path: '/Integrations/:id', component: AgentIntegrationDetail, name: 'AgentIntegrationDetail' },
    { path: '/Extensions', component: AgentExtensions, name: 'AgentExtensions' },
    { path: '/Browser/:id', component: BrowserTabStub, name: 'BrowserTab' },

    { path: '/Extension/:name/:path*', component: ExtensionView, name: 'ExtensionView' },
  ],
});

const app = createApp(AgentRouter);

app.use(router);

app.mount('#app');
