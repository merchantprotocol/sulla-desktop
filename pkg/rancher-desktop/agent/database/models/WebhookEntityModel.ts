import * as crypto from 'crypto';

import { BaseModel } from '../BaseModel';

interface WebhookEntityAttributes {
  webhookPath: string;
  method:      string;
  node:        string;
  webhookId?:  string | null;
  pathLength?: number | null;
  workflowId:  string;
}

type FindOrCreateWebhookEntityParams = Partial<WebhookEntityAttributes> & {
  workflowId: string;
};

export class WebhookEntityModel extends BaseModel<WebhookEntityAttributes> {
  protected readonly tableName = 'webhook_entity';

  // Table uses a composite primary key (webhookPath + method).
  // BaseModel supports a single primary key, so webhookPath is used as the
  // default key while composite lookups should use where/findByPathAndMethod.
  protected readonly primaryKey = 'webhookPath';
  protected readonly timestamps = false;

  protected readonly fillable = [
    'webhookPath',
    'method',
    'node',
    'webhookId',
    'pathLength',
    'workflowId',
  ];

  protected readonly casts: Record<string, string> = {
    pathLength: 'integer',
  };

  constructor(attributes: Partial<WebhookEntityAttributes> = {}) {
    super();
    this.attributes = { ...attributes };
    this.original = { ...attributes };
  }

  static async findByPathAndMethod(webhookPath: string, method: string): Promise<WebhookEntityModel | null> {
    const rows = await this.where({ webhookPath, method });
    return rows[0] || null;
  }

  static async findOrCreate(params: FindOrCreateWebhookEntityParams): Promise<WebhookEntityModel> {
    const workflowId = String(params.workflowId || '').trim();
    if (!workflowId) {
      throw new Error('workflowId is required');
    }

    const providedWebhookPath = String(params.webhookPath || '').trim();
    const lookupConditions = providedWebhookPath
      ? { workflowId, webhookPath: providedWebhookPath }
      : { workflowId };

    const existing = await this.where(lookupConditions);
    if (existing.length > 0) {
      return existing[0];
    }

    if (providedWebhookPath) {
      const existingByWebhookPath = await this.where({ webhookPath: providedWebhookPath });
      for (const row of existingByWebhookPath) {
        await row.delete();
      }
    }

    const webhookPath = providedWebhookPath || crypto.randomUUID();
    const method = String(params.method || 'POST').trim() || 'POST';
    const node = String(params.node || '').trim() || `node_${ Date.now() }_${ Math.random().toString(36).slice(2, 10) }`;

    const attributes: WebhookEntityAttributes = {
      webhookPath,
      method,
      node,
      webhookId:  params.webhookId ?? null,
      pathLength: webhookPath.length,
      workflowId,
    };

    return this.create(attributes);
  }
}
