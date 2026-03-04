/**
 * This is the entry point for the Model Training window.
 */
// hoping this is the absolute earliest we can run in the renderer context
import { initiateWindowContext } from '@pkg/sulla';
await initiateWindowContext();

import Cookies from 'cookie-universal';
import { createApp } from 'vue';

import usePlugins from './plugins';
import store from './store';

import ModelTraining from '../pages/ModelTraining.vue';

// This does just the Vuex part of cookie-universal-nuxt, which is all we need.
(store as any).$cookies = Cookies();

const app = createApp(ModelTraining);

app.use(store);
await usePlugins(app, store);

app.mount('#app');
