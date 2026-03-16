// N8nService - Service for interacting with n8n API
// Provides methods to manage workflows, executions, credentials, and other n8n resources

import { N8nCredentialsEntityModel } from '../database/models/N8nCredentialsEntityModel';
import { postgresClient } from '../database/PostgresClient';

/**
 * N8n API Service
 * Handles interactions with the n8n REST API.
 * Only includes methods actively used by remaining tools.
 */
export class N8nService {
  private baseUrl: string;
  private apiKey:  string;

  constructor() {
    this.baseUrl = '';
    this.apiKey = '';
  }

  /**
   * Initialize the service by reading the API key and base URL.
   * Resolution order:
   *   IntegrationService credentials (saved by recipe installer)
   */
  async initialize(): Promise<void> {
    let apiKey = '';
    let baseUrl = 'http://127.0.0.1:30119';

    // Try IntegrationService first (populated by recipe post-install)
    try {
      const { getIntegrationService } = await import('./IntegrationService');
      const svc = getIntegrationService();
      const keyResult = await svc.getIntegrationValue('n8n', 'N8N_API_KEY');
      const urlResult = await svc.getIntegrationValue('n8n', 'BASE_URL');

      if (keyResult?.value) {
        apiKey = keyResult.value;
      }
      if (urlResult?.value) {
        baseUrl = urlResult.value;
      }
    } catch {
      // IntegrationService not ready yet — fall through to settings
    }

    if (!apiKey) {
      console.warn('[N8nService] No n8n API key found in IntegrationService — is n8n installed?');
    }

    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  /**
   * Make authenticated request to n8n API
   */
  private async request(endpoint: string, options: RequestInit = {}): Promise<any> {
    const url = `${ this.baseUrl }${ endpoint }`;

    const headers: Record<string, string> = {
      'Content-Type':  'application/json',
      'X-N8N-API-KEY': this.apiKey,
      ...options.headers as Record<string, string>,
    };

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`N8n API error ${ response.status }: ${ response.statusText } - ${ errorText }`);
      }

      if (response.status === 204 || options.method === 'DELETE') {
        return { success: true };
      }

      return await response.json();
    } catch (error) {
      console.error(`[N8nService] Request failed for ${ endpoint }:`, error);
      throw error;
    }
  }

  // ========== WORKFLOWS ==========

  /**
   * Get workflow by ID
   */
  async getWorkflow(id: string, excludePinnedData?: boolean): Promise<any> {
    let url = `/api/v1/workflows/${ id }`;

    if (excludePinnedData !== undefined) {
      const queryParams = new URLSearchParams();
      queryParams.append('excludePinnedData', excludePinnedData.toString());
      url += '?' + queryParams.toString();
    }

    const workflowId = String(id || '').trim();
    let apiWorkflow: any = null;

    try {
      apiWorkflow = await this.request(url);
    } catch (error) {
      console.warn(`[N8nService] API getWorkflow failed for ${ workflowId }, attempting Postgres fallback:`, error instanceof Error ? error.message : String(error));
    }

    let dbWorkflow: any = null;
    try {
      dbWorkflow = await this.getWorkflowFromPostgres(workflowId);
    } catch (error) {
      console.warn(`[N8nService] Postgres fallback query failed for ${ workflowId }:`, error instanceof Error ? error.message : String(error));
    }
    const hasCompleteGraph = (candidate: any): boolean => {
      return !!candidate && Array.isArray(candidate.nodes) && candidate.nodes.length > 0 && typeof candidate.connections === 'object' && candidate.connections !== null;
    };

    let mergedWorkflow = apiWorkflow;
    if (!mergedWorkflow && dbWorkflow) {
      mergedWorkflow = dbWorkflow;
    } else if (mergedWorkflow && dbWorkflow && !hasCompleteGraph(mergedWorkflow)) {
      mergedWorkflow = {
        ...dbWorkflow,
        ...mergedWorkflow,
        nodes:       Array.isArray(mergedWorkflow.nodes) && mergedWorkflow.nodes.length > 0 ? mergedWorkflow.nodes : dbWorkflow.nodes,
        connections: mergedWorkflow.connections && Object.keys(mergedWorkflow.connections).length > 0 ? mergedWorkflow.connections : dbWorkflow.connections,
        settings:    mergedWorkflow.settings && Object.keys(mergedWorkflow.settings).length > 0 ? mergedWorkflow.settings : dbWorkflow.settings,
        staticData:  mergedWorkflow.staticData ?? dbWorkflow.staticData,
        pinData:     mergedWorkflow.pinData ?? dbWorkflow.pinData,
      };
    }

    if (!mergedWorkflow) {
      throw new Error(`Workflow ${ workflowId } not found in API or Postgres`);
    }

    if (excludePinnedData === true && Object.prototype.hasOwnProperty.call(mergedWorkflow, 'pinData')) {
      delete mergedWorkflow.pinData;
    }

    return mergedWorkflow;
  }

  /**
   * Get full workflow payload plus credentials in parallel for editing workflows.
   */
  async getWorkflowWithCredentials(id: string, excludePinnedData?: boolean): Promise<any> {
    const [workflow, credentials] = await Promise.all([
      this.getWorkflow(id, excludePinnedData),
      this.getCredentials(),
    ]);

    return {
      ...workflow,
      credentials,
    };
  }

  private async getWorkflowFromPostgres(id: string): Promise<any | null> {
    const workflowId = String(id || '').trim();
    if (!workflowId) {
      return null;
    }

    const row = await postgresClient.queryOne<any>(
      `SELECT * FROM "workflow_entity" WHERE "id" = $1 LIMIT 1`,
      [workflowId],
    );

    if (!row) {
      return null;
    }

    return row;
  }

  private sanitizeWorkflowSettings(settings: any): Record<string, any> {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return {};
    }

    const allowedSettingKeys = new Set([
      'saveExecutionProgress',
      'saveManualExecutions',
      'saveDataErrorExecution',
      'saveDataSuccessExecution',
      'executionTimeout',
      'errorWorkflow',
      'timezone',
      'executionOrder',
      'callerPolicy',
      'callerIds',
      'timeSavedPerExecution',
      'availableInMCP',
    ]);

    return Object.fromEntries(
      Object.entries(settings).filter(([key]) => allowedSettingKeys.has(key)),
    );
  }

  private sanitizeWorkflowUpdatePayload(workflowData: any): Record<string, any> {
    return {
      name:        workflowData?.name,
      nodes:       Array.isArray(workflowData?.nodes) ? workflowData.nodes : [],
      connections: workflowData?.connections && typeof workflowData.connections === 'object' && !Array.isArray(workflowData.connections)
        ? workflowData.connections
        : {},
      settings: this.sanitizeWorkflowSettings(workflowData?.settings),
      ...(workflowData?.staticData !== undefined ? { staticData: workflowData.staticData } : {}),
    };
  }

  /**
   * Update an existing workflow
   */
  async updateWorkflow(id: string, workflowData: {
    name:        string;
    active?:     boolean;
    nodes:       any[];
    connections: any;
    settings: {
      saveExecutionProgress?:    boolean;
      saveManualExecutions?:     boolean;
      saveDataErrorExecution?:   string;
      saveDataSuccessExecution?: 'none' | 'all';
      executionTimeout?:         number;
      errorWorkflow?:            string;
      timezone?:                 string;
      executionOrder?:           string;
      callerPolicy?:             string;
      callerIds?:                string;
      timeSavedPerExecution?:    number;
      availableInMCP?:           boolean;
    };
    shared?:     any[];
    staticData?: any;
  }): Promise<any> {
    const workflowId = String(id || '').trim();
    if (!workflowId) {
      throw new Error('Workflow ID is required');
    }

    const existingWorkflow = await this.getWorkflow(workflowId, true);
    const wasActive = !!existingWorkflow?.active;

    const { active: _ignoredActive, shared: _ignoredShared, ...updatableWorkflowData } = workflowData as any;
    const sanitizedPayload = this.sanitizeWorkflowUpdatePayload(updatableWorkflowData);

    if (wasActive) {
      await this.deactivateWorkflow(workflowId);
    }

    try {
      const updatedWorkflow = await this.request(`/api/v1/workflows/${ workflowId }`, {
        method: 'PUT',
        body:   JSON.stringify(sanitizedPayload),
      });

      if (wasActive) {
        await this.activateWorkflow(workflowId);
      }

      return updatedWorkflow;
    } catch (error) {
      if (wasActive) {
        try {
          await this.activateWorkflow(workflowId);
        } catch (reactivateError) {
          console.warn('[N8nService] Failed to reactivate workflow after update failure:', reactivateError);
        }
      }
      throw error;
    }
  }

  /**
   * Activate a workflow (used internally by updateWorkflow)
   */
  async activateWorkflow(id: string, options?: {
    versionId?: string;
  }): Promise<any> {
    const workflowId = String(id || '').trim();
    if (!workflowId) {
      throw new Error('Workflow ID is required for activation');
    }

    const versionId = options?.versionId ? String(options.versionId).trim() : '';
    const body = versionId ? { versionId } : undefined;

    const isNotFoundOrMethodError = (error: unknown): boolean => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes('N8n API error 404') || message.includes('N8n API error 405');
    };

    try {
      return await this.request(`/api/v1/workflows/${ workflowId }/activate`, {
        method: 'POST',
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      if (!isNotFoundOrMethodError(error)) {
        throw error;
      }

      try {
        return await this.request(`/api/v1/workflows/${ workflowId }`, {
          method: 'PATCH',
          body:   JSON.stringify({ active: true }),
        });
      } catch (patchError) {
        if (!isNotFoundOrMethodError(patchError)) {
          throw patchError;
        }

        const existingWorkflow = await this.getWorkflow(workflowId);
        return this.request(`/api/v1/workflows/${ workflowId }`, {
          method: 'PUT',
          body:   JSON.stringify({
            ...existingWorkflow,
            active: true,
          }),
        });
      }
    }
  }

  /**
   * Deactivate a workflow (used internally by updateWorkflow)
   */
  async deactivateWorkflow(id: string): Promise<any> {
    return this.request(`/api/v1/workflows/${ id }/deactivate`, {
      method: 'POST',
    });
  }

  // ========== CREDENTIALS (used by getWorkflowWithCredentials) ==========

  /**
   * Get all credentials
   */
  async getCredentials(params?: {
    limit?:  number;
    cursor?: string;
  }): Promise<any[]> {
    const credentials = await N8nCredentialsEntityModel.where({});

    let result = credentials;
    if (params?.limit) {
      result = credentials.slice(0, Math.min(params.limit, 250));
    }

    return result.map(cred => cred.attributes);
  }

  // ========== HEALTH CHECK ==========

  /**
   * Check if n8n API is accessible
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.request('/healthz', { method: 'GET' });
      return true;
    } catch (error) {
      console.error('[N8nService] Health check failed:', error);
      return false;
    }
  }
}

// Export a factory function for creating configured instance
export async function createN8nService(): Promise<N8nService> {
  const service = new N8nService();
  await service.initialize();
  return service;
}
