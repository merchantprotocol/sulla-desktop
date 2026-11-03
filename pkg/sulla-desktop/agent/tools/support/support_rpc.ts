// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';
import { BaseTool, type ToolResponse } from '../base';
import { cloudRequest } from '@pkg/main/cloud/cloudFetch';

export class SupportRpcWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: Record<string, unknown>): Promise<ToolResponse> {
    const metadata = (this.state as any)?.metadata || {};
    const sessionId = typeof metadata.supportSessionId === 'string' ? metadata.supportSessionId : '';
    const allowed = Array.isArray(metadata.allowedToolNames) ? metadata.allowedToolNames : [];
    if (!sessionId || !allowed.includes(this.name)) {
      return { successBoolean: false, responseString: 'This support tool is available only inside its active Support session tab.' };
    }
    const response = await cloudRequest('POST', `/super-admin/support/sessions/${ encodeURIComponent(sessionId) }/rpc`, {
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name: this.name, arguments: input } }),
    });
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok) return { successBoolean: false, responseString: payload.message || payload.error || `Support call failed (${ response.status })` };
    if (payload.error) return { successBoolean: false, responseString: payload.error.message || payload.error.code || 'Support call failed' };
    const content = payload.result?.content;
    return { successBoolean: !payload.result?.isError, responseString: Array.isArray(content) ? content.map((part:any) => part?.text || JSON.stringify(part)).join('\n') : JSON.stringify(payload.result ?? payload) };
  }
}
