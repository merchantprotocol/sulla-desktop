import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * GitHub Set Project Field (Projects V2) Tool — #500 step 5.
 *
 * Sets one field on one board card — most often the Status single-select, i.e.
 * moving a card between columns (Todo → In Progress → Done). Projects V2 is
 * GraphQL-only (updateProjectV2ItemFieldValue). Every id comes from the earlier
 * steps: projectId + fieldId (+ option ids) from github_list_projects, itemId
 * from github_add_issue_to_project. Supply exactly one of option_id (single-
 * select), text, or number depending on the field's dataType.
 */
export class GitHubSetProjectFieldWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { project_id: projectId, item_id: itemId, field_id: fieldId } = input;
    if (!projectId || !itemId || !fieldId) {
      return { successBoolean: false, responseString: 'Error: project_id, item_id, and field_id are all required (from github_list_projects + github_add_issue_to_project).' };
    }

    // Build the ProjectV2FieldValue union — exactly one variant.
    let value: Record<string, any> | undefined;
    let described = '';
    if (typeof input.option_id === 'string' && input.option_id) {
      value = { singleSelectOptionId: input.option_id };
      described = `single-select optionId ${ input.option_id }`;
    } else if (typeof input.number === 'number') {
      value = { number: input.number };
      described = `number ${ input.number }`;
    } else if (typeof input.text === 'string') {
      value = { text: input.text };
      described = `text "${ input.text }"`;
    } else if (typeof input.date === 'string' && input.date) {
      value = { date: input.date };
      described = `date ${ input.date }`;
    }
    if (!value) {
      return { successBoolean: false, responseString: 'Error: provide exactly one of option_id (single-select), text, number, or date.' };
    }

    const integrationService = getIntegrationService();
    const tokenValue = await integrationService.getIntegrationValue('github', 'token');
    if (!tokenValue) {
      return { successBoolean: false, responseString: 'Error: GitHub token not configured.' };
    }

    const octokit = new Octokit({ auth: tokenValue.value });

    try {
      const res: any = await octokit.graphql(
        `mutation($project: ID!, $item: ID!, $field: ID!, $value: ProjectV2FieldValue!) {
          updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: $value }) {
            projectV2Item { id }
          }
        }`,
        { project: projectId, item: itemId, field: fieldId, value },
      );

      const returnedId = res?.updateProjectV2ItemFieldValue?.projectV2Item?.id;
      if (!returnedId) {
        return { successBoolean: false, responseString: 'Error: mutation returned no item id.' };
      }
      return { successBoolean: true, responseString: `Set field ${ fieldId } to ${ described } on item ${ returnedId }.` };
    } catch (error) {
      return { successBoolean: false, responseString: `Error setting project field: ${ (error as Error).message }` };
    }
  }
}
