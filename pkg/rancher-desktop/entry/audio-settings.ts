/**
 * This is the entry point for the Audio Settings window.
 */
import { initiateWindowContext } from '@pkg/sulla';

import Cookies from 'cookie-universal';
import { createApp } from 'vue';

import './agent-tailwind.css';

import usePlugins from './plugins';
import store from './store';
import AudioSettings from '../pages/AudioSettings.vue';
await initiateWindowContext();

(store as any).$cookies = Cookies();

const app = createApp(AudioSettings);

app.use(store);
await usePlugins(app, store);

app.mount('#app');
