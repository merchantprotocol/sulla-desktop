// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { createApp } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import '@pkg/assets/styles/app.scss';
import '@pkg/assets/styles/themes.css';
import ThemePreviewApp from './theme-preview/ThemePreviewApp.vue';
const router = createRouter({ history:createMemoryHistory(), routes:[{ path:'/:pathMatch(.*)*', component:{ template:'<span />' } }] });
createApp(ThemePreviewApp).use(router).mount('#app');
