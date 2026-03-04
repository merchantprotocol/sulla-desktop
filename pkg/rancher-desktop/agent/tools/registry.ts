// src/tools/registry.ts

import type { ToolOperation } from './base';

type ToolLoader = () => Promise<any>;

export interface ToolEntry {
  name: string;
  description: string;
  category: string;
  loader: ToolLoader;
}

export interface ToolRegistration {
  name: string;
  description: string;
  category: string;
  schemaDef?: any;
  workerClass: new () => any;
  operationTypes?: ToolOperation[];
}

/**
 * Lightweight manifest — plain data only, no class references.
 * Used for registering tool metadata without importing heavy deps.
 */
export interface ToolManifest {
  name: string;
  description: string;
  category: string;
  schemaDef: Record<string, any>;
  operationTypes?: ToolOperation[];
  loader: () => Promise<any>;
}

export class ToolRegistry { private static registrations = new Map<string, ToolRegistration>();
  private loaders = new Map<string, ToolLoader>();
  private instances = new Map<string, any>();
  private llmSchemaCache = new Map<string, any>();
  private categories = new Map<string, string[]>();
  private descriptions = new Map<string, string>();
  private schemaDefs = new Map<string, Record<string, any>>();
  private operationTypesMap = new Map<string, ToolOperation[]>();
  private categoriesList = [
    'meta', 'bridge', 'browser', 'calendar', 'docker', 'extensions', 'fs', 'github', 'integrations', 'kubectl', 'n8n', 'playwright', 'projects', 'skills', 'slack', 'workspace', 'redis', 'pg', 'rdctl', 'lima',
    // Integration catalog categories (AP backed)
    'communication', 'developer_tools', 'productivity', 'project_management', 'crm_sales', 'marketing', 'customer_support', 'social_media', 'finance', 'file_storage', 'ecommerce', 'analytics', 'automation', 'database', 'design', 'hr_recruiting', 'ai_ml'
  ];

  private categoryDescriptions: Record<string, string> = {
    meta: "Tools for browsing available tools, installing skills, and meta management.", bridge: "Bidirectional communication bridge between the heartbeat (autonomous background agent) and the frontend (human-facing chat). Send messages, read messages, update and read human presence state.", browser: "Web search tools like Brave and DuckDuckGo.", calendar: "Tools for managing calendar events.", docker: "Tools for Docker container management.", extensions: "Tools for browsing the extension marketplace catalog, listing installed extensions, installing new extensions, and uninstalling extensions. Extensions are Docker Compose stacks managed by Sulla Desktop.", fs: "File system operations tools for creating, reading, writing, moving, copying, and deleting files/directories.", github: "GitHub repository management tools.", kubectl: "Kubernetes cluster management tools.", n8n: "Tools for managing n8n workflows, executions, credentials, tags, variables, and data tables.", slack: "Slack messaging and reaction tools.", workspace: "Tools for managing workspace folders in the Rancher Desktop data directory.", redis: "Redis key/value store operations.", pg: "PostgreSQL database queries and transactions.", rdctl: "Sulla Desktop / rdctl management commands.", integrations: "Tools for checking integration status and retrieving integration credentials.", lima: "Lima VM instance management.", playwright: "Tools for interacting with website assets — click elements, fill forms, scroll, and read page text. DOM changes, navigation, and dialog alerts are streamed automatically.", skills: "Tools for searching, loading, and creating reusable skill files that teach the agent how to perform repeatable tasks.", projects: "Tools for searching, loading, creating, updating, patching, and deleting project PRDs (PROJECT.md) and their workspace folders.",
    // Integration catalog categories (tools executed via ActivePieces)
    communication: "Email, messaging, SMS, and video conferencing tools — Gmail, Slack, Teams, Zoom, Discord, Telegram, Twilio, WhatsApp, and more.",
    developer_tools: "DevOps, CI/CD, monitoring, hosting, CMS, and web scraping tools — GitHub, GitLab, Vercel, Sentry, Datadog, Jenkins, Webflow, and more.",
    productivity: "Docs, spreadsheets, calendars, forms, notes, and time tracking — Notion, Google Sheets, Airtable, Todoist, Typeform, Clockify, and more.",
    project_management: "Issue tracking, sprints, boards, and task management — Jira, Linear, Asana, Trello, ClickUp, Monday.com, and more.",
    crm_sales: "CRM, pipeline, lead, and contact management — HubSpot, Salesforce, Pipedrive, Zoho CRM, Apollo, and more.",
    marketing: "Email marketing, campaigns, outreach, and lead generation — Mailchimp, ConvertKit, ActiveCampaign, Google Ads, and more.",
    customer_support: "Helpdesk, live chat, ticketing, and feedback — Zendesk, Freshdesk, Intercom, Crisp, Help Scout, and more.",
    social_media: "Social posting, scheduling, analytics, and engagement — X/Twitter, LinkedIn, Instagram, YouTube, TikTok, Buffer, and more.",
    finance: "Payments, invoicing, accounting, and subscriptions — Stripe, QuickBooks, Xero, PayPal, Chargebee, and more.",
    file_storage: "Cloud storage, file transfer, and object storage — Dropbox, Box, S3, Google Cloud Storage, SFTP, and more.",
    ecommerce: "Online store management, orders, products, and fulfillment — Shopify, WooCommerce, BigCommerce, Etsy, and more.",
    analytics: "Web analytics, product analytics, dashboards, and BI — Google Analytics, Mixpanel, PostHog, Metabase, Snowflake, and more.",
    automation: "Webhooks, queues, scheduling, code execution, and file conversion — HTTP, RSS, RabbitMQ, Amazon SQS, CloudConvert, and more.",
    database: "SQL, NoSQL, vector, and serverless databases — MySQL, PostgreSQL, MongoDB, Redis, Supabase, Pinecone, and more.",
    design: "Image editing, asset generation, and design collaboration — Figma, Canva, Cloudinary, Miro, Bannerbear, and more.",
    hr_recruiting: "HR, payroll, recruiting, and employee management — BambooHR, Greenhouse, Lever, Gusto, Deel, and more.",
    ai_ml: "AI models, speech, translation, and video generation — OpenAI, Anthropic, Groq, Mistral, ElevenLabs, DeepL, and more." };

  static register(registration: ToolRegistration) {
    this.registrations.set(registration.name, registration);
  }

  static getRegistrations(): Map<string, ToolRegistration> {
    return this.registrations;
  }

  register(name: string, description: string, category: string, loader: ToolLoader) {
    if (this.loaders.has(name)) return;
    this.loaders.set(name, loader);
    this.descriptions.set(name, description);
    if (!this.categories.has(category)) this.categories.set(category, []);
    this.categories.get(category)!.push(name);
  }

  registerAll(entries: ToolEntry[]) {
    entries.forEach(e => this.register(e.name, e.description, e.category, e.loader));
  }

  /**
   * Register from lightweight manifests — no workerClass import needed.
   * schemaDef is stored for LLM schema generation without instantiation.
   * loader uses dynamic import() so webpack doesn't bundle tool deps eagerly.
   */
  registerManifests(manifests: ToolManifest[]) {
    for (const m of manifests) {
      if (this.loaders.has(m.name)) continue;
      this.schemaDefs.set(m.name, m.schemaDef);
      this.operationTypesMap.set(m.name, Array.isArray(m.operationTypes) ? [...m.operationTypes] : []);
      this.register(m.name, m.description, m.category, async () => {
        const mod = await m.loader();
        const workerClass: any = mod && typeof mod === 'object'
          ? Object.values(mod).find((v: any) =>
              typeof v === 'function' &&
              v?.prototype &&
              typeof v.prototype._validatedCall === 'function')
          : null;
        if (!workerClass) {
          throw new Error(`Tool ${m.name}: loader did not export a worker class`);
        }
        const instance = new workerClass();
        instance.schemaDef = m.schemaDef;
        instance.name = m.name;
        instance.description = m.description;
        instance.metadata.category = m.category;
        instance.metadata.operationTypes = Array.isArray(m.operationTypes) ? [...m.operationTypes] : [];
        return instance;
      });
    }
    console.log(`[ToolRegistry] Registered ${manifests.length} tool manifests`);
  }

  registerAllRegistrations(registrations: ToolRegistration[]) {
    const entries = registrations.map((reg) => {
      if (reg.schemaDef) {
        this.schemaDefs.set(reg.name, reg.schemaDef);
      }
      this.operationTypesMap.set(reg.name, Array.isArray(reg.operationTypes) ? [...reg.operationTypes] : []);
      const entry = {
        name: reg.name,
        description: reg.description,
        category: reg.category,
        loader: async () => {
          const instance = new reg.workerClass();
          instance.schemaDef = reg.schemaDef || {};
          instance.name = reg.name;
          instance.description = reg.description;
          instance.metadata.category = reg.category;
          instance.metadata.operationTypes = Array.isArray(reg.operationTypes)
            ? [...reg.operationTypes]
            : [];
          return instance;
        },
      };
      return entry;
    });
    console.log(`Registering ${entries.length} entries`);
    this.registerAll(entries);
  }

  async getTool(name: string): Promise<any> {
    if (this.instances.has(name)) return this.instances.get(name)!;
    const loader = this.loaders.get(name);
    if (!loader) throw new Error(`Tool ${name} not registered`);
    const tool = await loader();
    this.instances.set(name, tool);
    return tool;
  }

  async getToolsByCategory(category: string): Promise<any[]> {
    const names = this.categories.get(category) || [];
    return Promise.all(names.map(name => this.getTool(name)));
  }

  /**
   * Build LLM tool schema from stored schemaDef — no instantiation needed.
   * Accepts a tool name (string) or an already-loaded tool instance.
   */
  async convertToolToLLM(toolOrName: string | any): Promise<any> {
    const name = typeof toolOrName === 'string' ? toolOrName : toolOrName?.name;

    if (name && this.llmSchemaCache.has(name)) {
      return this.llmSchemaCache.get(name);
    }

    // Try building from stored schemaDef first (lightweight path — no instantiation)
    if (typeof toolOrName === 'string' && this.schemaDefs.has(toolOrName)) {
      const schemaDef = this.schemaDefs.get(toolOrName)!;
      const description = this.descriptions.get(toolOrName) || '';
      const parameters = ToolRegistry.schemaDefToJsonSchema(schemaDef);
      const formatted = {
        type: 'function',
        function: { name: toolOrName, description, parameters },
      };
      this.llmSchemaCache.set(toolOrName, formatted);
      return formatted;
    }

    // Fallback: load tool instance (for tools registered via legacy path)
    let tool: any;
    if (typeof toolOrName === 'string') {
      tool = await this.getTool(toolOrName);
    } else {
      tool = toolOrName;
    }

    const parameters = tool.jsonSchema;
    const formatted = {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters,
      },
    };

    this.llmSchemaCache.set(tool.name, formatted);
    return formatted;
  }

  /**
   * Pure conversion: schemaDef → OpenAI-compatible JSON schema.
   * Mirrors BaseTool.jsonSchema getter logic exactly.
   */
  static schemaDefToJsonSchema(schemaDef: Record<string, any>): any {
    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const [key, spec] of Object.entries(schemaDef)) {
      const field: any = { description: spec.description || '' };

      switch (spec.type) {
        case 'string':  field.type = 'string'; break;
        case 'number':  field.type = 'number'; break;
        case 'boolean': field.type = 'boolean'; break;
        case 'enum':
          field.type = 'string';
          field.enum = spec.enum;
          break;
        case 'array':
          field.type = 'array';
          if (spec.items) {
            const itemField: any = { type: spec.items.type === 'enum' ? 'string' : spec.items.type };
            if (spec.items.enum) itemField.enum = spec.items.enum;
            if (spec.items.description) itemField.description = spec.items.description;
            field.items = itemField;
          }
          break;
        case 'object':
          field.type = 'object';
          if (spec.properties) {
            field.properties = Object.fromEntries(
              Object.entries(spec.properties).map(([k, v]: [string, any]) => {
                const sub: any = { type: v.type === 'enum' ? 'string' : v.type };
                if (v.enum) sub.enum = v.enum;
                if (v.description) sub.description = v.description;
                return [k, sub];
              })
            );
          }
          break;
      }

      if (spec.default !== undefined) field.default = spec.default;
      properties[key] = field;
      if (!spec.optional) required.push(key);
    }

    return { type: 'object', properties, required, additionalProperties: false };
  }

  getOperationTypes(name: string): ToolOperation[] {
    return this.operationTypesMap.get(name) || [];
  }

  getLLMToolsForCategory(category: string): () => Promise<any[]> {
    return async () => {
      const names = this.categories.get(category) || [];
      return Promise.all(names.map(name => this.convertToolToLLM(name)));
    };
  }

  getAllLLMTools(): () => Promise<any[]> {
    return async () => {
      if (this.loaders.size > 40) {
        console.warn(`Loading ${this.loaders.size} tools — prefer category filtering`);
      }
      const allNames = Array.from(this.loaders.keys());
      return Promise.all(allNames.map(name => this.convertToolToLLM(name)));
    };
  }

  getToolNames(): string[] {
    return Array.from(this.loaders.keys());
  }

  // For browse_tools — cheap metadata only, no loading instances or schemas
  getCategoryToolMetadata(category: string): () => Promise<Array<{ name: string; description: string; category: string }>> {
    return async () => {
      const names = this.categories.get(category) || [];
      return names.map(name => ({
        name,
        description: this.descriptions.get(name) || '',
        category,
      }));
    };
  }

  async getLLMToolsFor(tools: any[]): Promise<any[]> {
    return Promise.all(tools.map(tool => this.convertToolToLLM(tool)));
  }

  private expandSearchAliases(value: string): string {
    return value
      .replace(/executions?/g, 'execute')
      .replace(/workflows?/g, 'workflow');
  }

  private normalizeSearchText(value: string): string {
    return this.expandSearchAliases(value.toLowerCase()).replace(/[^a-z0-9]/g, '');
  }

  private getFuzzyScore(name: string, description: string, query: string): number {
    const rawQuery = this.expandSearchAliases(query.toLowerCase());
    const normalizedQuery = this.normalizeSearchText(rawQuery);
    if (!normalizedQuery) return 0;

    const normalizedName = this.normalizeSearchText(name);
    const normalizedDescription = this.normalizeSearchText(description);
    let score = 0;

    if (normalizedName.includes(normalizedQuery)) score += 100;
    if (normalizedDescription.includes(normalizedQuery)) score += 60;

    const tokens = rawQuery.split(/[\s_\-]+/).filter(token => token.length >= 3);
    for (const token of tokens) {
      if (name.toLowerCase().includes(token)) score += 15;
      if (description.toLowerCase().includes(token)) score += 8;
    }

    return score;
  }

  async searchTools(query?: string, category?: string): Promise<any[]> {
    let names: string[] = category
      ? (this.categories.get(category) || [])
      : Array.from(this.loaders.keys());

    if (query) {
      const q = query.toLowerCase();
      const directMatches = names.filter(name => {
        if (name.toLowerCase().includes(q)) return true;
        const desc = this.descriptions.get(name);
        return desc && desc.toLowerCase().includes(q);
      });

      if (directMatches.length > 0) {
        names = directMatches;
      } else {
        const fuzzyMatches = names
          .map(name => {
            const description = this.descriptions.get(name) || '';
            return {
              name,
              score: this.getFuzzyScore(name, description, q),
            };
          })
          .filter(item => item.score > 0)
          .sort((a, b) => b.score - a.score)
          .map(item => item.name);

        names = fuzzyMatches;
      }
    }

    const results = await Promise.allSettled(names.map(name => this.getTool(name)));
    return results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map(r => r.value);
  }

  getCategories(): string[] {
    return this.categoriesList;
  }

  getCategoriesWithDescriptions(): { category: string; description: string }[] {
    return this.categoriesList.map(cat => ({
      category: cat,
      description: this.categoryDescriptions[cat] || 'No description available.',
    }));
  }

  clearCache() {
    this.instances.clear();
    this.llmSchemaCache.clear();
  }
}

export const toolRegistry = new ToolRegistry();