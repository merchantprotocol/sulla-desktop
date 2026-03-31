/**
 * Entry point for the Side Panel chat view.
 *
 * This is loaded inside a WebContentsView created by chrome.sidePanel.open().
 * It boots a minimal Vue app with just the SidePanelChat component.
 */
import { initiateWindowContext } from '@pkg/sulla';

import { createApp } from 'vue';

import './agent-tailwind.css';

import SidePanelChat from '../pages/SidePanelChat.vue';

await initiateWindowContext();

const app = createApp(SidePanelChat);

app.mount('#app');
