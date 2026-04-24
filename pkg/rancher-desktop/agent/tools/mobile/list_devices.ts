import { BaseTool, ToolResponse } from '../base';
import { getMobileApiClient } from './MobileApiClient';

/**
 * List every device (desktop + mobile) registered to the authenticated
 * contractor, annotated with online/offline. A device is "online" when
 * the worker saw a heartbeat (or any authenticated call carrying the
 * X-Device-Id header) within the last 2 minutes.
 *
 * Hits `GET /devices` on sulla-workers. Backend: src/routes/devices.ts.
 */
interface DeviceRow {
  id:           string;
  deviceType:   string;
  platform:     string;
  model:        string | null;
  hostname:     string | null;
  name:         string;
  osVersion:    string | null;
  appVersion:   string | null;
  registeredAt: string;
  lastSeenAt:   string;
  online:       boolean;
}

export class MobileListDevicesWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const onlineOnly   = !!input.online_only;
    const typeFilter   = typeof input.device_type === 'string'
      ? input.device_type.trim().toLowerCase() : '';

    try {
      const result  = await getMobileApiClient().request<{ devices?: DeviceRow[] }>('GET', '/devices');
      let devices   = result.devices ?? [];
      if (typeFilter) devices = devices.filter(d => d.deviceType?.toLowerCase() === typeFilter);
      if (onlineOnly) devices = devices.filter(d => d.online);

      if (devices.length === 0) {
        return {
          successBoolean: true,
          responseString: onlineOnly
            ? 'No devices are online right now.'
            : 'No registered devices found.',
        };
      }

      // Sort: online first, then most-recently-seen.
      devices.sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return (Date.parse(b.lastSeenAt) || 0) - (Date.parse(a.lastSeenAt) || 0);
      });

      const onlineCount  = devices.filter(d => d.online).length;
      const lines: string[] = [
        `${ devices.length } device(s) registered · ${ onlineCount } online:\n`,
      ];
      for (const d of devices) {
        const flag     = d.online ? '● online' : '○ offline';
        const descr    = [d.deviceType, d.platform, d.model || d.hostname].filter(Boolean).join(' · ');
        const version  = d.appVersion ? ` v${ d.appVersion }` : '';
        lines.push(`  ${ flag }  **${ d.name }** — ${ descr }${ version } — last seen ${ d.lastSeenAt } — id:${ d.id }`);
      }

      return { successBoolean: true, responseString: lines.join('\n') };
    } catch (err) {
      return {
        successBoolean: false,
        responseString: `mobile/list_devices failed: ${ (err as Error).message }`,
      };
    }
  }
}
