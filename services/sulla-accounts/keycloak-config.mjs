import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function audienceScope(name, audience) {
  return {
    name,
    protocol: 'openid-connect',
    attributes: {
      'display.on.consent.screen': 'false',
      'include.in.token.scope': 'true',
      'sulla.reconciliation.version': '1',
    },
    protocolMappers: [{
      name: `audience-${audience}`,
      protocol: 'openid-connect',
      protocolMapper: 'oidc-audience-mapper',
      consentRequired: false,
      config: { 'included.custom.audience': audience, 'access.token.claim': 'true', 'id.token.claim': 'false' },
    }],
  };
}

function audiences(input) {
  const values = input.split(',').map(value => value.trim()).filter(Boolean);
  if (!values.length || new Set(values).size !== values.length) throw new Error('resource audiences must be unique and non-empty');
  for (const audience of values) {
    if (!/^[A-Za-z0-9._-]+$/.test(audience)) throw new Error(`invalid audience ${audience}`);
  }
  return values;
}

export function exactKeycloakId(rows, field, expected) {
  if (!Array.isArray(rows)) throw new Error('Keycloak lookup did not return an array');
  const matches = rows.filter(row => row?.[field] === expected);
  if (matches.length > 1) throw new Error(`Keycloak lookup returned duplicate ${field} values`);
  if (!matches.length) return '';
  if (typeof matches[0].id !== 'string' || !matches[0].id) throw new Error('Keycloak lookup returned an invalid id');
  return matches[0].id;
}

export function staleKeycloakIds(rows, field, expected) {
  if (!Array.isArray(rows)) throw new Error('Keycloak lookup did not return an array');
  return rows.filter(row => row?.[field] !== expected).map(row => {
    if (typeof row?.id !== 'string' || !row.id) throw new Error('Keycloak lookup returned an invalid id');
    return row.id;
  });
}

export function buildKeycloakConfig(environment) {
  const membershipAudience = environment.membershipAudience;
  if (!/^[A-Za-z0-9._-]+$/.test(membershipAudience)) throw new Error(`invalid audience ${membershipAudience}`);
  const resourceAudiences = audiences(environment.resourceAudiences);
  if (resourceAudiences.includes(membershipAudience)) throw new Error('membership audience must not also be a resource audience');

  const membershipScope = audienceScope(`sulla-audience-${membershipAudience}`, membershipAudience);
  const resourceScopes = resourceAudiences.map(audience => audienceScope(`sulla-audience-${audience}`, audience));
  const defaultClientScopes = ['profile', membershipScope.name];
  const optionalClientScopes = resourceScopes.map(scope => scope.name);
  const clientAttributes = { 'sulla.reconciliation.version': '1' };

  return {
    realm: { realm: environment.realm, enabled: true, registrationAllowed: false, resetPasswordAllowed: true },
    membershipScope,
    resourceScopes,
    nativeClient: {
      clientId: environment.nativeClientId,
      name: 'Sulla Desktop',
      protocol: 'openid-connect',
      publicClient: true,
      standardFlowEnabled: true,
      directAccessGrantsEnabled: false,
      redirectUris: [environment.nativeRedirectUri],
      webOrigins: [],
      attributes: { ...clientAttributes, 'pkce.code.challenge.method': 'S256' },
      defaultClientScopes,
      optionalClientScopes,
    },
    webClient: {
      clientId: environment.webClientId,
      name: 'Sulla Accounts Web',
      protocol: 'openid-connect',
      publicClient: false,
      secret: environment.webClientSecret,
      standardFlowEnabled: true,
      directAccessGrantsEnabled: false,
      redirectUris: environment.webRedirectUris.split(',').map(value => value.trim()).filter(Boolean),
      webOrigins: [environment.publicUrl],
      attributes: clientAttributes,
      defaultClientScopes,
      optionalClientScopes,
    },
  };
}

function writeConfiguration([realmFile, nativeClientFile, webClientFile]) {
  if (!realmFile || !nativeClientFile || !webClientFile) throw new Error('realm and client output paths are required');
  const config = buildKeycloakConfig({
    realm: process.env.realm,
    nativeClientId: process.env.native_client_id,
    nativeRedirectUri: process.env.native_redirect_uri,
    webClientId: process.env.web_client_id,
    webClientSecret: process.env.web_client_secret,
    webRedirectUris: process.env.SULLA_ACCOUNTS_KEYCLOAK_WEB_REDIRECT_URIS,
    publicUrl: process.env.SULLA_ACCOUNTS_PUBLIC_URL,
    membershipAudience: process.env.membership_audience,
    resourceAudiences: process.env.resource_audiences,
  });
  writeFileSync(realmFile, JSON.stringify(config.realm), { mode: 0o600 });
  writeFileSync(nativeClientFile, JSON.stringify(config.nativeClient), { mode: 0o600 });
  writeFileSync(webClientFile, JSON.stringify(config.webClient), { mode: 0o600 });
  writeFileSync('/run/sulla-accounts-private/scope-membership.json', JSON.stringify(config.membershipScope), { mode: 0o600 });
  writeFileSync('/run/sulla-accounts-private/mapper-membership.json', JSON.stringify(config.membershipScope.protocolMappers[0]), { mode: 0o600 });
  for (const scope of config.resourceScopes) {
    const audience = scope.protocolMappers[0].config['included.custom.audience'];
    writeFileSync(`/run/sulla-accounts-private/scope-resource-${audience}.json`, JSON.stringify(scope), { mode: 0o600 });
    writeFileSync(`/run/sulla-accounts-private/mapper-resource-${audience}.json`, JSON.stringify(scope.protocolMappers[0]), { mode: 0o600 });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeConfiguration(process.argv.slice(2));
