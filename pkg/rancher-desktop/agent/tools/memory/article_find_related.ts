import { BaseTool, ToolResponse } from "../base";
import { ArticlesRegistry } from "../../database/registry/ArticlesRegistry";

/**
 * Article Find Related Tool - Worker class for execution
 */
export class ArticleFindRelatedWorker extends BaseTool {
  name: string = '';
  description: string = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { slug, relType = "MENTIONS", limit = 10 } = input;
    const limitInt = Math.floor(limit);

    try {
      const registry = ArticlesRegistry.getInstance();
      const related = await registry.getRelated(slug, relType, limit);

      if (related.length === 0) {
        return {
          successBoolean: false,
          responseString: `No related articles found for "${slug}" with relationship "${relType}".`
        };
      }

      // Format detailed list of related articles
      let responseString = `Related articles for "${slug}" (${relType}, limit: ${limit}):\n\n`;
      related.forEach((article: any, index: number) => {
        responseString += `${index + 1}. Slug: ${article.slug}\n`;
        responseString += `   Title: ${article.title}\n`;
        responseString += `   Section: ${article.section || 'N/A'}\n`;
        responseString += `   Category: ${article.category || 'N/A'}\n`;
        responseString += `   Tags: ${article.tags || 'None'}\n`;
        responseString += `   Similarity/Relevance: ${article.similarity || article.relevance || 'N/A'}\n\n`;
      });

      return {
        successBoolean: true,
        responseString
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error finding related articles: ${(error as Error).message}`
      };
    }
  }
}
