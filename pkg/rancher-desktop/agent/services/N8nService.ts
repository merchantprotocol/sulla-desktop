// N8nService - Service for interacting with n8n API
// Provides methods to manage workflows, executions, credentials, and other n8n resources

import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { N8nCredentialsEntityModel } from '../database/models/N8nCredentialsEntityModel';
import { N8nUserModel } from '../database/models/N8nUserModel';
import { N8nUserApiKeyModel } from '../database/models/N8nUserApiKeyModel';
import { postgresClient } from '../database/PostgresClient';

/**
 * N8n API Service
 * Handles all interactions with the n8n REST API
 */
export class N8nService {
  private baseUrl: string;
  private apiKey:  string;
  private userId:  string;

  constructor() {
    // Initialize with empty defaults - call initialize() to set values
    this.baseUrl = '';
    this.apiKey = '';
    this.userId = '';
  }

  /**
   * Initialize the service with configuration values
   */
  async initialize(): Promise<void> {
    // Get or create the service account API key
    const { N8nUserApiKeyModel } = await import('../database/models/N8nUserApiKeyModel');

    // get the fresh api key
    const n8nUserId = await SullaSettingsModel.get('serviceAccountUserId');
    const serviceAccount = await N8nUserApiKeyModel.getOrCreateServiceAccount(n8nUserId);
    if (!serviceAccount.attributes.id || !serviceAccount.attributes.apiKey) {
      throw new Error('[N8NService] Failed to get service account ID or API key');
    }
    this.apiKey = serviceAccount.attributes.apiKey;
    this.userId = n8nUserId;

    console.log(`API key ${ this.apiKey ? 'generated/retrieved' : 'failed' } with ID ${ serviceAccount.attributes.id }, length: ${ this.apiKey?.length || 0 }`);

    this.baseUrl = 'http://127.0.0.1:30119';
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

    console.log(`[N8nService] Requesting: ${ url }`);
    console.log(`[N8nService] Headers:`, { ...headers, 'X-N8N-API-KEY': this.apiKey ? `exists (${ this.apiKey.length } chars)` : 'missing' });

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`N8n API error ${ response.status }: ${ response.statusText } - ${ errorText }`);
      }

      // For DELETE requests, may not have body
      if (response.status === 204 || options.method === 'DELETE') {
        return { success: true };
      }

      return await response.json();
    } catch (error) {
      console.error(`[N8nService] Request failed for ${ endpoint }:`, error);
      throw error;
    }
  }

  private isArchiveSchemaMismatchError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return message.includes('n8n api error 400') &&
      message.includes('must not have additional properties');
  }

  // ========== WORKFLOWS ==========

  /**
   * Get all workflows
   */
  async getWorkflows(params?: {
    active?:            boolean;
    tags?:              string;
    name?:              string;
    projectId?:         string;
    excludePinnedData?: boolean;
    limit?:             number;
    cursor?:            string;
  }): Promise<any[]> {
    let url = '/api/v1/workflows';

    if (params) {
      const queryParams = new URLSearchParams();

      if (params.active !== undefined) {
        queryParams.append('active', params.active.toString());
      }

      if (params.tags) {
        queryParams.append('tags', params.tags);
      }

      if (params.name) {
        queryParams.append('name', params.name);
      }

      if (params.projectId) {
        queryParams.append('projectId', params.projectId);
      }

      if (params.excludePinnedData !== undefined) {
        queryParams.append('excludePinnedData', params.excludePinnedData.toString());
      }

      if (params.limit !== undefined) {
        queryParams.append('limit', Math.min(params.limit, 250).toString());
      }

      if (params.cursor) {
        queryParams.append('cursor', params.cursor);
      }

      const queryString = queryParams.toString();
      if (queryString) {
        url += '?' + queryString;
      }
    }

    const result = await this.request(url);
    return result.data || result;
  }

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

  /**
   * Get specific version of a workflow
   */
  async getWorkflowVersion(id: string, versionId: string): Promise<any> {
    return this.request(`/api/v1/workflows/${ id }/${ versionId }`);
  }

  /**
   * Get workflow tags
   */
  async getWorkflowTags(id: string): Promise<any[]> {
    const result = await this.request(`/api/v1/workflows/${ id }/tags`);
    return result.data || result;
  }

  /**
   * Update workflow tags
   */
  async updateWorkflowTags(id: string, tags: { id: string }[]): Promise<any> {
    return this.request(`/api/v1/workflows/${ id }/tags`, {
      method: 'PUT',
      body:   JSON.stringify(tags),
    });
  }

  /**
   * Create a new workflow
   */
  async createWorkflow(workflowData: {
    name:        string;
    nodes:       any[];
    connections: any;
    settings?: {
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
    const sanitizedSettings = this.sanitizeWorkflowSettings(workflowData?.settings);
    if (sanitizedSettings.availableInMCP === undefined) {
      sanitizedSettings.availableInMCP = true;
    }

    const sanitizedPayload = {
      name:        String(workflowData?.name || '').trim(),
      nodes:       Array.isArray(workflowData?.nodes) ? workflowData.nodes : [],
      connections: workflowData?.connections && typeof workflowData.connections === 'object' && !Array.isArray(workflowData.connections)
        ? workflowData.connections
        : {},
      settings: sanitizedSettings,
      ...(Array.isArray(workflowData?.shared) ? { shared: workflowData.shared } : {}),
      ...(workflowData?.staticData !== undefined ? { staticData: workflowData.staticData } : {}),
    };

    return this.request('/api/v1/workflows', {
      method: 'POST',
      body:   JSON.stringify(sanitizedPayload),
    });
  }

  /**
   * Update an existing workflow
   */
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

    // n8n treats "active" as read-only on PUT /workflows/:id.
    // Activation state is handled via activate/deactivate endpoints.
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
   * Delete a workflow
   */
  async deleteWorkflow(id: string): Promise<any> {
    return this.request(`/api/v1/workflows/${ id }`, {
      method: 'DELETE',
    });
  }

  /**
   * Activate a workflow
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
        // Compatibility fallback for n8n variants that allow direct active state patch.
        return await this.request(`/api/v1/workflows/${ workflowId }`, {
          method: 'PATCH',
          body:   JSON.stringify({ active: true }),
        });
      } catch (patchError) {
        if (!isNotFoundOrMethodError(patchError)) {
          throw patchError;
        }

        // Final fallback for n8n variants that require full workflow updates via PUT.
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
   * Deactivate a workflow
   */
  async deactivateWorkflow(id: string): Promise<any> {
    return this.request(`/api/v1/workflows/${ id }/deactivate`, {
      method: 'POST',
    });
  }

  /**
   * Set workflow archived state
   */
  async setWorkflowArchived(id: string, archived: boolean): Promise<any> {
    const workflowId = String(id || '').trim();
    if (!workflowId) {
      throw new Error('Workflow ID is required for archive state change');
    }

    const archiveState = archived === true;

    const isNotFoundOrMethodError = (error: unknown): boolean => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes('N8n API error 404') || message.includes('N8n API error 405');
    };

    if (archiveState) {
      try {
        return await this.request(`/api/v1/workflows/${ workflowId }/archive`, {
          method: 'POST',
        });
      } catch (error) {
        if (!isNotFoundOrMethodError(error)) {
          throw error;
        }
      }
    } else {
      try {
        return await this.request(`/api/v1/workflows/${ workflowId }/unarchive`, {
          method: 'POST',
        });
      } catch (error) {
        if (!isNotFoundOrMethodError(error)) {
          throw error;
        }
      }
    }

    try {
      // Preferred path for unarchive and fallback for archive on API variants.
      return await this.request(`/api/v1/workflows/${ workflowId }`, {
        method: 'PATCH',
        body:   JSON.stringify({ archived: archiveState }),
      });
    } catch (patchError) {
      if (!isNotFoundOrMethodError(patchError) && !this.isArchiveSchemaMismatchError(patchError)) {
        throw patchError;
      }

      // Final fallback for n8n variants that require full workflow updates via PUT.
      const existingWorkflow = await this.getWorkflow(workflowId);
      const sanitizedExistingWorkflow = this.sanitizeWorkflowUpdatePayload(existingWorkflow);
      return this.request(`/api/v1/workflows/${ workflowId }`, {
        method: 'PUT',
        body:   JSON.stringify({
          ...sanitizedExistingWorkflow,
          archived: archiveState,
        }),
      });
    }
  }

  /**
   * Archive a workflow
   */
  async archiveWorkflow(id: string): Promise<any> {
    return this.setWorkflowArchived(id, true);
  }

  /**
   * Unarchive a workflow
   */
  async unarchiveWorkflow(id: string): Promise<any> {
    return this.setWorkflowArchived(id, false);
  }

  // ========== EXECUTIONS ==========

  /**
   * Get all executions
   */
  async getExecutions(params?: {
    includeData?: boolean;
    status?:      'canceled' | 'error' | 'running' | 'success' | 'waiting';
    workflowId?:  string;
    projectId?:   string;
    limit?:       number;
    cursor?:      string;
  }): Promise<any[]> {
    let url = '/api/v1/executions';

    if (params) {
      const queryParams = new URLSearchParams();

      if (params.includeData !== undefined) {
        queryParams.append('includeData', params.includeData.toString());
      }

      if (params.status) {
        queryParams.append('status', params.status);
      }

      if (params.workflowId) {
        queryParams.append('workflowId', params.workflowId);
      }

      if (params.projectId) {
        queryParams.append('projectId', params.projectId);
      }

      if (params.limit !== undefined) {
        queryParams.append('limit', Math.min(params.limit, 250).toString());
      }

      if (params.cursor) {
        queryParams.append('cursor', params.cursor);
      }

      const queryString = queryParams.toString();
      if (queryString) {
        url += '?' + queryString;
      }
    }

    const result = await this.request(url);
    return result.data || result;
  }

  /**
   * Get execution by ID
   */
  async getExecution(id: string): Promise<any> {
    return this.request(`/api/v1/executions/${ id }`);
  }

  /**
   * Create a new execution (run workflow)
   */
  async createExecution(executionData: any): Promise<any> {
    return this.request('/api/v1/executions', {
      method: 'POST',
      body:   JSON.stringify(executionData),
    });
  }

  /**
   * Delete an execution
   */
  async deleteExecution(id: string): Promise<any> {
    return this.request(`/api/v1/executions/${ id }`, {
      method: 'DELETE',
    });
  }

  /**
   * Retry an execution
   */
  async retryExecution(id: string, loadWorkflow?: boolean): Promise<any> {
    const retryData = {
      loadWorkflow: loadWorkflow ?? true,
    };

    return this.request(`/api/v1/executions/${ id }/retry`, {
      method: 'POST',
      body:   JSON.stringify(retryData),
    });
  }

  // ========== CREDENTIALS ==========

  /**
   * Get all credentials
   */
  async getCredentials(params?: {
    limit?:  number;
    cursor?: string;
  }): Promise<any[]> {
    // Use direct database query instead of API
    const credentials = await N8nCredentialsEntityModel.where({});

    // Apply basic limit if specified
    let result = credentials;
    if (params?.limit) {
      result = credentials.slice(0, Math.min(params.limit, 250));
    }

    // Return in API-compatible format
    return result.map(cred => cred.attributes);
  }

  /**
   * Get credential by ID
   */
  async getCredential(id: string): Promise<any> {
    const credential = await N8nCredentialsEntityModel.find(id);
    return credential ? credential.attributes : null;
  }

  /**
   * Create a new credential
   */
  async createCredential(credentialData: {
    name:          string;
    type:          string;
    data:          any;
    isResolvable?: boolean;
  }): Promise<any> {
    const dataObj = typeof credentialData.data === 'string'
      ? JSON.parse(credentialData.data)
      : credentialData.data;

    const credential = new N8nCredentialsEntityModel();
    credential.fill({
      name:                    credentialData.name,
      type:                    credentialData.type,
      isResolvable:            credentialData.isResolvable ?? false,
      isManaged:               false,
      isGlobal:                false,
      resolvableAllowFallback: false,
    });
    await credential.encryptData(dataObj);
    await credential.save();
    return credential.attributes;
  }

  /**
   * Update a credential
   */
  async updateCredential(id: string, credentialData: {
    name?:          string;
    type?:          string;
    data?:          any;
    isGlobal?:      boolean;
    isResolvable?:  boolean;
    isPartialData?: boolean;
  }): Promise<any> {
    const credential = await N8nCredentialsEntityModel.find(id);
    if (!credential) {
      throw new Error(`Credential with id ${ id } not found`);
    }

    // Update attributes with provided data
    if (credentialData.name !== undefined) {
      credential.attributes.name = credentialData.name;
    }
    if (credentialData.type !== undefined) {
      credential.attributes.type = credentialData.type;
    }
    if (credentialData.data !== undefined) {
      const dataObj = typeof credentialData.data === 'string'
        ? JSON.parse(credentialData.data)
        : credentialData.data;
      await credential.encryptData(dataObj);
    }
    if (credentialData.isGlobal !== undefined) {
      credential.attributes.isGlobal = credentialData.isGlobal;
    }
    if (credentialData.isResolvable !== undefined) {
      credential.attributes.isResolvable = credentialData.isResolvable;
    }

    await credential.save();
    return credential.attributes;
  }

  /**
   * Delete a credential
   */
  async deleteCredential(id: string): Promise<any> {
    const credential = await N8nCredentialsEntityModel.find(id);
    if (!credential) {
      throw new Error(`Credential with id ${ id } not found`);
    }
    await credential.delete();
    return { success: true };
  }

  /**
   * Get credential schema by type
   */
  async getCredentialSchema(credentialTypeName: string): Promise<any> {
    return this.request(`/api/v1/credentials/schema/${ credentialTypeName }`);
  }

  // ========== TAGS ==========

  /**
   * Get all tags
   */
  async getTags(): Promise<any[]> {
    const result = await this.request('/api/v1/tags');
    return result.data || result;
  }

  /**
   * Get tag by ID
   */
  async getTag(id: string): Promise<any> {
    return this.request(`/api/v1/tags/${ id }`);
  }

  /**
   * Create a new tag
   */
  async createTag(tagData: {
    name: string;
  }): Promise<any> {
    return this.request('/api/v1/tags', {
      method: 'POST',
      body:   JSON.stringify(tagData),
    });
  }

  /**
   * Delete a tag
   */
  async deleteTag(id: string): Promise<any> {
    return this.request(`/api/v1/tags/${ id }`, {
      method: 'DELETE',
    });
  }

  /**
   * Update a tag
   */
  async updateTag(id: string, tagData: {
    name: string;
  }): Promise<any> {
    return this.request(`/api/v1/tags/${ id }`, {
      method: 'PUT',
      body:   JSON.stringify(tagData),
    });
  }

  // ========== USERS (if available) ==========

  /**
   * Get current user info
   */
  async getCurrentUser(): Promise<any> {
    const user = await N8nUserModel.load(this.userId);
    return user ? user.attributes : null;
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

  // ========== SOURCE CONTROL ==========

  /**
   * Pull changes from remote repository
   */
  async pullFromSourceControl(options?: {
    force?:       boolean;
    autoPublish?: 'none' | 'all' | 'published';
    variables?:   Record<string, any>;
  }): Promise<any> {
    const pullData = {
      force:       options?.force || false,
      autoPublish: options?.autoPublish || 'none',
      variables:   options?.variables || {},
    };

    return this.request('/api/v1/source-control/pull', {
      method: 'POST',
      body:   JSON.stringify(pullData),
    });
  }

  // ========== VARIABLES ==========

  /**
   * Get all variables
   */
  async getVariables(params?: {
    limit?:     number;
    cursor?:    string;
    projectId?: string;
    state?:     'empty';
  }): Promise<any[]> {
    let url = '/api/v1/variables';

    if (params) {
      const queryParams = new URLSearchParams();

      if (params.limit !== undefined) {
        queryParams.append('limit', Math.min(params.limit, 250).toString());
      }

      if (params.cursor) {
        queryParams.append('cursor', params.cursor);
      }

      if (params.projectId) {
        queryParams.append('projectId', params.projectId);
      }

      if (params.state) {
        queryParams.append('state', params.state);
      }

      const queryString = queryParams.toString();
      if (queryString) {
        url += '?' + queryString;
      }
    }

    const result = await this.request(url);
    return result.data || result;
  }

  /**
   * Create a variable
   */
  async createVariable(variableData: {
    key:        string;
    value:      string;
    projectId?: string | null;
  }): Promise<any> {
    return this.request('/api/v1/variables', {
      method: 'POST',
      body:   JSON.stringify(variableData),
    });
  }

  /**
   * Delete a variable
   */
  async deleteVariable(id: string): Promise<any> {
    return this.request(`/api/v1/variables/${ id }`, {
      method: 'DELETE',
    });
  }

  /**
   * Update a variable
   */
  async updateVariable(id: string, variableData: {
    key:        string;
    value:      string;
    projectId?: string | null;
  }): Promise<any> {
    return this.request(`/api/v1/variables/${ id }`, {
      method: 'PUT',
      body:   JSON.stringify(variableData),
    });
  }

  // ========== DATA TABLES ==========

  /**
   * Get all data tables
   */
  async getDataTables(params?: {
    limit?:  number;
    cursor?: string;
    filter?: any;
    sortBy?: string;
  }): Promise<any[]> {
    let url = '/api/v1/data-tables';

    if (params) {
      const queryParams = new URLSearchParams();

      if (params.limit !== undefined) {
        queryParams.append('limit', Math.min(params.limit, 250).toString());
      }

      if (params.cursor) {
        queryParams.append('cursor', params.cursor);
      }

      if (params.filter) {
        queryParams.append('filter', JSON.stringify(params.filter));
      }

      if (params.sortBy) {
        queryParams.append('sortBy', params.sortBy);
      }

      const queryString = queryParams.toString();
      if (queryString) {
        url += '?' + queryString;
      }
    }

    const result = await this.request(url);
    return result.data || result;
  }

  /**
   * Create a new data table
   */
  async createDataTable(tableData: {
    name:    string;
    columns: {
      name: string;
      type: string;
    }[];
  }): Promise<any> {
    return this.request('/api/v1/data-tables', {
      method: 'POST',
      body:   JSON.stringify(tableData),
    });
  }

  /**
   * Get a specific data table by ID
   */
  async getDataTable(dataTableId: string): Promise<any> {
    return this.request(`/api/v1/data-tables/${ dataTableId }`);
  }

  /**
   * Update a data table
   */
  async updateDataTable(dataTableId: string, tableData: {
    name: string;
  }): Promise<any> {
    return this.request(`/api/v1/data-tables/${ dataTableId }`, {
      method: 'PATCH',
      body:   JSON.stringify(tableData),
    });
  }

  /**
   * Delete a data table
   */
  async deleteDataTable(dataTableId: string): Promise<any> {
    return this.request(`/api/v1/data-tables/${ dataTableId }`, {
      method: 'DELETE',
    });
  }

  /**
   * Get rows from a data table
   */
  async getDataTableRows(dataTableId: string, params?: {
    limit?:  number;
    cursor?: string;
    filter?: any;
    sortBy?: string;
    search?: string;
  }): Promise<any[]> {
    let url = `/api/v1/data-tables/${ dataTableId }/rows`;

    if (params) {
      const queryParams = new URLSearchParams();

      if (params.limit !== undefined) {
        queryParams.append('limit', Math.min(params.limit, 250).toString());
      }

      if (params.cursor) {
        queryParams.append('cursor', params.cursor);
      }

      if (params.filter) {
        queryParams.append('filter', JSON.stringify(params.filter));
      }

      if (params.sortBy) {
        queryParams.append('sortBy', params.sortBy);
      }

      if (params.search) {
        queryParams.append('search', params.search);
      }

      const queryString = queryParams.toString();
      if (queryString) {
        url += '?' + queryString;
      }
    }

    const result = await this.request(url);
    return result.data || result;
  }

  /**
   * Create rows in a data table
   */
  async createDataTableRows(dataTableId: string, rowData: {
    data:        any[];
    returnType?: 'count' | 'id' | 'all';
  }): Promise<any> {
    return this.request(`/api/v1/data-tables/${ dataTableId }/rows`, {
      method: 'POST',
      body:   JSON.stringify(rowData),
    });
  }

  /**
   * Update rows in a data table
   */
  async updateDataTableRows(dataTableId: string, updateData: {
    filter:      any;
    data:        any;
    returnData?: boolean;
    dryRun?:     boolean;
  }): Promise<any> {
    return this.request(`/api/v1/data-tables/${ dataTableId }/rows/update`, {
      method: 'PATCH',
      body:   JSON.stringify(updateData),
    });
  }

  /**
   * Upsert a row in a data table
   */
  async upsertDataTableRow(dataTableId: string, upsertData: {
    filter:      any;
    data:        any;
    returnData?: boolean;
    dryRun?:     boolean;
  }): Promise<any> {
    return this.request(`/api/v1/data-tables/${ dataTableId }/rows/upsert`, {
      method: 'POST',
      body:   JSON.stringify(upsertData),
    });
  }

  /**
   * Delete rows from a data table
   */
  async deleteDataTableRows(dataTableId: string, deleteOptions: {
    filter:      any;
    returnData?: boolean;
    dryRun?:     boolean;
  }): Promise<any> {
    const queryParams = new URLSearchParams();
    queryParams.append('filter', JSON.stringify(deleteOptions.filter));

    if (deleteOptions.returnData !== undefined) {
      queryParams.append('returnData', deleteOptions.returnData.toString());
    }

    if (deleteOptions.dryRun !== undefined) {
      queryParams.append('dryRun', deleteOptions.dryRun.toString());
    }

    const url = `/api/v1/data-tables/${ dataTableId }/rows?${ queryParams.toString() }`;

    return this.request(url, {
      method: 'DELETE',
    });
  }

  /**
   * Refresh the API key by deleting the current one and creating a new one
   */
  async refreshApiKey(): Promise<string> {
    // Get the service account user ID
    const userId = await SullaSettingsModel.get('serviceAccountUserId');
    if (!userId) {
      throw new Error('No service account user ID found');
    }

    // Get current API key
    const currentApiKey = await SullaSettingsModel.get('serviceAccountApiKey');

    // Delete existing API key records
    if (currentApiKey) {
      const apiKeyModels = await N8nUserApiKeyModel.where('apiKey', currentApiKey);
      for (const model of apiKeyModels) {
        await model.delete();
      }
    }

    // Clear the API key setting
    await SullaSettingsModel.set('serviceAccountApiKey', '', 'string');

    // Create new API key
    const newApiKeyModel = await N8nUserApiKeyModel.getOrCreateServiceAccount(userId);
    const newApiKey = newApiKeyModel.attributes.apiKey;
    if (!newApiKey) {
      throw new Error('Failed to create new API key');
    }

    // Store the new API key in settings
    await SullaSettingsModel.set('serviceAccountApiKey', newApiKey, 'string');

    // Update this service instance's API key
    this.apiKey = newApiKey;

    console.log('[N8nService] API key refreshed successfully');
    return newApiKey;
  }

  // ========== PUBLIC TEMPLATE API (api.n8n.io) ==========

  private static readonly PUBLIC_API_BASE = 'https://api.n8n.io';

  /**
   * Make a request to the public n8n template API (no auth required)
   */
  private async publicRequest(endpoint: string): Promise<any> {
    const url = `${ N8nService.PUBLIC_API_BASE }${ endpoint }`;

    console.log(`[N8nService] Public API request: ${ url }`);

    try {
      const response = await fetch(url, {
        method:  'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`N8n public API error ${ response.status }: ${ response.statusText } - ${ errorText }`);
      }

      return await response.json();
    } catch (error) {
      console.error(`[N8nService] Public API request failed for ${ endpoint }:`, error);
      throw error;
    }
  }

  /**
   * Search n8n workflow templates
   */
  async searchTemplates(params?: {
    search?:   string;
    category?: string;
    nodes?:    string;
    page?:     number;
    limit?:    number;
  }): Promise<any> {
    let url = '/templates/search';

    if (params) {
      const queryParams = new URLSearchParams();

      if (params.search) {
        queryParams.append('search', params.search);
      }

      if (params.category) {
        queryParams.append('category', params.category);
      }

      if (params.nodes) {
        queryParams.append('nodes', params.nodes);
      }

      if (params.page !== undefined) {
        queryParams.append('page', params.page.toString());
      }

      if (params.limit !== undefined) {
        queryParams.append('limit', params.limit.toString());
      }

      const queryString = queryParams.toString();
      if (queryString) {
        url += '?' + queryString;
      }
    }

    return this.publicRequest(url);
  }

  /**
   * Get a single n8n template workflow by ID
   */
  async getTemplateWorkflow(id: number): Promise<any> {
    const templateId = Number(id);
    if (!Number.isFinite(templateId) || templateId <= 0) {
      throw new Error(`Invalid template workflow ID: ${ id }`);
    }

    const unwrapTemplatePayload = (payload: any): any | null => {
      const candidates = [
        payload?.workflow,
        payload?.template,
        payload?.data?.workflow,
        payload?.data?.template,
        payload?.data,
        payload?.item,
        Array.isArray(payload?.items) ? payload.items[0] : null,
        payload,
      ];

      for (const candidate of candidates) {
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) && Object.keys(candidate).length > 0) {
          return candidate;
        }
      }

      return null;
    };

    const endpoints = [
      `/templates/workflows/${ templateId }`,
      `/templates/${ templateId }`,
    ];

    let lastError: Error | null = null;
    for (const endpoint of endpoints) {
      try {
        const payload = await this.publicRequest(endpoint);
        const template = unwrapTemplatePayload(payload);
        if (template) {
          return template;
        }

        console.warn(`[N8nService] Empty template workflow payload from ${ endpoint }`);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(`[N8nService] Failed to fetch template workflow via ${ endpoint }: ${ lastError.message }`);
      }
    }

    if (lastError) {
      throw new Error(`Unable to fetch template workflow ${ templateId }: ${ lastError.message }`);
    }

    throw new Error(`Template workflow ${ templateId } returned empty payload from all public endpoints.`);
  }

  /**
   * Browse n8n template collections
   */
  async getTemplateCollections(params?: {
    page?:  number;
    limit?: number;
  }): Promise<any> {
    let url = '/templates/collections';

    if (params) {
      const queryParams = new URLSearchParams();

      if (params.page !== undefined) {
        queryParams.append('page', params.page.toString());
      }

      if (params.limit !== undefined) {
        queryParams.append('limit', params.limit.toString());
      }

      const queryString = queryParams.toString();
      if (queryString) {
        url += '?' + queryString;
      }
    }

    return this.publicRequest(url);
  }

  /**
   * List n8n template categories
   */
  async getTemplateCategories(): Promise<any> {
    return this.publicRequest('/templates/categories');
  }

  /**
   * Create an audit
   */
  async createAudit(options: {
    daysAbandonedWorkflow?: number;
    categories?:            string[];
  }): Promise<any> {
    const auditData = {
      additionalOptions: {
        daysAbandonedWorkflow: options.daysAbandonedWorkflow || 1,
        categories:            options.categories || ['credentials'],
      },
    };

    return this.request('/api/v1/audit', {
      method: 'POST',
      body:   JSON.stringify(auditData),
    });
  }
}

// Export a factory function for creating configured instance
export async function createN8nService(): Promise<N8nService> {
  const service = new N8nService();
  await service.initialize();
  return service;
}
