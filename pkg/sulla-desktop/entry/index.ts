// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Portions Copyright SUSE LLC and the Rancher Desktop contributors, licensed under
// the Apache License 2.0 (LICENSES/Apache-2.0.txt).
// Modifications Copyright (c) 2025-2026 Merchant Protocol LLC, licensed under the
// GPL-2.0-or-later (LICENSE).
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * This is the main entry point for Vue.
 */
// hoping this is the absolute earliest we can run in the renderer context

import Cookies from 'cookie-universal';
import { createApp } from 'vue';

import usePlugins from './plugins';
import router from './router';
import store from './store';

import { initiateWindowContext } from '@pkg/sulla';
await initiateWindowContext();

// This does just the Vuex part of cookie-universal-nuxt, which is all we need.
(store as any).$cookies = Cookies();

// Emulate Nuxt layouts by poking making the router match the main component we
// will load, and then inspect it for the layout we set.
// Because we're always using the hash mode for the router, get the correct
// route based on the hash.
const matched = router.resolve(location.hash.substring(1)).matched.find(r => r);
const component = matched?.components?.default;
const layoutName: string = (component as any)?.layout ?? 'default';
const { default: layout } = await import(`../layouts/${ layoutName }.vue`);

const app = createApp(layout);

app.use(store);
app.use(router);
await usePlugins(app, store);

app.mount('#app');
