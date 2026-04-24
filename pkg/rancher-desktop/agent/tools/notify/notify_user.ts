import { BaseTool, ToolResponse } from '../base';

import { getChromeApi } from '@pkg/main/chromeApi';

type NotifyTarget = 'desktop' | 'mobile';

const ALL_TARGETS: NotifyTarget[] = ['desktop', 'mobile'];

/**
 * Notify User Tool — send a notification to the user's desktop, paired
 * mobile (via Cloudflare relay), or both.
 *
 * Every call logs a row to the `notifications` table so the user can
 * review what was sent. Failures in one target don't abort the others.
 */
export class NotifyUserWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const title   = String(input.title ?? '').trim();
    const message = String(input.message ?? '').trim();
    const silent  = input.silent === true;
    const id      = typeof input.id === 'string' && input.id.trim().length > 0 ? input.id.trim() : `notify-${ Date.now() }`;

    if (!title && !message) {
      return { successBoolean: false, responseString: 'Missing both "title" and "message" — at least one is required.' };
    }

    const targets = parseTargets(input.targets);
    if (targets.length === 0) {
      return {
        successBoolean: false,
        responseString: `Invalid "targets". Must be a non-empty array of ${ ALL_TARGETS.map(t => `"${ t }"`).join(' | ') }. Default is ["desktop"].`,
      };
    }

    const deliveryResults: { target: NotifyTarget; ok: boolean; error?: string }[] = [];

    if (targets.includes('desktop')) {
      try {
        const chrome = getChromeApi();
        await chrome.notifications.create(id, { title, message, silent });
        deliveryResults.push({ target: 'desktop', ok: true });
      } catch (err) {
        deliveryResults.push({ target: 'desktop', ok: false, error: (err as Error).message });
      }
    }

    if (targets.includes('mobile')) {
      try {
        await sendMobilePush({ title, message, id });
        deliveryResults.push({ target: 'mobile', ok: true });
      } catch (err) {
        deliveryResults.push({ target: 'mobile', ok: false, error: (err as Error).message });
      }
    }

    const anyOk = deliveryResults.some(r => r.ok);
    const firstError = deliveryResults.find(r => !r.ok)?.error;

    await writeHistoryRow({
      title,
      message,
      targets,
      id,
      silent,
      delivered: anyOk,
      error: firstError,
    });

    const deliveredTargets = deliveryResults.filter(r => r.ok).map(r => r.target);
    const failedTargets = deliveryResults.filter(r => !r.ok);

    if (!anyOk) {
      return {
        successBoolean: false,
        responseString: `Failed to deliver to any target: ${ failedTargets.map(f => `${ f.target } (${ f.error })`).join('; ') }`,
      };
    }

    let msg = `Notification "${ title }" delivered to: ${ deliveredTargets.join(', ') }.`;
    if (failedTargets.length > 0) {
      msg += `\nPartial failures: ${ failedTargets.map(f => `${ f.target } — ${ f.error }`).join('; ') }`;
    }
    return { successBoolean: true, responseString: msg };
  }
}

function parseTargets(raw: unknown): NotifyTarget[] {
  if (raw === undefined || raw === null) return ['desktop'];
  if (typeof raw === 'string') raw = [raw];
  if (!Array.isArray(raw)) return [];
  const out: NotifyTarget[] = [];
  for (const t of raw as unknown[]) {
    const s = typeof t === 'string' ? t.trim().toLowerCase() : '';
    if (s === 'desktop' || s === 'mobile') {
      if (!out.includes(s)) out.push(s);
    }
  }
  return out;
}

/**
 * Push a notification to the paired mobile device via the Sulla Cloud relay.
 * The relay is implemented in sulla-workers; this tool expects a
 * `mobile_push` channel message posted from the desktop relay.
 *
 * Resolution:
 * - Mobile user id comes from SullaSettingsModel `mobile.pairedUserId` or
 *   vault `sulla-cloud/paired_user_id`.
 * - Relay URL comes from vault `sulla-cloud/relay_url`
 *   (default: wss://sulla-workers.jonathon-44b.workers.dev).
 * - Auth: JWT in vault `sulla-cloud/api_token` (HS256, sub = user_id).
 *
 * If any of the above is missing, throws with a clear message so the agent
 * can relay it to the user.
 */
async function sendMobilePush(opts: { title: string; message: string; id: string }): Promise<void> {
  const { getIntegrationService } = await import('../../services/IntegrationService');
  const svc = getIntegrationService();

  const tokenValue      = await svc.getIntegrationValue('sulla-cloud', 'api_token');
  const pairedUserValue = await svc.getIntegrationValue('sulla-cloud', 'paired_user_id');
  const relayValue      = await svc.getIntegrationValue('sulla-cloud', 'relay_url');

  if (!pairedUserValue?.value) {
    throw new Error('No paired mobile user_id in vault (sulla-cloud/paired_user_id). Pair your phone first.');
  }
  if (!tokenValue?.value) {
    throw new Error('No Sulla Cloud token in vault (sulla-cloud/api_token).');
  }

  const relayBase = String(relayValue?.value || 'https://sulla-workers.jonathon-44b.workers.dev').replace(/\/+$/, '');
  const url = `${ relayBase }/push/${ encodeURIComponent(String(pairedUserValue.value)) }`;

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${ tokenValue.value }`,
    },
    body: JSON.stringify({ title: opts.title, message: opts.message, id: opts.id }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Relay push HTTP ${ res.status }: ${ text || res.statusText }`);
  }
}

async function writeHistoryRow(row: {
  title:     string;
  message:   string;
  targets:   NotifyTarget[];
  id:        string;
  silent:    boolean;
  delivered: boolean;
  error?:    string;
}): Promise<void> {
  try {
    const { postgresClient } = await import('../../database/PostgresClient');
    await postgresClient.query(
      `INSERT INTO notifications
         (title, message, targets, notification_id, silent, delivered, error)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)`,
      [row.title, row.message, JSON.stringify(row.targets), row.id, row.silent, row.delivered, row.error ?? null],
    );
  } catch (err) {
    console.warn('[notify history] insert failed:', err);
  }
}
