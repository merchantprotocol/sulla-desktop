export interface Integration {
  id:                 string;
  name:               string;
  description:        string;
  category:           string;
  icon?:              string;
  paid:               boolean;
  sort:               number;
  beta:               boolean;
  comingSoon:         boolean;
  connected:          boolean;
  version:            string;
  lastUpdated:        string;
  developer:          string;
  /** How the user authenticates: 'credentials' (default) shows a form, 'oauth' starts an OAuth flow */
  authType?:          'credentials' | 'oauth';
  /** When true, the integration also supports OAuth sign-in (shown alongside standard properties) */
  oauth?:             boolean;
  /** The registered OAuthProvider id that defines endpoints and scopes (used by authType 'oauth' or oauth: true) */
  oauthProviderId?:   string;
  /**
   * When true, the OAuth flow is run through sulla-workers using Sulla's
   * shared app credentials. The user doesn't supply client_id/client_secret —
   * the detail view calls a dedicated IPC handler instead of the generic
   * OAuthService. Used for Sign-in-with-Apple and any future consumer-style
   * identity integrations that share Sulla's registered OAuth app.
   */
  sullaManagedOAuth?: boolean;
  formGuide?:         string;
  installationGuide?: {
    title:       string;
    description: string;
    steps: {
      title:   string;
      content: string;
    }[];
    importantNotes?: string[];
  };
  media?: {
    type:     'youtube' | 'image';
    url:      string;
    alt:      string;
    caption?: string;
  }[];
  features?: {
    title:       string;
    description: string;
  }[];
  guideLinks?: {
    title:       string;
    description: string;
    url:         string;
  }[];
  properties?: {
    key:              string;
    title:            string;
    hint:             string;
    type:             'text' | 'password' | 'url' | 'select';
    required:         boolean;
    placeholder:      string;
    /** For type 'select': the ID of the SelectBoxProvider that resolves options */
    selectBoxId?:     string;
    /** For type 'select': keys of sibling properties whose current values are sent to the provider */
    selectDependsOn?: string[];
    validation?: {
      pattern?:   string;
      minLength?: number;
      maxLength?: number;
    };
  }[];
}
