// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createApp } from 'vue';

import ProcessManager from '../pages/ProcessManager.vue';

// This diagnostic window must work even when the database or agents are unavailable.
createApp(ProcessManager).mount('#app');
