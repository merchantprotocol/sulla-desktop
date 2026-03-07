// Types for YAML-defined integration configs in ~/sulla/integrations

/** Top-level auth config (e.g. youtube.v3-auth.yaml) */
export interface IntegrationAuthConfig {
  api: {
    name: string;
    version: string;
    provider?: string;
    base_url: string;
  };
  auth: {
    type: 'oauth2' | 'apiKey' | 'bearer';
    flow?: string;
    client_id?: string;
    client_secret?: string;
    redirect_uris?: string[];
    authorization_url?: string;
    token_url?: string;
    pkce?: boolean;
    code_challenge_method?: string;
    access_type?: string;
    prompt?: string;
    scopes?: string[];
    authorization_params?: Record<string, string>;
    token_storage?: string;
    refresh_automatically?: boolean;
    token_expiry_buffer_seconds?: number;
    /** Header name for apiKey auth type (e.g. "X-API-Key") */
    header?: string;
  };
  api_key_fallback?: {
    enabled: boolean;
    param_name: string;
    value: string;
  };
}

/** Endpoint config (e.g. search.v3.yaml, videos.v3.yaml) */
export interface EndpointConfig {
  endpoint: {
    name: string;
    description: string;
    path: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    auth: 'required' | 'optional' | 'none';
    quota_cost?: number;
  };
  query_params?: Record<string, QueryParamDef>;
  path_params?: Record<string, PathParamDef>;
  pagination?: PaginationConfig;
  response?: ResponseConfig;
  examples?: Record<string, { params: Record<string, any> }>;
}

export interface QueryParamDef {
  type: string;
  required?: boolean;
  default?: any;
  description?: string;
  enum?: string[];
  min?: number;
  max?: number;
}

export interface PathParamDef {
  type: string;
  required?: boolean;
  description?: string;
}

export interface PaginationConfig {
  type: 'nextPageToken' | 'offsetLimit' | 'linkHeader';
  next_token_path?: string;
  items_path?: string;
  prev_token_path?: string;
  offset_key?: string;
  limit_key?: string;
}

export interface ResponseConfig {
  items_path?: string;
  transform?: Array<Record<string, string>>;
  notes?: string;
}

/** A fully loaded integration (auth + endpoints) */
export interface LoadedIntegration {
  name: string;
  dir: string;
  auth: IntegrationAuthConfig;
  endpoints: Map<string, EndpointConfig>;
}
