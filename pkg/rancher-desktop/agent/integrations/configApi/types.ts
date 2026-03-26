// Types for YAML-defined integration configs in ~/sulla/integrations

/** Transport type — REST (default) uses fetch, MCP uses MCPBridge */
export type IntegrationTransport = 'rest' | 'mcp';

/** Top-level auth config (e.g. youtube.v3-auth.yaml) */
export interface IntegrationAuthConfig {
  api: {
    name:       string;
    version:    string;
    provider?:  string;
    base_url:   string;
    /** Transport layer. Defaults to 'rest'. MCP-generated configs set this to 'mcp'. */
    transport?: IntegrationTransport;
  };
  /** MCP-specific metadata (only present for transport: mcp) */
  mcp?: {
    /** The MCP account ID this config was generated from */
    account_id: string;
    /** ISO timestamp when tools were last synced from the MCP server */
    synced_at:  string;
  };
  auth: {
    type:                         'oauth2' | 'apiKey' | 'bearer';
    flow?:                        string;
    client_id?:                   string;
    client_secret?:               string;
    redirect_uris?:               string[];
    authorization_url?:           string;
    token_url?:                   string;
    pkce?:                        boolean;
    code_challenge_method?:       string;
    access_type?:                 string;
    prompt?:                      string;
    scopes?:                      string[];
    authorization_params?:        Record<string, string>;
    token_storage?:               string;
    refresh_automatically?:       boolean;
    token_expiry_buffer_seconds?: number;
    /** Header name for apiKey auth type (e.g. "X-API-Key") */
    header?:                      string;
  };
  api_key_fallback?: {
    enabled:    boolean;
    param_name: string;
    value:      string;
  };
}

/** Endpoint config (e.g. search.v3.yaml, videos.v3.yaml) */
export interface EndpointConfig {
  endpoint: {
    name:        string;
    description: string;
    path:        string;
    method:      'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    auth:        'required' | 'optional' | 'none';
    quota_cost?: number;
    /** Transport override for this endpoint. If set to 'mcp', calls are routed via MCPBridge. */
    transport?:  IntegrationTransport;
  };
  query_params?: Record<string, QueryParamDef>;
  path_params?:  Record<string, PathParamDef>;
  body_params?:  Record<string, QueryParamDef>;
  pagination?:   PaginationConfig;
  response?:     ResponseConfig;
  examples?:     Record<string, { params: Record<string, any>; body?: Record<string, any> }>;
}

export interface QueryParamDef {
  type:         string;
  required?:    boolean;
  default?:     any;
  description?: string;
  enum?:        string[];
  min?:         number;
  max?:         number;
}

export interface PathParamDef {
  type:         string;
  required?:    boolean;
  description?: string;
}

export interface PaginationConfig {
  type:             'nextPageToken' | 'offsetLimit' | 'linkHeader';
  next_token_path?: string;
  items_path?:      string;
  prev_token_path?: string;
  offset_key?:      string;
  limit_key?:       string;
}

export interface ResponseConfig {
  items_path?: string;
  transform?:  Record<string, string>[];
  notes?:      string;
}

/** A fully loaded integration (auth + endpoints) */
export interface LoadedIntegration {
  name:      string;
  dir:       string;
  auth:      IntegrationAuthConfig;
  endpoints: Map<string, EndpointConfig>;
}
