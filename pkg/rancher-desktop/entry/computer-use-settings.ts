/**
 * This is the entry point for the Computer Use Settings window.
 */
import { initiateWindowContext } from '@pkg/sulla';

import Cookies from 'cookie-universal';
import { createApp } from 'vue';

import './agent-tailwind.css';

import usePlugins from './plugins';
import store from './store';

import ComputerUseSettings from '../pages/ComputerUseSettings.vue';
await initiateWindowContext();

(store as any).$cookies = Cookies();

const app = createApp(ComputerUseSettings);

app.use(store);
await usePlugins(app, store);

app.mount('#app');
