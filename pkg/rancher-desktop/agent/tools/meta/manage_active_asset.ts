import { BaseTool, ToolResponse } from '../base';
import { getAgentPersonaRegistry } from '../../database/registry/AgentPersonaRegistry';

export class ManageActiveAssetWorker extends BaseTool {
  name: string = '';
  description: string = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    if (!this.state) {
      return {
        successBoolean: false,
        responseString: 'Missing graph state; cannot manage active assets.',
      };
    }

    const action = String(input.action || 'upsert').trim().toLowerCase();
    const assetType = String(input.assetType || '').trim().toLowerCase();
    const skillSlug = typeof input.skillSlug === 'string' ? input.skillSlug.trim() : '';
    const metadata = (this.state as any).metadata || {};
    const agentId = String(metadata.wsChannel || 'sulla-desktop');

    const registry = getAgentPersonaRegistry();
    const persona = registry.getOrCreatePersonaService(agentId);

    if (action === 'remove') {
      const removeId = typeof input.assetId === 'string' ? input.assetId.trim() : '';
      if (!removeId) {
        return {
          successBoolean: false,
          responseString: 'assetId is required when action is remove.',
        };
      }
      persona.removeAsset(removeId);
      return {
        successBoolean: true,
        responseString: `Removed active asset ${removeId}`,
      };
    }

    if (assetType !== 'iframe' && assetType !== 'document') {
      return {
        successBoolean: false,
        responseString: 'assetType must be either iframe or document.',
      };
    }

    const candidateId = typeof input.assetId === 'string' && input.assetId.trim().length > 0
      ? input.assetId.trim()
      : `${assetType}_${Date.now()}`;

    const active = input.active !== false;
    const collapsed = input.collapsed !== false;
    const refKey = typeof input.refKey === 'string' ? input.refKey : undefined;
    const normalizedSkillSlug = skillSlug.toLowerCase();
    const effectiveId = normalizedSkillSlug.includes('workflow') ? 'sulla_n8n' : candidateId;

    if (assetType === 'iframe') {
      const url = typeof input.url === 'string' ? input.url.trim() : '';
      if (!url) {
        return {
          successBoolean: false,
          responseString: 'url is required for iframe assets.',
        };
      }

      const title = typeof input.title === 'string' && input.title.trim().length > 0
        ? input.title.trim()
        : (skillSlug.toLowerCase().includes('workflow') ? 'Sulla n8n' : 'Website');

      persona.registerIframeAsset({
        id: effectiveId,
        title,
        url,
        skillSlug: skillSlug || undefined,
        active,
        collapsed,
        refKey,
      });

      return {
        successBoolean: true,
        responseString: `Upserted iframe active asset id=${effectiveId} url=${url}`,
      };
    }

    const content = typeof input.content === 'string' ? input.content : '';
    const title = typeof input.title === 'string' && input.title.trim().length > 0
      ? input.title.trim()
      : 'Document';

    persona.registerDocumentAsset({
      id: effectiveId,
      title,
      content,
      active,
      collapsed,
      refKey,
    });

    return {
      successBoolean: true,
      responseString: `Upserted document active asset id=${effectiveId} contentLength=${content.length}`,
    };
  }
}

