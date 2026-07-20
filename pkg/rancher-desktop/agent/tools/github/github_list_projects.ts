import { Octokit } from '@octokit/rest';

import { getIntegrationService } from '../../services/IntegrationService';
import { BaseTool, ToolResponse } from '../base';

/**
 * GitHub List Projects (Projects V2) Tool — the orientation step for the
 * Heartbeat triage routine (#500 step 5).
 *
 * Projects V2 is GraphQL-only; the REST API never exposed the new boards. Before
 * anything can be added to a board or moved between columns you need the board's
 * node id (PVT_…) and, for a Status column, the single-select field id plus the
 * option ids of each column. This tool returns all of that in one shot: every
 * open board for the owner, each board's fields, and — for single-select fields
 * like Status — the option id/name pairs. The PAT is injected from the vault by
 * IntegrationService; the AI never sees it.
 */
export class GitHubListProjectsWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { owner } = input;
    const first = typeof input.limit === 'number' && input.limit > 0 ? Math.min(input.limit, 50) : 20;
    if (!owner) {
      return { successBoolean: false, responseString: 'Error: owner is required.' };
    }
    const ownerType: 'organization' | 'user' | 'auto' = input.owner_type || 'auto';

    const integrationService = getIntegrationService();
    const tokenValue = await integrationService.getIntegrationValue('github', 'token');
    if (!tokenValue) {
      return { successBoolean: false, responseString: 'Error: GitHub token not configured.' };
    }

    const octokit = new Octokit({ auth: tokenValue.value });

    const boardsQuery = (root: 'organization' | 'user') => `
      query($login: String!, $first: Int!) {
        ${ root }(login: $login) {
          projectsV2(first: $first) {
            nodes {
              id number title url closed
              fields(first: 50) {
                nodes {
                  ... on ProjectV2FieldCommon { id name dataType }
                  ... on ProjectV2SingleSelectField { id name options { id name } }
                }
              }
            }
          }
        }
      }`;

    const fetchFor = async (root: 'organization' | 'user'): Promise<any[] | null> => {
      try {
        const res: any = await octokit.graphql(boardsQuery(root), { login: owner, first });
        return res?.[root]?.projectsV2?.nodes ?? null;
      } catch {
        // A user login queried as organization (or vice-versa) throws NOT_FOUND — signal "try the other".
        return null;
      }
    };

    try {
      let nodes: any[] | null = null;
      if (ownerType === 'organization' || ownerType === 'auto') {
        nodes = await fetchFor('organization');
      }
      if (nodes === null && (ownerType === 'user' || ownerType === 'auto')) {
        nodes = await fetchFor('user');
      }

      if (nodes === null) {
        return { successBoolean: false, responseString: `Error: could not resolve Projects V2 boards for '${ owner }' (checked ${ ownerType === 'auto' ? 'organization then user' : ownerType }). Confirm the login and that the PAT has the 'read:project' scope.` };
      }

      const open = nodes.filter((n: any) => n && !n.closed);
      if (open.length === 0) {
        return { successBoolean: false, responseString: `No open Projects V2 boards found for '${ owner }'.` };
      }

      let responseString = `Projects V2 boards for '${ owner }' (${ open.length } open):\n\n`;
      open.forEach((p: any) => {
        responseString += `#${ p.number } "${ p.title }"\n`;
        responseString += `   projectId: ${ p.id }\n`;
        responseString += `   url: ${ p.url }\n`;
        const fields = (p.fields?.nodes ?? []).filter(Boolean);
        if (fields.length) {
          responseString += `   fields:\n`;
          fields.forEach((f: any) => {
            responseString += `     - ${ f.name } (${ f.dataType }) fieldId: ${ f.id }\n`;
            if (Array.isArray(f.options) && f.options.length) {
              f.options.forEach((o: any) => {
                responseString += `         · ${ o.name } → optionId: ${ o.id }\n`;
              });
            }
          });
        }
        responseString += `\n`;
      });

      return { successBoolean: true, responseString };
    } catch (error) {
      return { successBoolean: false, responseString: `Error listing projects: ${ (error as Error).message }` };
    }
  }
}
