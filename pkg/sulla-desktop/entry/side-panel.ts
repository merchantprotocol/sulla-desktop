// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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
