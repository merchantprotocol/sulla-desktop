import { createApp } from 'vue';

import ProcessManager from '../pages/ProcessManager.vue';

// This diagnostic window must work even when the database or agents are unavailable.
createApp(ProcessManager).mount('#app');
