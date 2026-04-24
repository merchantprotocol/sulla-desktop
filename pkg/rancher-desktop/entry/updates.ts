/**
 * Entry point for the Updates window.
 */
import { initiateWindowContext } from '@pkg/sulla';

import { createApp } from 'vue';

import './agent-tailwind.css';

import Updates from '../pages/Updates.vue';
await initiateWindowContext();

const app = createApp(Updates);

app.mount('#app');
