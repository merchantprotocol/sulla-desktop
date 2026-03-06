/**
 * This is the entry point for the Editor window.
 */
// hoping this is the absolute earliest we can run in the renderer context
import { initiateWindowContext } from '@pkg/sulla';
await initiateWindowContext();

import Cookies from 'cookie-universal';
import { createApp } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';

import './agent-tailwind.css';

import usePlugins from './plugins';
import store from './store';

import AgentEditor from '../pages/AgentEditor.vue';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: AgentEditor },
    { path: '/Chat', redirect: '/' },
    { path: '/Calendar', redirect: '/' },
    { path: '/Filesystem', redirect: '/' },
    { path: '/Integrations', redirect: '/' },
    { path: '/Extensions', redirect: '/' },
  ],
});

// This does just the Vuex part of cookie-universal-nuxt, which is all we need.
(store as any).$cookies = Cookies();

const app = createApp(AgentEditor);

app.use(store);
app.use(router);
await usePlugins(app, store);

app.mount('#app');
