import { BaseTool, ToolResponse } from '../base';

import { getChromeApi } from '@pkg/main/chromeApi';

/**
 * Schedule Alarm Tool — set, list, and clear named timers.
 */
export class ScheduleAlarmWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const chrome = getChromeApi();
    const action = input.action as string;

    try {
      switch (action) {
      case 'create': {
        if (!input.name) {
          return { successBoolean: false, responseString: '"name" is required for create action.' };
        }
        if (!input.delayInMinutes && !input.periodInMinutes && !input.when) {
          return { successBoolean: false, responseString: 'Provide "delayInMinutes", "periodInMinutes", or "when" (epoch ms).' };
        }

        const alarmInfo: any = {};

        if (input.delayInMinutes) alarmInfo.delayInMinutes = input.delayInMinutes;
        if (input.periodInMinutes) alarmInfo.periodInMinutes = input.periodInMinutes;
        if (input.when) alarmInfo.when = input.when;

        await chrome.alarms.create(input.name, alarmInfo);

        const parts = [];

        if (input.delayInMinutes) parts.push(`fires in ${ input.delayInMinutes } min`);
        if (input.periodInMinutes) parts.push(`repeats every ${ input.periodInMinutes } min`);

        return {
          successBoolean: true,
          responseString: `Alarm "${ input.name }" created (${ parts.join(', ') || 'scheduled' }).`,
        };
      }

      case 'get': {
        if (!input.name) {
          return { successBoolean: false, responseString: '"name" is required for get action.' };
        }

        const alarm = await chrome.alarms.get(input.name);

        if (!alarm) {
          return { successBoolean: true, responseString: `No alarm named "${ input.name }".` };
        }

        const firesAt = new Date(alarm.scheduledTime).toLocaleString();

        return {
          successBoolean: true,
          responseString: `Alarm "${ alarm.name }": fires at ${ firesAt }${ alarm.periodInMinutes ? `, repeats every ${ alarm.periodInMinutes } min` : '' }`,
        };
      }

      case 'list': {
        const alarms = await chrome.alarms.getAll();

        if (alarms.length === 0) {
          return { successBoolean: true, responseString: 'No active alarms.' };
        }

        const lines = alarms.map((a: any) => {
          const firesAt = new Date(a.scheduledTime).toLocaleString();

          return `  ${ a.name } — fires at ${ firesAt }${ a.periodInMinutes ? ` (every ${ a.periodInMinutes } min)` : '' }`;
        });

        return {
          successBoolean: true,
          responseString: `${ alarms.length } active alarm(s):\n${ lines.join('\n') }`,
        };
      }

      case 'clear': {
        if (!input.name) {
          return { successBoolean: false, responseString: '"name" is required for clear action.' };
        }

        const cleared = await chrome.alarms.clear(input.name);

        return {
          successBoolean: true,
          responseString: cleared
            ? `Alarm "${ input.name }" cleared.`
            : `No alarm named "${ input.name }" to clear.`,
        };
      }

      case 'clearAll': {
        await chrome.alarms.clearAll();

        return { successBoolean: true, responseString: 'All alarms cleared.' };
      }

      default:
        return { successBoolean: false, responseString: `Unknown action: ${ action }. Use create, get, list, clear, or clearAll.` };
      }
    } catch (error) {
      return { successBoolean: false, responseString: `Alarm operation failed: ${ (error as Error).message }` };
    }
  }
}
