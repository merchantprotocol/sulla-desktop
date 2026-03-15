// Barrel: re-exports types + registry, auto-registers all providers.

// Auto-register concrete providers on import
import './providers/GoogleOAuth';
import './providers/OpenAIOAuth';

export { OAuthProvider, type OAuthProviderConfig, type OAuthTokenSet } from './OAuthProvider';
export { registerOAuthProvider, getOAuthProvider, getAllOAuthProviders } from './registry';
