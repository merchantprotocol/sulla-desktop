import { SystemPromptSectionModel } from '../../database/models/SystemPromptSectionModel';
import { BaseTool, ToolResponse } from '../base';

/**
 * Update Identity Section Tool
 *
 * Writes the consolidated identity profile for a domain into its system-prompt
 * section (e.g. the `user` section, injected into every system prompt). This is
 * the DB-only writer the nightly "dreaming" consolidation routines use to
 * persist their synthesized profile — no filesystem access.
 *
 * SystemPromptSectionModel.update flips is_customized = true on any content
 * write, so the boot seeder never clobbers the consolidated profile with the
 * (empty) baked default.
 */
export class UpdateIdentitySectionWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    const content = typeof input.content === 'string' ? input.content : '';

    if (!id) {
      return { successBoolean: false, responseString: 'update_identity_section: "id" is required (e.g. "user").' };
    }
    if (!content.trim()) {
      return { successBoolean: false, responseString: 'update_identity_section: "content" must be a non-empty string.' };
    }

    try {
      const existing = await SystemPromptSectionModel.getById(id);
      if (!existing) {
        return {
          successBoolean: false,
          responseString: `No system-prompt section "${ id }". Consolidated identity writes must target an existing section (e.g. "user").`,
        };
      }

      const updated = await SystemPromptSectionModel.update(id, { content });
      if (!updated) {
        return { successBoolean: false, responseString: `Failed to update the "${ id }" section.` };
      }

      return {
        successBoolean: true,
        responseString: `Updated the "${ id }" identity section (${ content.length } chars). It will be injected into the system prompt on the next build.`,
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to update identity section: ${ err?.message }` };
    }
  }
}
