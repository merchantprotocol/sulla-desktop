import { BaseTool, ToolResponse } from "../base";
import { Article } from "../../database/models/Article";

/**
 * Helper to safely extract error message from any error type
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object') {
    // Handle Neo4j errors and other complex error objects
    if ('message' in error) {
      const msg = (error as any).message;
      return typeof msg === 'string' ? msg : JSON.stringify(msg);
    }
    // Last resort: stringify the whole object
    try {
      return JSON.stringify(error);
    } catch {
      return 'Unknown error (could not serialize)';
    }
  }
  return 'Unknown error';
}

/**
 * Article Create Tool - Worker class for execution
 */
export class ArticleCreateWorker extends BaseTool {
  name: string = '';
  description: string = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const {
      slug,
      title,
      content,
      section,
      category,
      tags = "",
      order = "100",
      locked = false,
      author = "Jonathon Byrdziak",
      related_slugs = "",
      mentions = "",
      related_entities = "",
    } = input;

    try {
      const existing = await Article.find(slug);
      if (existing) {
        return {
          successBoolean: false,
          responseString: `Article with slug "${slug}" already exists.`
        };
      }

      const article = await Article.create({
        slug,
        title,
        document: content,
        section,
        category,
        tags,
        order,
        locked,
        author,
        related_slugs,
        mentions,
        related_entities,
      });

      const responseString = `Article created successfully:
Slug: ${slug}
Title: ${title}
Section: ${section || 'N/A'}
Category: ${category || 'N/A'}
Author: ${author}
Tags: ${tags || 'None'}
Locked: ${locked ? 'Yes' : 'No'}
Order: ${order}`;

      return {
        successBoolean: true,
        responseString
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      return {
        successBoolean: false,
        responseString: `Error creating article: ${errorMessage}`
      };
    }
  }
}
