/**
 * This is the entry point for the Capture Studio window.
 */

import Cookies from 'cookie-universal';
import { createApp } from 'vue';

import usePlugins from './plugins';
import store from './store';
import CaptureStudio from '../pages/CaptureStudio.vue';

import { initiateWindowContext } from '@pkg/sulla';
await initiateWindowContext();

(store as any).$cookies = Cookies();

const app = createApp(CaptureStudio);

app.use(store);
await usePlugins(app, store);

app.mount('#app');
