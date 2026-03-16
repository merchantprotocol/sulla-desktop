/**
 * InstallationManifest matches the schema of a remote installation.yaml file
 * from the sulla-recipes repository.
 *
 * The system is intentionally dumb:
 *  - `setup` is a list of shell commands run in order during install.
 *  - `commands` are shell commands for start/stop/restart/status/update/logs.
 *  - `${APP_DIR}` is replaced with the extension directory path.
 *  - `${COMPOSE_FILE}` is replaced with the full path to the compose file.
 *  - The recipe author is responsible for putting the right commands in setup
 *    (e.g. git clone, generate config, etc.)
 *
 * Variable substitution (`{{...}}`) is supported in all text files pulled from
 * the recipe (docker-compose, SQL migrations, config files, etc.) and the `env` field:
 *  - `{{propertyName}}`              → resolved from SullaSettingsModel (e.g. `{{sullaEmail}}`)
 *  - `{{INTEGRATION.PROP}}`         → resolved from IntegrationService (e.g. `{{SLACK.BOT_KEY}}`)
 *  - `{{propertyName|modifier}}`    → value piped through a modifier before substitution
 *
 * Built-in path variables (auto-resolved from the user's system):
 *  - `{{path.home}}`       — user home directory
 *  - `{{path.documents}}`  — ~/Documents
 *  - `{{path.downloads}}`  — ~/Downloads
 *  - `{{path.desktop}}`    — ~/Desktop
 *  - `{{path.movies}}`     — ~/Movies
 *  - `{{path.music}}`      — ~/Music
 *  - `{{path.pictures}}`   — ~/Pictures
 *  - `{{path.data}}`       — extension's persistent data/ directory
 *  - `{{path.appdir}}`     — extension directory (same as ${APP_DIR})
 *
 * Supported modifiers:
 *  - `urlencode`  — percent-encode (use in connection strings: `{{sullaServicePassword|urlencode}}`)
 *  - `base64`     — base64-encode
 *  - `quote`      — shell single-quote with escaping
 *  - `json`       — JSON-stringify
 *  - `md5`        — MD5 hex digest (always 32 chars, e.g. `{{sullaN8nEncryptionKey|md5}}`)
 *  - `argon2`     — Argon2id password hash (e.g. `{{sullaServicePassword|argon2}}`)
 *  - `bcrypt`     — bcrypt password hash (e.g. `{{sullaServicePassword|bcrypt}}`)
 *
 * The `integrations` field saves credentials to the IntegrationService after install.
 * Each key is the integration_id, and each value maps property names to template values.
 * Template variables (`{{...}}`) in values are resolved before saving.
 * Example:
 *   integrations:
 *     n8n:
 *       N8N_API_KEY: "{{sullaN8nApiKey}}"
 *       BASE_URL: "http://localhost:30119"
 *
 * The `env` field is written as a `.env` file in the extension directory.
 * Docker Compose automatically reads it. The `.env` is refreshed on every start.
 */
export interface InstallationManifest {
  id:          string;
  name:        string;
  description: string;
  icon:        string;
  version:     string;
  category:    string;

  compose?: {
    composeFile?: string;
    envFile?:     string;
  };

  setup?: SetupStep[];

  commands?: {
    start?:   string;
    stop?:    string;
    restart?: string;
    status?:  string;
    update?:  string;
    logs?:    string;
  };

  defaultPort?:   number;
  adminPath?:     string;
  webmailPath?:   string;
  openInBrowser?: boolean;

  extraUrls?: ExtraUrl[];

  env?: Record<string, string>;

  /**
   * Credentials to save to the IntegrationService after install.
   * Keys are integration IDs, values map property names to template values.
   * Template variables are resolved before saving.
   */
  integrations?: Record<string, Record<string, string>>;
}

/**
 * A setup step is simply a shell command to run during installation.
 * The system runs each command in order via /bin/sh.
 * `${APP_DIR}` is substituted with the extension directory.
 */
export interface SetupStep {
  command:   string;
  cwd?:      string;
  /**
   * If true (default), a failure in this step will not block installation.
   * The error is logged and the next step proceeds.
   */
  optional?: boolean;
}

export interface ExtraUrl {
  label: string;
  url:   string;
}
