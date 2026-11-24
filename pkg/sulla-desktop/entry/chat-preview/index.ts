// SPDX-License-Identifier: GPL-2.0-or-later

import { createApp } from 'vue';
import '@pkg/assets/styles/base/_tokens.scss';
import '@pkg/assets/styles/fonts/_fontstack.scss';
import '@pkg/assets/styles/themes.css';

import { AgentStateClient } from '@pkg/services/agentState/AgentStateClient';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';

import { ipcRenderer } from './electron';
import PreviewApp from './PreviewApp.vue';

const app = createApp(PreviewApp);
app.provide(AGENT_STATE_CLIENT_KEY, new AgentStateClient(ipcRenderer, {
  document,
  addEventListener: (name, listener) => window.addEventListener(name, listener),
  removeEventListener: (name, listener) => window.removeEventListener(name, listener),
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: handle => clearInterval(handle),
}));
app.mount('#app');
