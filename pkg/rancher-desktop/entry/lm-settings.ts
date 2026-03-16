/**
 * This is the entry point for the Language Model Settings window.
 */
// hoping this is the absolute earliest we can run in the renderer context
import { initiateWindowContext } from '@pkg/sulla';

import Cookies from 'cookie-universal';
import { createApp } from 'vue';

import './agent-tailwind.css';

import usePlugins from './plugins';
import store from './store';

import LanguageModelSettings from '../pages/LanguageModelSettings.vue';
await initiateWindowContext();

// This does just the Vuex part of cookie-universal-nuxt, which is all we need.
(store as any).$cookies = Cookies();

const app = createApp(LanguageModelSettings);

app.use(store);
await usePlugins(app, store);

app.mount('#app');
