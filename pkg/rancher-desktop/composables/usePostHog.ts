import { ref, watch, onMounted, onUnmounted } from 'vue';
import { PostHog } from 'posthog-node';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { Settings } from '@pkg/config/settings';
import { randomUUID, createHash } from 'crypto';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';

const POSTHOG_API_KEY = 'phc_gXH23UnL6M7IbHXBfLEjMi555TwCKvyTkLLCE8mEECL';
const POSTHOG_HOST = 'https://us.i.posthog.com';
const DESKTOP_CONTEXT_PROPERTIES = {
  app_platform:    'desktop',
  app_name:        'sulla-desktop',
  app_environment: 'electron-renderer',
};

let sharedClient: PostHog | null = null;

function getClient(): PostHog {
  if (!sharedClient) {
    sharedClient = new PostHog(POSTHOG_API_KEY, { host: POSTHOG_HOST });
  }

  return sharedClient;
}

export function usePostHog() {
  const enabled = ref(false);
  const client = getClient();

  const onSettingsRead = (_event: unknown, settings: Settings) => {
    enabled.value = settings?.application?.telemetry?.enabled ?? false;
  };

  const onSettingsUpdate = (_event: unknown, settings: Settings) => {
    enabled.value = settings?.application?.telemetry?.enabled ?? false;
  };

  onMounted(() => {
    ipcRenderer.on('settings-read', onSettingsRead);
    ipcRenderer.on('settings-update', onSettingsUpdate);
    ipcRenderer.send('settings-read');
  });

  onUnmounted(() => {
    ipcRenderer.removeListener('settings-read', onSettingsRead);
    ipcRenderer.removeListener('settings-update', onSettingsUpdate);
  });

  /**
   * Capture an event only if telemetry is enabled.
   */
  async function capture(eventName: string, properties?: Record<string, any>) {
    if (!enabled.value) {
      return;
    }
    const distinctId = await getDistinctId();
    client.capture({
      distinctId,
      event:      eventName,
      properties: {
        ...DESKTOP_CONTEXT_PROPERTIES,
        ...(properties || {}),
      },
    });
  }

  /**
   * Identify the user (optional — call when you have user-level info).
   */
  function identify(distinctId: string, properties?: Record<string, any>) {
    if (!enabled.value) {
      return;
    }
    client.identify({ distinctId, properties });
  }

  return {
    enabled,
    capture,
    identify,
  };
}

let cachedDistinctId: string | null = null;

async function getDistinctId(): Promise<string> {
  if (cachedDistinctId) {
    return cachedDistinctId;
  }

  const storedDistinctId = localStorage.getItem('posthog_distinct_id');

  try {
    // Prefer deterministic distinct id derived from user email.
    // This links sessions together even across reinstalls/devices.
    const loadedEmail = await SullaSettingsModel.get('sullaEmail');

    if (loadedEmail && typeof loadedEmail === 'string' && loadedEmail.trim()) {
      cachedDistinctId = createHash('md5').update(loadedEmail.trim().toLowerCase()).digest('hex');
      if (storedDistinctId !== cachedDistinctId) {
        localStorage.setItem('posthog_distinct_id', cachedDistinctId);
      }
      return cachedDistinctId;
    }
  } catch (error) {
    console.warn('Failed to load user email for PostHog distinct ID:', error);
  }

  // Fallback: retain existing local distinct id when email is missing
  if (storedDistinctId) {
    cachedDistinctId = storedDistinctId;
    return cachedDistinctId;
  }

  cachedDistinctId = randomUUID();
  localStorage.setItem('posthog_distinct_id', cachedDistinctId);

  return cachedDistinctId;
}
