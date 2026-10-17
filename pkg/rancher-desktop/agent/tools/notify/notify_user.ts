import { BaseTool, ToolResponse } from '../base';

import { getChromeApi } from '@pkg/main/chromeApi';
import { getMobileApiClient } from '../mobile/MobileApiClient';

import type { ToolExecutionContext } from '../executionContext';

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
        await sendMobilePush({ title, message, id }, this.executionContext);
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
 * The paired user id is routing-safe metadata. The Sulla Cloud credential is
 * injected only by the local vault's exact-host/exact-path broker policy.
 *
 * Missing caller scope or pairing metadata fails closed.
 */
async function sendMobilePush(opts: { title: string; message: string; id: string }, ctx: ToolExecutionContext | undefined): Promise<void> {
  const { getIntegrationService } = await import('../../services/IntegrationService');
  const svc = getIntegrationService();
  const accountId = await svc.getActiveAccountId('sulla-cloud');
  const metadata = await svc.getMetadataValues('sulla-cloud', accountId);
  const pairedUserValue = metadata.find(value => value.property === 'paired_user_id');

  if (!pairedUserValue?.value) {
    throw new Error('No paired mobile user_id in vault (sulla-cloud/paired_user_id). Pair your phone first.');
  }
  await getMobileApiClient().request(ctx, 'POST', `/push/${ encodeURIComponent(String(pairedUserValue.value)) }`, opts);
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
